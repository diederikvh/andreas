/**
 * De Uitkijk scraper.
 *
 * Astro-SSR site. Per film: `data-film="{slug}"` en
 * `data-date="DD-MM-YY-HH:MM"` op de ticket-link, ticket-URL
 * `api.uitkijk.nl/z-tickets/show/{id}`. Geen JSON-LD voor screenings.
 *
 * Idempotency: occurrence-id = `uitkijk-show-{ticketing-id}`.
 */

import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import {
  findOrCreateFilmEvent,
  loadFilmDedupeMap,
  pruneStaleOccurrences,
} from './_film-dedup.js';

const HOME_URL = 'https://www.uitkijk.nl/';
const VENUE_ID = 'de-uitkijk';
const UA = 'AndreasBot/1.0 (+https://andreas.amsterdam)';

export interface UitkijkResult {
  venueId: 'de-uitkijk';
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  occurrencesPruned: number;
  skipped: number;
  errors: string[];
}

export async function scrapeUitkijk(): Promise<UitkijkResult[]> {
  const result: UitkijkResult = {
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
      [...home.matchAll(/href="(\/film\/[^"#]+)"/g)].map(
        (m) => `https://www.uitkijk.nl${m[1]}`
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

      const title = decodeEntities(
        html.match(/<meta property="og:title"[^>]*content="([^"]+)"/)?.[1] ?? ''
      ).trim();
      if (!title) {
        result.skipped += 1;
        continue;
      }
      const description =
        decodeEntities(
          html.match(/<meta property="og:description"[^>]*content="([^"]+)"/)?.[1] ?? ''
        ).trim() || null;
      const imageUrl =
        html.match(/<meta property="og:image"[^>]*content="([^"]+)"/)?.[1] || null;

      const shows = parseShows(html, now);
      if (shows.length === 0) {
        result.skipped += 1;
        continue;
      }

      const { eventId, inserted } = await findOrCreateFilmEvent(dedupeMap, {
        title,
        description,
        imageUrl,
        venueId: VENUE_ID,
      });
      if (inserted) result.inserted += 1;

      const seenOccIds = new Set<string>();
      for (const show of shows) {
        const occId = `uitkijk-show-${show.id}`;
        seenOccIds.add(occId);
        const [existingOcc] = await db
          .select({ id: schema.occurrences.id })
          .from(schema.occurrences)
          .where(eq(schema.occurrences.id, occId))
          .limit(1);

        if (existingOcc) {
          await db
            .update(schema.occurrences)
            .set({
              startsAt: show.startsAt,
              ticketUrl: show.ticketUrl,
              venueId: VENUE_ID,
              eventId,
            })
            .where(eq(schema.occurrences.id, occId));
        } else {
          await db.insert(schema.occurrences).values({
            id: occId,
            eventId,
            venueId: VENUE_ID,
            startsAt: show.startsAt,
            priceCents: null,
            ticketUrl: show.ticketUrl,
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

interface Show {
  id: string;
  startsAt: Date;
  ticketUrl: string;
}

/** Match `<a href="...z-tickets/show/{id}" ... data-date="DD-MM-YY-HH:MM">` */
function parseShows(html: string, nowMs: number): Show[] {
  const shows: Show[] = [];
  // Pakt ticket-URL en data-date in dezelfde tag — volgorde kan
  // verschillen, dus matchen via twee aparte regexes per anchor-block.
  const anchorRe = /<a[^>]*href="(https:\/\/api\.uitkijk\.nl\/z-tickets\/show\/(\d+))"[^>]*data-date="(\d{2})-(\d{2})-(\d{2})-(\d{1,2}):(\d{2})"[^>]*>/g;
  const seen = new Set<string>();
  for (const m of html.matchAll(anchorRe)) {
    const ticketUrl = m[1];
    const showId = m[2];
    if (seen.has(showId)) continue;
    seen.add(showId);
    const day = parseInt(m[3], 10);
    const month = parseInt(m[4], 10) - 1;
    const yr = parseInt(m[5], 10);
    const hour = parseInt(m[6], 10);
    const minute = parseInt(m[7], 10);
    // 2-digit jaar → 2000+yr. Werkt voor 2000-2099.
    const year = 2000 + yr;
    const startsAt = new Date(year, month, day, hour, minute);
    if (startsAt.getTime() < nowMs - 6 * 3600 * 1000) continue;
    shows.push({ id: showId, startsAt, ticketUrl });
  }
  return shows;
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
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

