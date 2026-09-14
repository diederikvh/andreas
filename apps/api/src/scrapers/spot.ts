import { and, eq, gt, inArray } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import {
  parseSpotLinks,
  parseSpotPage,
  venueVoorAdres,
  VENUE_IDS,
  type SpotEvent,
} from './_spot-page.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';
import { loadVenueTitleMap, resolveEventId } from './_title-dedup.js';

/**
 * SPOT Groningen — zeven plekken onder één programma: De Oosterpoort,
 * de Stadsschouwburg, De Machinefabriek, het A-Theater, de Lutherse
 * Kerk, de Nieuwe Kerk en de USVA. Elk pand is bij ons een eigen venue;
 * de scraper leest het programma één keer en verdeelt de events op basis
 * van het adres in de JSON-LD.
 *
 * `/programma/` is één server-rendered pagina met ruim zeshonderd
 * permalinks, geen paginatie. De tegels noemen het pand niet, dus de
 * detailpagina is altijd nodig — daar staat ook de zaal, de prijs en de
 * volledige tekst. Zie _spot-page.ts.
 *
 * Tijdzone: hun `startDate` draagt een echte offset, dus `new Date()`
 * klopt hier.
 *
 * Idempotency:
 *  - eventId      = `evt-spot-{slug}`, gegroepeerd op titel
 *  - occurrenceId = `occ-spot-{slug}`
 */

const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const PROGRAMMA_URL = 'https://www.spotgroningen.nl/programma/';
const DETAIL_SPACING_MS = 150;
const MAX_FOUTEN_OP_RIJ = 8;


async function fetchPagina(url: string): Promise<string | null> {
  for (let poging = 1; poging <= 3; poging++) {
    try {
      const r = await fetch(url, {
        headers: { 'user-agent': UA, 'accept-language': 'nl-NL,nl' },
        signal: AbortSignal.timeout(25000),
      });
      if (r.ok) return await r.text();
    } catch {
      // volgende poging
    }
    if (poging < 3) await new Promise((res) => setTimeout(res, 400 * poging));
  }
  return null;
}

async function mirrorImage(sourceUrl: string, slug: string): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength < 1024 || buf.byteLength > 8 * 1024 * 1024) return null;
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    return await uploadToBunny(`media/events/spot-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[spot] mirror image ${slug}: ${(e as Error).message}`);
    return null;
  }
}

export type SpotResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  occurrencesPruned: number;
  skipped: number;
  skipReasons: Record<string, number>;
  errors: string[];
};

