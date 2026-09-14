import { and, eq, gt, inArray } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import {
  eindMoment,
  momentVan,
  parseEffenaarCollectie,
  parseEffenaarDetail,
  type EffenaarTegel,
} from './_effenaar-page.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';
import { loadVenueTitleMap, resolveEventId } from './_title-dedup.js';

/**
 * Effenaar, Eindhoven.
 *
 * Niet via Stager, ondanks de stager-link op hun site — die hoort bij
 * promotor Discophonic Orchestra, en `effenaar.stager.co` heeft geen
 * shop.
 *
 * Twee bronnen, en de verdeling ertussen is hier het hele punt:
 *
 *  - `/agenda` draagt de complete Algolia-collectie mee in
 *    `__NEXT_DATA__`: 130 events in één response, met dag, zaal, genres,
 *    beeld en verkoopstatus. Eén fetch voor de hele agenda.
 *  - de detailpagina heeft de starttijd, die níet in de collectie staat
 *    (hun `date` is een timestamp op 12:00 UTC — alleen de dag).
 *
 * Die detailpagina's zijn 1,6 MB per stuk, want Next.js bakt er de hele
 * query-cache in. 130 daarvan is 200 MB voor één veld. Daarom halen we
 * ze alleen op voor events die we nog niet kennen óf waarvan de dag
 * verschoven is; de rest van de velden ververst elke nacht gewoon uit
 * die ene collectie-fetch. Na de eerste run zijn dat een handvol
 * detailpagina's per nacht in plaats van 130.
 *
 * Idempotency:
 *  - eventId      = `evt-ef-{nid}` (Drupal-node-id, stabieler dan de slug
 *                   die per editie wisselt), gegroepeerd op titel.
 *  - occurrenceId = `occ-ef-{nid}`
 */

const VENUE_ID = 'effenaar';
const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const AGENDA_URL = 'https://www.effenaar.nl/agenda';
const DETAIL_SPACING_MS = 200;
const MAX_FOUTEN_OP_RIJ = 8;

async function fetchPagina(url: string): Promise<string | null> {
  for (let poging = 1; poging <= 3; poging++) {
    try {
      const r = await fetch(url, {
        headers: { 'user-agent': UA, 'accept-language': 'nl-NL,nl' },
        signal: AbortSignal.timeout(30000),
      });
      if (r.ok) return await r.text();
    } catch {
      // volgende poging
    }
    if (poging < 3) await new Promise((res) => setTimeout(res, 500 * poging));
  }
  return null;
}

async function mirrorImage(sourceUrl: string, nid: string): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength < 1024 || buf.byteLength > 8 * 1024 * 1024) return null;
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    return await uploadToBunny(`media/events/ef-${nid}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[effenaar] mirror image ${nid}: ${(e as Error).message}`);
    return null;
  }
}

export type EffenaarResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  detailsOpgehaald: number;
  occurrencesUpserted: number;
  occurrencesPruned: number;
  skipped: number;
  skipReasons: Record<string, number>;
  errors: string[];
};

