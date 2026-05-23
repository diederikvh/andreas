/**
 * Filmhallen scraper.
 *
 * De Filmhallen (Oud-West). Per-film pagina's hebben Movie + meerdere
 * ScreeningEvent JSON-LD blocks. Zelfde pattern als The Movies: filter
 * ScreeningEvent.name op de Movie's name zodat we niet per ongeluk
 * andere films' screenings koppelen.
 */

import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { fetchTextWithTimeout } from './_fetch.js';
import {
  findOrCreateFilmEvent,
  loadFilmDedupeMap,
  pruneStaleOccurrences,
} from './_film-dedup.js';

const HOME_URL = 'https://www.filmhallen.nl/';
const VENUE_ID = 'filmhallen';
const UA = 'AndreasBot/1.0 (+https://andreas.amsterdam)';

export interface FilmhallenResult {
  venueId: 'filmhallen';
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  occurrencesPruned: number;
  skipped: number;
  errors: string[];
}

interface MovieLd {
  '@type': 'Movie';
  name: string;
  description?: string;
  image?: string;
}

interface ScreeningEventLd {
  '@type': 'ScreeningEvent';
  name: string;
  startDate: string;
  endDate?: string;
  url?: string;
  offers?: { url?: string; price?: number };
}

export async function scrapeFilmhallen(): Promise<FilmhallenResult[]> {
  const result: FilmhallenResult = {
    venueId: VENUE_ID,
    fetched: 0,
    inserted: 0,
    occurrencesUpserted: 0,
    occurrencesPruned: 0,
    skipped: 0,
    errors: [],
  };

  const home = await fetchText(HOME_URL);
  if (!home) {
    result.errors.push('home fetch failed');
    return [result];
  }
  const filmUrls = [
    ...new Set(
      [...home.matchAll(/href="(https:\/\/filmhallen\.nl\/films\/[^"]+)"/g)].map(
        (m) => m[1]
      )
    ),
  ];

  const dedupeMap = await loadFilmDedupeMap();
  const now = Date.now();
  for (const filmUrl of filmUrls) {
    try {
      const html = await fetchText(filmUrl);
      if (!html) {
        result.errors.push(`fetch failed: ${filmUrl}`);
        continue;
      }
      result.fetched += 1;

      const { movie, screenings } = parseJsonLd(html);
      if (!movie) {
        result.skipped += 1;
        continue;
      }
      const title = movie.name.trim();
      if (!title) {
        result.skipped += 1;
        continue;
      }
      const mine = screenings.filter(
        (s) => s.name.trim() === title && new Date(s.startDate).getTime() >= now
      );
      if (mine.length === 0) {
        result.skipped += 1;
        continue;
      }
      const description = movie.description?.trim() || null;
      const imageUrl = movie.image?.trim() || null;

      const { eventId, inserted } = await findOrCreateFilmEvent(dedupeMap, {
        title,
        description,
        imageUrl,
        venueId: VENUE_ID,
      });
      if (inserted) result.inserted += 1;

      const seenOccIds = new Set<string>();
      for (const s of mine) {
        const ticketUrl = s.url ?? s.offers?.url ?? null;
        const showId = parseShowId(ticketUrl ?? undefined);
        if (!showId) continue;
        const occId = `filmhallen-show-${showId}`;
        seenOccIds.add(occId);
        const startsAt = new Date(s.startDate);
        const endsAt = s.endDate ? new Date(s.endDate) : null;
        const priceCents =
          typeof s.offers?.price === 'number'
            ? Math.round(s.offers.price * 100)
            : null;

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
              endsAt,
              priceCents,
              ticketUrl,
              venueId: VENUE_ID,
              eventId,
            })
            .where(eq(schema.occurrences.id, occId));
        } else {
          await db.insert(schema.occurrences).values({
            id: occId,
            eventId,
            venueId: VENUE_ID,
            startsAt,
            endsAt,
            priceCents,
            ticketUrl,
            status: 'scheduled',
          });
        }
        result.occurrencesUpserted += 1;
      }

      result.occurrencesPruned += await pruneStaleOccurrences({
        eventId,
        venueId: VENUE_ID,
        seenOccIds,
        nowMs: now,
      });
    } catch (e) {
      result.errors.push(`${filmUrl}: ${(e as Error).message ?? String(e)}`);
    }
  }
  return [result];
}

async function fetchText(url: string): Promise<string | null> {
  return fetchTextWithTimeout(url, { ua: UA });
}

function parseJsonLd(html: string): {
  movie: MovieLd | null;
  screenings: ScreeningEventLd[];
} {
  let movie: MovieLd | null = null;
  const screenings: ScreeningEventLd[] = [];
  const re = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  for (const m of html.matchAll(re)) {
    try {
      const data = JSON.parse(m[1]);
      const items: unknown[] = Array.isArray(data)
        ? data
        : Array.isArray((data as { '@graph'?: unknown[] })['@graph'])
          ? ((data as { '@graph': unknown[] })['@graph'])
          : [data];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const obj = item as Record<string, unknown>;
        if (obj['@type'] === 'Movie' && typeof obj.name === 'string') {
          movie = obj as unknown as MovieLd;
        } else if (
          obj['@type'] === 'ScreeningEvent' &&
          typeof obj.name === 'string' &&
          typeof obj.startDate === 'string'
        ) {
          screenings.push(obj as unknown as ScreeningEventLd);
        }
      }
    } catch {
      /* skip */
    }
  }
  return { movie, screenings };
}

function parseShowId(url?: string): string | null {
  if (!url) return null;
  const m = url.match(/\/tickets\/(\d+)/);
  return m ? m[1] : null;
}

