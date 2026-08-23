/**
 * The Movies scraper.
 *
 * The Movies (Haarlemmerdijk, oudste bioscoop van Amsterdam, sinds
 * 1912) publiceert per film een pagina met JSON-LD:
 *   - één Movie (titel + omschrijving + image + director)
 *   - meerdere ScreeningEvent-pairs (ochtend + avond per dag)
 *
 * Pas op: de pagina toont OOK ScreeningEvents van andere films vandaag
 * — we filteren ScreeningEvent.name op de Movie.name zodat we niet per
 * ongeluk een The Drama-screening aan Agatha's Almanac koppelen.
 *
 * Plan:
 *   1. Sitemap → film-URLs (`/films/{slug}/`).
 *   2. Per film: Movie + matchende ScreeningEvents.
 *   3. Cross-venue dedup op title+kind=show+category=Film (Anora bij
 *      Eye/Kriterion/The Movies → één event, multi-venue occurrences).
 *   4. Occurrence-id stabiel via `themovies-show-{tickets-id}` —
 *      idempotent over re-runs.
 */


import { db, schema } from '../db/index.js';
import { fetchTextWithTimeout } from './_fetch.js';
import {
  findOrCreateFilmEvent,
  loadFilmDedupeMap,
  pruneStaleOccurrences,
} from './_film-dedup.js';

const SITEMAP_URL = 'https://themovies.nl/fk-feed/film-sitemap-xml';
const VENUE_ID = 'the-movies';
const UA = 'AndreasBot/1.0 (+https://andreas.amsterdam)';

/**
 * De sitemap bevat élke film die er ooit liep — 580 URLs, waarvan maar
 * een fractie nog speelt. themovies.nl knijpt af zodra je die in één
 * burst langsgaat: eerst nog snelle responses (~15ms), daarna niets
 * meer. Elke geblokkeerde fetch loopt dan in de 15s-timeout van
 * `fetchTextWithTimeout`, dus 580 × 15s = ruim twee uur. In CI kapte
 * curl er op 25 minuten mee (exit 28) — dat was de dagelijkse failure.
 *
 * Twee remmen dus. Ruimte tussen de requests om de limiet niet te
 * raken, en een noodstop als het tóch gebeurt: dan liever een snelle
 * partiële run met een duidelijke error dan twee uur doorploegen.
 */
const REQUEST_SPACING_MS = 200;
const MAX_CONSECUTIVE_FAILURES = 8;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TheMoviesResult {
  venueId: 'the-movies';
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
  url?: string;
  director?: Array<{ name: string }>;
}

interface ScreeningEventLd {
  '@type': 'ScreeningEvent';
  name: string;
  url?: string;
  startDate: string;
  endDate?: string;
  offers?: { url?: string; price?: number; priceCurrency?: string };
}

export async function scrapeTheMovies(): Promise<TheMoviesResult[]> {
  const result: TheMoviesResult = {
    venueId: 'the-movies',
    fetched: 0,
    inserted: 0,
    occurrencesUpserted: 0,
    occurrencesPruned: 0,
    skipped: 0,
    errors: [],
  };

  const sitemap = await fetchText(SITEMAP_URL);
  if (!sitemap) {
    result.errors.push('sitemap fetch failed');
    return [result];
  }
  const filmUrls = [
    ...sitemap.matchAll(/<loc>([^<]+\/films\/[^<]+)<\/loc>/g),
  ].map((m) => m[1]);

  const dedupeMap = await loadFilmDedupeMap();
  const now = Date.now();
  let consecutiveFailures = 0;
  let first = true;
  for (const filmUrl of filmUrls) {
    try {
      if (!first) await sleep(REQUEST_SPACING_MS);
      first = false;
      const html = await fetchText(filmUrl);
      if (!html) {
        result.errors.push(`fetch failed: ${filmUrl}`);
        if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          result.errors.push(
            `gestopt na ${consecutiveFailures} mislukte fetches op rij — bron weigert; ` +
              `${result.fetched} van ${filmUrls.length} films gedaan`
          );
          break;
        }
        continue;
      }
      consecutiveFailures = 0;
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

      // Filter screenings op de juiste film én op toekomstige tijden.
      const mine = screenings.filter(
        (s) =>
          s.name.trim() === title &&
          new Date(s.startDate).getTime() >= now
      );
      if (mine.length === 0) {
        // Film loopt niet meer (of nog niet) — skip (geen lege events).
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
        const showId = parseShowId(s.url ?? s.offers?.url);
        if (!showId) continue;
        const occId = `themovies-show-${showId}`;
        seenOccIds.add(occId);
        const startsAt = new Date(s.startDate);
        if (Number.isNaN(startsAt.getTime())) continue;
        const endsAt = s.endDate ? new Date(s.endDate) : null;
        const priceCents =
          typeof s.offers?.price === 'number'
            ? Math.round(s.offers.price * 100)
            : null;
        const ticketUrl = s.url ?? s.offers?.url ?? null;

        // Eén upsert i.p.v. select-dan-update/insert: halveert de
        // round-trips per screening, en dit is het patroon dat de
        // andere scrapers ook gebruiken.
        await db
          .insert(schema.occurrences)
          .values({
            id: occId,
            eventId,
            venueId: VENUE_ID,
            startsAt,
            endsAt,
            priceCents,
            ticketUrl,
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: { eventId, venueId: VENUE_ID, startsAt, endsAt, priceCents, ticketUrl },
          });
        result.occurrencesUpserted += 1;
      }

      result.occurrencesPruned += await pruneStaleOccurrences({
        eventId,
        venueId: VENUE_ID,
        seenOccIds,
        nowMs: now,
      });
    } catch (e) {
      result.errors.push(
        `${filmUrl}: ${(e as Error).message ?? String(e)}`
      );
    }
  }

  return [result];
}

// ─── Helpers ────────────────────────────────────────────────────────────

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