export async function scrapeEffenaar(options?: {
  venueIds?: string[];
}): Promise<EffenaarResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: EffenaarResult = {
    venueId: VENUE_ID, fetched: 0, inserted: 0, detailsOpgehaald: 0,
    occurrencesUpserted: 0, occurrencesPruned: 0, skipped: 0,
    skipReasons: {}, errors: [],
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

  const agenda = await fetchPagina(AGENDA_URL);
  if (!agenda) {
    result.errors.push('/agenda niet op te halen');
    return [result];
  }
  const tegels = parseEffenaarCollectie(agenda);
  result.fetched = tegels.length;
  if (!tegels.length) {
    result.errors.push('geen events in de collectie');
    return [result];
  }

  const titleMap = await loadVenueTitleMap(VENUE_ID, 'evt-ef-');
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  const seenOcc = new Map<string, Set<string>>();
  let foutenOpRij = 0;

  for (const tegel of tegels) {
    try {
      const occurrenceId = `occ-ef-${tegel.nid}`;

      // Wat we al hebben staan. De dag komt uit de collectie; alleen als
      // die verschoven is (of we kennen het event nog niet) is de
      // detailpagina nodig voor een nieuwe starttijd.
      const [bestaandeOcc] = await db
        .select({ startsAt: schema.occurrences.startsAt })
        .from(schema.occurrences)
        .where(eq(schema.occurrences.id, occurrenceId))
        .limit(1);

      const bekendeDag = bestaandeOcc
        ? new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Europe/Amsterdam',
            year: 'numeric', month: '2-digit', day: '2-digit',
          }).format(bestaandeOcc.startsAt)
        : null;

      let detail: ReturnType<typeof parseEffenaarDetail> = null;
      if (!bestaandeOcc || bekendeDag !== tegel.dagIso) {
        const html = await fetchPagina(tegel.url);
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
        result.detailsOpgehaald++;
        detail = parseEffenaarDetail(html);
        if (!detail) { skip('detailpagina niet te parsen'); continue; }
      }

      const dagIso = detail?.dagIso ?? tegel.dagIso;
      const startsAt = detail
        ? momentVan(dagIso, detail.startLokaal)
        : bestaandeOcc!.startsAt;
      if (!startsAt || isNaN(startsAt.getTime())) { skip('geen starttijd'); continue; }
      if (startsAt.getTime() < cutoff) { skip('al voorbij'); continue; }
      const endsAt = detail ? eindMoment(dagIso, detail.startLokaal, detail.eindLokaal) : null;

      const { eventId } = resolveEventId(titleMap, tegel.title, `evt-ef-${tegel.nid}`, {
        startsAt,
        description: detail?.description ?? tegel.teaser,
      });

      const [bestaand] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      // Genres komen van henzelf: "classics & legends", "singer –
      // songwriter". Specifieker dan wat een model uit een titel haalt.
      const genres = tegel.genres.length ? tegel.genres : (detail?.genres ?? []);

      if (!bestaand) {
        let imageUrl: string | null = null;
        if (tegel.imageUrl) imageUrl = (await mirrorImage(tegel.imageUrl, tegel.nid)) ?? tegel.imageUrl;
        const tekst = detail?.description ?? tegel.teaser;

        let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;
        try {
          enriched = await enrichEvent({
            title: tegel.title,
            description: tekst,
            venueName: venue.name,
            venueCategory,
          });
        } catch (e) {
          result.errors.push(`enrich ${tegel.title}: ${(e as Error).message}`);
        }

        try {
          await db.insert(schema.events).values({
            id: eventId,
            venueId: VENUE_ID,
            title: tegel.title,
            description: enriched?.cleanedDescription ?? tekst ?? tegel.subtitle,
            kind: refineKindByDuration(enriched?.kind ?? 'show', startsAt, endsAt),
            imageUrl,
            category: enriched?.category ?? venueCategory,
            featured: false,
            genres: genres.length ? genres : (enriched?.genres ?? []),
            published: true,
          });
          result.inserted++;
        } catch (e) {
          result.errors.push(`insert event ${eventId}: ${(e as Error).message}`);
          continue;
        }
      }

      // Status komt uit de collectie, ook voor events waarvan we de
      // detailpagina overslaan — dat is juist waarom dit werkt.
      const status = tegel.cancelled
        ? 'cancelled'
        : tegel.soldOut
          ? 'sold_out'
          : 'scheduled';
      const ticketUrl = detail?.ticketUrl ?? tegel.url;

      try {
        await db
          .insert(schema.occurrences)
          .values({
            id: occurrenceId,
            eventId,
            startsAt,
            endsAt,
            priceCents: detail?.priceCents ?? null,
            priceNote: null,
            ticketUrl,
            room: tegel.room,
            lineup: null,
            status,
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: {
              eventId,
              startsAt,
              room: tegel.room,
              status,
              // endsAt, prijs en ticketlink alleen bijwerken als we de
              // detailpagina dit rondje echt hebben gezien; anders zouden
              // we ze met null overschrijven.
              ...(detail
                ? { endsAt, priceCents: detail.priceCents, ticketUrl }
                : {}),
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
      result.errors.push(`event ${tegel.nid}: ${(e as Error).message}`);
      skip('exception op event');
    }
  }

  // Toekomstige datums weghalen die Effenaar niet meer aanbiedt. Alleen
  // voor events die we dit rondje gezien hebben; saves blijven staan.
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
