/**
 * Rialto scraper.
 *
 * Rialto Ceintuurbaan (De Pijp) + Rialto VU (campus VU, Zuid).
 * Onder twee aparte venues: `rialto` (De Pijp) en `rialto-vu` (VU).
 *
 * Bron: publiek JSON-feed-endpoint per locatie:
 *
 *   /feed/nl/program/{locationId}/{daysAhead}
 *
 * waarbij locationId 1 = De Pijp en 7 = VU. Returnt een array van
 * dag-buckets met programs (screenings). Per screening: id, film_id,
 * title, starts_at (HH:MM), date (ISO), genre, locatie, sold_out,
 * cover (filename), film_url, selected_time_url (ticket-URL).
 *
 * Idempotency: occurrence-id = `rialto-show-{program-id}`.
 */

import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { fetchJsonWithTimeout, fetchTextWithTimeout } from './_fetch.js';
import {
  findOrCreateFilmEvent,
  loadFilmDedupeMap,
  pruneStaleOccurrences,
} from './_film-dedup.js';

const PRIMARY_VENUE_ID = 'rialto';
const VU_VENUE_ID = 'rialto-vu';
const UA = 'AndreasBot/1.0 (+https://andreas.amsterdam)';
const DAYS_AHEAD = 28;

/** location-id in Rialto's feed → onze venue-id. */
const LOCATIONS: Array<{ id: number; venueId: string }> = [
  { id: 1, venueId: PRIMARY_VENUE_ID },
  { id: 7, venueId: VU_VENUE_ID },
];

export interface RialtoResult {
  venueId: 'rialto';
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  occurrencesPruned: number;
  skipped: number;
  errors: string[];
}

interface FeedProgram {
  id: number;
  film_id: number;
  title: string;
  film_url: string;
  selected_time_url?: string;
  url?: string;
  cover?: string;
  location_name?: string;
  genre?: string;
  starts_at: string;
  date: string;
  timestamp: string;
  sold_out: boolean;
  note?: string | null;
}

interface FeedDay {
  programs?: FeedProgram[];
  date?: string;
}

