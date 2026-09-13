import { and, eq, gt, inArray } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { parse013Page, parseProgrammaLinks, type Event013 } from './_013-page.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';
import { loadVenueTitleMap, resolveEventId } from './_title-dedup.js';

/**
 * 013, Tilburg.
 *
 * `/programma` is één server-rendered pagina met het hele komende
 * programma — geen paginatie, `?page=N` geeft steeds dezelfde 162
 * tegels. Daar halen we alleen de permalinks uit; alle inhoud staat in
 * de JSON-LD `MusicEvent` op de detailpagina: datum mét offset, zaal,
 * eindtijd, beeld, omschrijving, ticketlink en beschikbaarheid.
 *
 * We halen elke detailpagina op, ook van events die we al kennen: dat
 * houdt datum, zaal, prijs en uitverkocht-status bij. Bij 162 events en
 * 150 ms ertussen kost dat ruim een minuut. Alleen de Claude-enrichment
 * is voorbehouden aan nieuwe events — dat is de dure stap, niet de
 * fetch.
 *
 * Tijdzone: hun startDate draagt een expliciete offset (`+01:00`), dus
 * `new Date()` klopt hier. Geen parseAmsterdamLocal nodig.
 *
 * Categorie komt van de enrichment, niet van `@type`: 013 zet álles als
 * `MusicEvent` weg, ook de comedy-avonden.
 *
 * Idempotency:
 *  - eventId      = `evt-013-{identifier}`, via resolveEventId gegroepeerd
 *                   op titel — een meerdaagse run krijgt per avond een
 *                   eigen identifier.
 *  - occurrenceId = `occ-013-{identifier}`
 */

const VENUE_ID = '013';
const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const PROGRAMMA_URL = 'https://www.013.nl/programma';
/** Hun Craft-backend is niet snel; even ademruimte tussen fetches. */
const DETAIL_SPACING_MS = 150;
/** Noodstop: gaat de bron onderuit, dan is doorbeuken zinloos. */
const MAX_FOUTEN_OP_RIJ = 8;

async function fetchPagina(url: string): Promise<string | null> {
  for (let poging = 1; poging <= 3; poging++) {
    try {
      const r = await fetch(url, {
        headers: { 'user-agent': UA, 'accept-language': 'nl-NL,nl' },
        signal: AbortSignal.timeout(20000),
      });
      if (r.ok) return await r.text();
    } catch {
      // volgende poging
    }
    if (poging < 3) await new Promise((res) => setTimeout(res, 400 * poging));
  }
  return null;
}

async function mirrorImage(sourceUrl: string, id: string): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength < 1024 || buf.byteLength > 8 * 1024 * 1024) return null;
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    return await uploadToBunny(`media/events/013-${id}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[013] mirror image ${id}: ${(e as Error).message}`);
    return null;
  }
}

export type Scraper013Result = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  occurrencesPruned: number;
  skipped: number;
  skipReasons: Record<string, number>;
  errors: string[];
};

export async function scrape013(options?: {
  venueIds?: string[];
}): Promise<Scraper013Result[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: Scraper013Result = {
    venueId: VENUE_ID, fetched: 0, inserted: 0, occurrencesUpserted: 0,
    occurrencesPruned: 0, skipped: 0, skipReasons: {}, errors: [],
  };
  const skip = (reden: string) => {
    result.skipped++;
    result.skipReasons[reden] = (result.skipReasons[reden] ?? 0) + 1;
  };

  const [venue] = await db.select().from(schema.venues).where(eq(schema.venues.id, VENUE_ID));
  if (!venue) {
    result.errors.push('venue niet in DB');
    return [result];
  }
  const venueCategory = venue.categories?.[0] ?? 'Muziek';

  const programma = await fetchPagina(PROGRAMMA_URL);
  if (!programma) {
    result.errors.push('/programma niet op te halen');
    return [result];
  }
  const links = parseProgrammaLinks(programma);
  if (!links.length) {
    result.errors.push('geen event-links op /programma');
    return [result];
  }

  const events: Event013[] = [];
  let foutenOpRij = 0;
  for (const url of links) {
    const html = await fetchPagina(url);
    await new Promise((res) => setTimeout(res, DETAIL_SPACING_MS));
    if (!html) {
      skip('detailpagina niet op te halen');
      if (++foutenOpRij >= MAX_FOUTEN_OP_RIJ) {
        result.errors.push(`gestopt na ${MAX_FOUTEN_OP_RIJ} mislukte fetches op rij`);
        break;
      }
      continue;
    }
    foutenOpRij = 0;
    const ev = parse013Page(html, url);
    // Afgelaste events laat de JSON-LD-extractor zelf al vallen; die
    // verdwijnen verderop via de prune.
    if (!ev) { skip('geen bruikbare JSON-LD'); continue; }
    events.push(ev);
  }
  result.fetched = events.length;
  if (!events.length) {
    result.errors.push('geen events geparsed');
    return [result];
  }

  const titleMap = await loadVenueTitleMap(VENUE_ID, 'evt-013-');
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  const seenOcc = new Map<string, Set<string>>();

  for (const ev of events) {
    try {
      if (ev.startsAt.getTime() < cutoff) { skip('al voorbij'); continue; }

      const { eventId } = resolveEventId(titleMap, ev.title, `evt-013-${ev.id}`, {
        startsAt: ev.startsAt,
        description: ev.description,
      });
      const occurrenceId = `occ-013-${ev.id}`;

      const [bestaand] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      if (!bestaand) {
        let imageUrl: string | null = null;
        if (ev.imageUrl) imageUrl = (await mirrorImage(ev.imageUrl, ev.id)) ?? ev.imageUrl;

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
            venueId: VENUE_ID,
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
            room: ev.room,
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
              room: ev.room,
              status,
            },
          });
        result.occurrencesUpserted++;
        const gezien = seenOcc.get(eventId) ?? new Set<string>();
        gezien.add(occurrenceId);
        seenOcc.set(eventId, gezien);
      } catch (e) {
        result.errors.push(`occurrence ${occurrenceId}: ${(e as Error).message}`);
        skip('occurrence-write faalde');
      }
    } catch (e) {
      result.errors.push(`event ${ev.id}: ${(e as Error).message}`);
      skip('exception op event');
    }
  }

  // Toekomstige datums weghalen die 013 niet meer aanbiedt. Alleen voor
  // events die we dit rondje echt gezien hebben; saves blijven staan.
  const pruneCutoff = new Date(cutoff);
  for (const [eventId, keep] of seenOcc) {
    try {
      const bestaand = await db
        .select({ id: schema.occurrences.id })
        .from(schema.occurrences)
        .where(and(eq(schema.occurrences.eventId, eventId), gt(schema.occurrences.startsAt, pruneCutoff)));
      const drop = bestaand.map((r) => r.id).filter((id) => !keep.has(id));
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

  return [result];
}