export async function scrapeSpot(options?: {
  venueIds?: string[];
}): Promise<SpotResult[]> {
  const venueIds = [...VENUE_IDS];
  const doelen = options?.venueIds
    ? venueIds.filter((id) => options.venueIds!.includes(id))
    : venueIds;
  if (!doelen.length) return [];

  const venues = await db
    .select()
    .from(schema.venues)
    .where(inArray(schema.venues.id, venueIds));
  const venueById = new Map(venues.map((v) => [v.id, v]));

  const resultaten = new Map<string, SpotResult>();
  const voor = (venueId: string): SpotResult => {
    let r = resultaten.get(venueId);
    if (!r) {
      r = {
        venueId, fetched: 0, inserted: 0, occurrencesUpserted: 0,
        occurrencesPruned: 0, skipped: 0, skipReasons: {}, errors: [],
      };
      resultaten.set(venueId, r);
    }
    return r;
  };
  for (const id of doelen) voor(id);

  const programma = await fetchPagina(PROGRAMMA_URL);
  if (!programma) {
    voor(doelen[0]!).errors.push('/programma/ niet op te halen');
    return [...resultaten.values()];
  }
  const links = parseSpotLinks(programma);
  if (!links.length) {
    voor(doelen[0]!).errors.push('geen event-links op /programma/');
    return [...resultaten.values()];
  }

  const titleMaps = new Map<string, Awaited<ReturnType<typeof loadVenueTitleMap>>>();
  for (const id of doelen) titleMaps.set(id, await loadVenueTitleMap(id, 'evt-spot-'));

  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  const seenOcc = new Map<string, { venueId: string; ids: Set<string> }>();
  let foutenOpRij = 0;
  let onbekendPand = 0;

  for (const url of links) {
    const html = await fetchPagina(url);
    await new Promise((res) => setTimeout(res, DETAIL_SPACING_MS));
    if (!html) {
      voor(doelen[0]!).skipped++;
      if (++foutenOpRij >= MAX_FOUTEN_OP_RIJ) {
        voor(doelen[0]!).errors.push(
          `gestopt na ${MAX_FOUTEN_OP_RIJ} mislukte fetches op rij`
        );
        break;
      }
      continue;
    }
    foutenOpRij = 0;

    let ev: SpotEvent | null = null;
    try {
      ev = parseSpotPage(html, url);
    } catch {
      ev = null;
    }
    if (!ev) continue;

    const venueId = venueVoorAdres(ev.adres);
    // Externe locaties en festivalterreinen hebben bij ons geen venue;
    // die tellen we los zodat we zien of het de moeite wordt.
    if (!venueId || !doelen.includes(venueId)) { onbekendPand++; continue; }
    const venue = venueById.get(venueId);
    if (!venue) { onbekendPand++; continue; }

    const result = voor(venueId);
    result.fetched++;
    const skip = (reden: string) => {
      result.skipped++;
      result.skipReasons[reden] = (result.skipReasons[reden] ?? 0) + 1;
    };

    try {
      if (ev.startsAt.getTime() < cutoff) { skip('al voorbij'); continue; }

      const titleMap = titleMaps.get(venueId)!;
      const { eventId } = resolveEventId(titleMap, ev.title, `evt-spot-${ev.slug}`, {
        startsAt: ev.startsAt,
        description: ev.description,
      });
      const occurrenceId = `occ-spot-${ev.slug}`;

      const [bestaand] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      if (!bestaand) {
        let imageUrl: string | null = null;
        if (ev.imageUrl) imageUrl = (await mirrorImage(ev.imageUrl, ev.slug)) ?? ev.imageUrl;
        const venueCategory = venue.categories?.[0] ?? 'Muziek';

        let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;
        try {
          enriched = await enrichEvent({
            title: ev.title,
            description: ev.description,
            venueName: venue.name,
            venueCategory,
          });
        } catch (e) {
          result.errors.push(`enrich ${ev.title}: ${(e as Error).message}`);
        }

        try {
          await db.insert(schema.events).values({
            id: eventId,
            venueId,
            title: ev.title,
            description: enriched?.cleanedDescription ?? ev.description,
            kind: refineKindByDuration(enriched?.kind ?? 'show', ev.startsAt, ev.endsAt),
            imageUrl,
            category: enriched?.category ?? venueCategory,
            featured: false,
            genres: enriched?.genres ?? [],
            published: true,
          });
          result.inserted++;
        } catch (e) {
          result.errors.push(`insert event ${eventId}: ${(e as Error).message}`);
          continue;
        }
      }

      const status = ev.soldOut ? 'sold_out' : 'scheduled';
      try {
        await db
          .insert(schema.occurrences)
          .values({
            id: occurrenceId,
            eventId,
            startsAt: ev.startsAt,
            endsAt: ev.endsAt,
            priceCents: ev.priceCents,
            priceNote: null,
            ticketUrl: ev.ticketUrl ?? ev.url,
            room: ev.zaal,
            lineup: null,
            status,
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: {
              eventId,
              startsAt: ev.startsAt,
              endsAt: ev.endsAt,
              priceCents: ev.priceCents,
              ticketUrl: ev.ticketUrl ?? ev.url,
              room: ev.zaal,
              status,
            },
          });
        result.occurrencesUpserted++;
        const bestaandeSet = seenOcc.get(eventId) ?? { venueId, ids: new Set<string>() };
        bestaandeSet.ids.add(occurrenceId);
        seenOcc.set(eventId, bestaandeSet);
      } catch (e) {
        result.errors.push(`occurrence ${occurrenceId}: ${(e as Error).message}`);
        skip('occurrence-write faalde');
      }
    } catch (e) {
      result.errors.push(`event ${ev.slug}: ${(e as Error).message}`);
      skip('exception op event');
    }
  }

  if (onbekendPand) {
    voor(doelen[0]!).skipReasons['pand zonder venue'] = onbekendPand;
  }

  const pruneCutoff = new Date(cutoff);
  for (const [eventId, { venueId, ids }] of seenOcc) {
    const result = voor(venueId);
    try {
      const bestaand = await db
        .select({ id: schema.occurrences.id })
        .from(schema.occurrences)
        .where(and(eq(schema.occurrences.eventId, eventId), gt(schema.occurrences.startsAt, pruneCutoff)));
      const drop = bestaand.map((r) => r.id).filter((id) => !ids.has(id));
      if (!drop.length) continue;
      const saved = await db
        .select({ occurrenceId: schema.saves.occurrenceId })
        .from(schema.saves)
        .where(inArray(schema.saves.occurrenceId, drop));
      const savedIds = new Set(saved.map((r) => r.occurrenceId));
      const finalDrop = drop.filter((id) => !savedIds.has(id));
      if (!finalDrop.length) continue;
      await db.delete(schema.occurrences).where(inArray(schema.occurrences.id, finalDrop));
      result.occurrencesPruned += finalDrop.length;
    } catch (e) {
      result.errors.push(`prune ${eventId}: ${(e as Error).message}`);
    }
  }

  return [...resultaten.values()];
}
