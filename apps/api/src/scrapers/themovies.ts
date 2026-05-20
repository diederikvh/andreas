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

import { randomBytes } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { fetchFilmGenres } from './_tmdb.js';

const SITEMAP_URL = 'https://themovies.nl/fk-feed/film-sitemap-xml';
const VENUE_ID = 'the-movies';
const UA = 'AndreasBot/1.0 (+https://andreas.amsterdam)';

export interface TheMoviesResult {
  venueId: 'the-movies';
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
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

      // Cross-venue dedup.
      const [existing] = await db
        .select({
          id: schema.events.id,
          description: schema.events.description,
          imageUrl: schema.events.imageUrl,
          genres: schema.events.genres,
        })
        .from(schema.events)
        .where(
          and(
            eq(schema.events.title, title),
            eq(schema.events.category, 'Film'),
            eq(schema.events.kind, 'show')
          )
        )
        .limit(1);

      let eventId: string;
      if (existing) {
        eventId = existing.id;
        // Vul ontbrekende velden aan zonder bestaande te overschrijven.
        // Wikipedia-URLs voor poster mogen weg (Kriterion-pattern) —
        // The Movies' image is een filmposter, even goed of beter.
        const patch: Record<string, unknown> = {};
        if (!existing.description && description) {
          patch.description = description;
        }
        if (
          imageUrl &&
          (!existing.imageUrl ||
            /wiki(p|m)edia\.org/.test(existing.imageUrl))
        ) {
          patch.imageUrl = imageUrl;
        }
        if (!existing.genres || existing.genres.length === 0) {
          const genres = await fetchFilmGenres(title);
          if (genres.length > 0) patch.genres = genres;
        }
        if (Object.keys(patch).length > 0) {
          await db
            .update(schema.events)
            .set(patch)
            .where(eq(schema.events.id, eventId));
        }
      } else {
        eventId = `film-${slugify(title)}-${randomBytes(3).toString('hex')}`;
        const genres = await fetchFilmGenres(title);
        await db.insert(schema.events).values({
          id: eventId,
          venueId: VENUE_ID,
          title,
          description,
          kind: 'show',
          imageUrl,
          category: 'Film',
          ...(genres.length > 0 ? { genres } : {}),
        });
        result.inserted += 1;
      }

      for (const s of mine) {
        const showId = parseShowId(s.url ?? s.offers?.url);
        if (!showId) continue;
        const occId = `themovies-show-${showId}`;
        const startsAt = new Date(s.startDate);
        if (Number.isNaN(startsAt.getTime())) continue;
        const endsAt = s.endDate ? new Date(s.endDate) : null;
        const priceCents =
          typeof s.offers?.price === 'number'
            ? Math.round(s.offers.price * 100)
            : null;
        const ticketUrl = s.url ?? s.offers?.url ?? null;

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
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
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

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}
