/**
 * FC Hyena scraper.
 *
 * Noord, aan het IJ. FC Hyena's homepage is een SPA maar 't laadt
 * z'n hele schedule uit één publiek JSON-endpoint: `/json/shows.json`.
 * Format: `{ movies: { production-id: Show[] } }` waarbij elke Show
 * heeft: id, name, duration (mins), time_start ("HH:MM"), date_start
 * ("MMDD", geen jaar).
 *
 * Ticketing platform: tickets.fchyena.nl/fchyena/.../show/{id}
 * (zelfde stack als Kriterion/Ketelhuis/Lab111).
 *
 * Per-film pagina's hebben generieke og:image en og:description
 * (FC Hyena's eigen branding, niet film-specifiek), dus we vullen
 * alleen titel uit de JSON en laten description/image leeg —
 * cross-venue dedup met andere film-scrapers vult 't aan.
 */

import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { fetchJsonWithTimeout } from './_fetch.js';
import {
  findOrCreateFilmEvent,
  loadFilmDedupeMap,
  pruneStaleOccurrences,
} from './_film-dedup.js';

const SHOWS_URL = 'https://fchyena.nl/json/shows.json';
const VENUE_ID = 'fc-hyena';
const UA = 'AndreasBot/1.0 (+https://andreas.amsterdam)';

export interface FchyenaResult {
  venueId: 'fc-hyena';
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  occurrencesPruned: number;
  skipped: number;
  errors: string[];
}

interface HyenaShow {
  id: string;
  name: string;
  display_name?: string;
  duration?: string;
  time_start: string;
  date_start: string;
  room?: string;
}

export async function scrapeFchyena(): Promise<FchyenaResult[]> {
  const result: FchyenaResult = {
    venueId: VENUE_ID,
    fetched: 0,
    inserted: 0,
    occurrencesUpserted: 0,
    occurrencesPruned: 0,
    skipped: 0,
    errors: [],
  };

  const json = await fetchJsonWithTimeout<{ movies?: Record<string, HyenaShow[]> }>(
    SHOWS_URL,
    { ua: UA }
  );
  if (!json) {
    result.errors.push('shows.json fetch failed');
    return [result];
  }
  if (!json.movies) {
    result.errors.push('no movies in shows.json');
    return [result];
  }

  // Groepeer alle shows per titel (na decode) zodat dezelfde film
  // op meerdere production-id's geen dubbele events maakt.
  const byTitle = new Map<string, HyenaShow[]>();
  for (const arr of Object.values(json.movies)) {
    for (const s of arr) {
      const title = decodeEntities(s.name?.trim() ?? '');
      if (!title) continue;
      const list = byTitle.get(title);
      if (list) list.push(s);
      else byTitle.set(title, [s]);
    }
  }

  const dedupeMap = await loadFilmDedupeMap();
  const now = Date.now();
  for (const [title, shows] of byTitle) {
    try {
      result.fetched += 1;

      const future = shows
        .map((s) => ({
          show: s,
          startsAt: parseDateTime(s.date_start, s.time_start, now),
          durationMin: s.duration ? parseInt(s.duration, 10) : 0,
        }))
        .filter((x) => x.startsAt && x.startsAt.getTime() >= now - 6 * 3600 * 1000);

      if (future.length === 0) {
        result.skipped += 1;
        continue;
      }

      const { eventId, inserted } = await findOrCreateFilmEvent(dedupeMap, {
        title,
        description: null,
        imageUrl: null,
        venueId: VENUE_ID,
      });
      if (inserted) result.inserted += 1;

      const seen = new Set<string>();
      const seenOccIds = new Set<string>();
      for (const f of future) {
        if (seen.has(f.show.id)) continue;
        seen.add(f.show.id);
        const occId = `fchyena-show-${f.show.id}`;
        seenOccIds.add(occId);
        const startsAt = f.startsAt!;
        const endsAt =
          f.durationMin > 0
            ? new Date(startsAt.getTime() + f.durationMin * 60 * 1000)
            : null;
        const ticketUrl = `https://tickets.fchyena.nl/fchyena/nl/flow_configs/webshop/steps/start/show/${f.show.id}`;
        const room = f.show.room?.trim() || null;

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
              ticketUrl,
              room,
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
            priceCents: null,
            ticketUrl,
            room,
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
      result.errors.push(`${title}: ${(e as Error).message ?? String(e)}`);
    }
  }
  return [result];
}

/** date_start "0529" + time_start "14:15" → Date. Jaar afgeleid uit
    now: huidige jaar tenzij de datum daardoor in 't verleden valt
    (Nieuwjaar-overlap). */
function parseDateTime(
  date4: string,
  time: string,
  nowMs: number
): Date | null {
  if (!/^\d{4}$/.test(date4)) return null;
  const tm = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!tm) return null;
  const month = parseInt(date4.slice(0, 2), 10) - 1;
  const day = parseInt(date4.slice(2, 4), 10);
  const hour = parseInt(tm[1], 10);
  const minute = parseInt(tm[2], 10);
  if (month < 0 || month > 11) return null;
  const now = new Date(nowMs);
  let year = now.getFullYear();
  let d = new Date(year, month, day, hour, minute);
  if (d.getTime() < nowMs - 6 * 3600 * 1000) {
    year += 1;
    d = new Date(year, month, day, hour, minute);
  }
  return d;
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