export async function scrapeRialto(): Promise<RialtoResult[]> {
  const result: RialtoResult = {
    venueId: PRIMARY_VENUE_ID,
    fetched: 0,
    inserted: 0,
    occurrencesUpserted: 0,
    occurrencesPruned: 0,
    skipped: 0,
    errors: [],
  };

  // 1) Haal feeds op per locatie en verzamel programs samen met de
  //    bijbehorende venue-id.
  const allPrograms: Array<{ p: FeedProgram; venueId: string }> = [];
  for (const loc of LOCATIONS) {
    const feed = await fetchFeed(loc.id);
    if (!feed) {
      result.errors.push(`feed loc ${loc.id} fetch failed`);
      continue;
    }
    for (const day of feed) {
      for (const p of day.programs ?? []) {
        allPrograms.push({ p, venueId: loc.venueId });
      }
    }
  }

  // 2) Group by film_id → één event per film, occurrences per program.
  const byFilmId = new Map<number, Array<{ p: FeedProgram; venueId: string }>>();
  for (const entry of allPrograms) {
    const list = byFilmId.get(entry.p.film_id);
    if (list) list.push(entry);
    else byFilmId.set(entry.p.film_id, [entry]);
  }

  // 3) Per unieke film_id: één film-page-fetch voor og:title/desc/image.
  const filmMeta = new Map<number, { title: string; description: string | null; imageUrl: string | null }>();
  for (const [filmId, list] of byFilmId) {
    const url = list[0].p.film_url;
    const html = await fetchText(url);
    result.fetched += 1;
    if (!html) continue;
    const title = decodeEntities(
      (html.match(/<meta property="og:title"[^>]*content="([^"]+)"/)?.[1] ?? '').trim()
    ).replace(/\s+/g, ' ');
    if (!title) continue;
    const description =
      decodeEntities(
        (html.match(/<meta property="og:description"[^>]*content="([^"]+)"/)?.[1] ?? '').trim()
      ) || null;
    const imageUrl =
      html.match(/<meta property="og:image"[^>]*content="([^"]+)"/)?.[1] || null;
    filmMeta.set(filmId, { title, description, imageUrl });
  }

  // 4) Per film: maak/vind event, hang occurrences eraan.
  const dedupeMap = await loadFilmDedupeMap();
  const nowMs = Date.now();
  const eventByFilmId = new Map<number, string>();
  // Tracking voor stale-cleanup. Rialto heeft twee venues (Pijp + VU);
  // we prunen per (eventId, venueId) zodat occurrences van locatie A
  // niet weggaan als wij locatie B's HTML scrapen.
  const seenByEventAndVenue = new Map<string, Set<string>>();
  const key = (eventId: string, venueId: string) => `${eventId}::${venueId}`;
  for (const [filmId, list] of byFilmId) {
    try {
      const meta = filmMeta.get(filmId);
      if (!meta) {
        result.skipped += 1;
        continue;
      }

      let eventId = eventByFilmId.get(filmId);
      if (!eventId) {
        const r = await findOrCreateFilmEvent(dedupeMap, {
          title: meta.title,
          description: meta.description,
          imageUrl: meta.imageUrl,
          venueId: PRIMARY_VENUE_ID,
        });
        eventId = r.eventId;
        if (r.inserted) result.inserted += 1;
        eventByFilmId.set(filmId, eventId);
      }

      for (const { p, venueId } of list) {
        const tsMs = Number(p.timestamp) * 1000;
        const startsAt = Number.isFinite(tsMs) ? new Date(tsMs) : null;
        if (!startsAt || Number.isNaN(startsAt.getTime())) continue;
        if (startsAt.getTime() < nowMs - 6 * 3600 * 1000) continue;

        const occId = `rialto-show-${p.id}`;
        const ticketUrl = p.selected_time_url ?? p.film_url;
        const status: 'scheduled' | 'sold_out' = p.sold_out ? 'sold_out' : 'scheduled';
        let seenSet = seenByEventAndVenue.get(key(eventId, venueId));
        if (!seenSet) {
          seenSet = new Set();
          seenByEventAndVenue.set(key(eventId, venueId), seenSet);
        }
        seenSet.add(occId);

        const [existingOcc] = await db
          .select({ id: schema.occurrences.id })
          .from(schema.occurrences)
          .where(eq(schema.occurrences.id, occId))
          .limit(1);

        if (existingOcc) {
          await db
            .update(schema.occurrences)
            .set({
              startsAt,
              ticketUrl,
              venueId,
              eventId,
              status,
            })
            .where(eq(schema.occurrences.id, occId));
        } else {
          await db.insert(schema.occurrences).values({
            id: occId,
            eventId,
            venueId,
            startsAt,
            priceCents: null,
            ticketUrl,
            status,
          });
        }
        result.occurrencesUpserted += 1;
      }
    } catch (e) {
      result.errors.push(`film ${filmId}: ${(e as Error).message ?? String(e)}`);
    }
  }

  for (const [k, seenOccIds] of seenByEventAndVenue) {
    const [eventId, venueId] = k.split('::');
    result.occurrencesPruned += await pruneStaleOccurrences({
      eventId,
      venueId,
      seenOccIds,
      nowMs,
    });
  }
  return [result];
}

async function fetchFeed(locationId: number): Promise<FeedDay[] | null> {
  return fetchJsonWithTimeout<FeedDay[]>(
    `https://rialtofilm.nl/feed/nl/program/${locationId}/${DAYS_AHEAD}`,
    { ua: UA }
  );
}

async function fetchText(url: string): Promise<string | null> {
  return fetchTextWithTimeout(url, { ua: UA });
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#8217;/g, '’')
    .replace(/&#8216;/g, '‘')
    .replace(/&#8211;/g, '–')
    .replace(/&#038;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

