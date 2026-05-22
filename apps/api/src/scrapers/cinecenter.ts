/**
 * Cinecenter scraper.
 *
 * Cinecenter (Korte Leidsedwarsstraat, centrum, drie zalen, arthouse).
 * Site is Astro SSR + Vue islands. De /films/ pagina rendert een
 * `<astro-island>` element met een grote `props="..."` attribute die
 * de hele productions-tree bevat in Astro's [type, value]-encoding
 * (een soort compacte JSON met type-tags: 0=scalar, 1=array, 3=date).
 *
 * De productions-tree heeft per film:
 *   - id (UUID), title, description (per locale), thumbnail, slug
 *   - screenings: array met id (UUID), startAtUtc, endsAtUtc, hallName,
 *     url (kassa.cinecenter.nl/#/checkout/{uuid})
 *
 * Idempotency: occurrence-id = `cinecenter-show-${screeningUuid}`.
 */

import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import {
  findOrCreateFilmEvent,
  loadFilmDedupeMap,
  pruneStaleOccurrences,
} from './_film-dedup.js';

const FILMS_URL = 'https://www.cinecenter.nl/films/';
const VENUE_ID = 'cinecenter';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

export interface CinecenterResult {
  venueId: 'cinecenter';
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  occurrencesPruned: number;
  skipped: number;
  errors: string[];
}

interface DecodedProduction {
  id: string;
  title: string;
  description: string | null;
  thumbnail: string | null;
  slug: string;
  durationMin: number | null;
  screenings: Array<{
    id: string;
    startAtUtc: string;
    endsAtUtc: string | null;
    hallName: string | null;
    url: string;
  }>;
}

export async function scrapeCinecenter(): Promise<CinecenterResult[]> {
  const result: CinecenterResult = {
    venueId: VENUE_ID,
    fetched: 0,
    inserted: 0,
    occurrencesUpserted: 0,
    occurrencesPruned: 0,
    skipped: 0,
    errors: [],
  };

  const html = await fetchText(FILMS_URL);
  if (!html) {
    result.errors.push('films fetch failed');
    return [result];
  }
  const productions = extractProductions(html);
  if (productions.length === 0) {
    result.errors.push('no productions found in astro-island');
    return [result];
  }

  const dedupeMap = await loadFilmDedupeMap();
  const now = Date.now();
  for (const prod of productions) {
    try {
      result.fetched += 1;
      const title = prod.title.trim();
      if (!title) {
        result.skipped += 1;
        continue;
      }
      const future = prod.screenings.filter(
        (s) => new Date(s.startAtUtc).getTime() >= now - 6 * 3600 * 1000
      );
      if (future.length === 0) {
        result.skipped += 1;
        continue;
      }

      const { eventId, inserted } = await findOrCreateFilmEvent(dedupeMap, {
        title,
        description: prod.description,
        imageUrl: prod.thumbnail,
        venueId: VENUE_ID,
      });
      if (inserted) result.inserted += 1;

      const seenOccIds = new Set<string>();
      for (const s of future) {
        const occId = `cinecenter-show-${s.id}`;
        seenOccIds.add(occId);
        const startsAt = new Date(s.startAtUtc);
        const endsAt = s.endsAtUtc ? new Date(s.endsAtUtc) : null;
        const room = s.hallName?.trim() || null;
        const ticketUrl = s.url;

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
      result.errors.push(`${prod.title}: ${(e as Error).message ?? String(e)}`);
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

/** Astro encodes values als `[typeTag, value]` waar typeTag aangeeft:
    - 0 = scalar (incl. objects)
    - 1 = array (value is een lijst van [tag, item]-tuples)
    - 3 = date string (ISO)
    Andere tags negeren we — we hebben alleen 0, 1, 3 nodig. */
function unwrap(v: unknown): unknown {
  if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number') {
    const tag = v[0];
    const inner = v[1];
    if (tag === 1 && Array.isArray(inner)) {
      return inner.map((x) => unwrap(x));
    }
    if (tag === 3 && typeof inner === 'string') {
      return inner;
    }
    if (tag === 0) {
      if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) {
        return inner;
      }
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(inner)) {
        out[k] = unwrap(val);
      }
      return out;
    }
    return inner;
  }
  return v;
}

function extractProductions(html: string): DecodedProduction[] {
  // We zoeken naar de astro-island props attribute met "productions".
  // Pakt 'm via een ruime regex en HTML-entities decoderen.
  const match = html.match(/props="([^"]+productions[^"]+)"/);
  if (!match) return [];
  let json: unknown;
  try {
    json = JSON.parse(decodeEntities(match[1]));
  } catch {
    return [];
  }
  // Top-level is een object met `[type, value]`-tuples per veld; we
  // unwrappen elk veld via een walk.
  const rootRaw = json as Record<string, unknown>;
  const prods = unwrap(rootRaw.productions);
  if (!Array.isArray(prods)) return [];
  const out: DecodedProduction[] = [];
  for (const item of prods) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Record<string, unknown>;
    const id = typeof p.id === 'string' ? p.id : null;
    const title = typeof p.title === 'string' ? p.title : null;
    const slug = typeof p.slug === 'string' ? p.slug : null;
    if (!id || !title || !slug) continue;
    // description en thumbnail
    const descObj = p.description as
      | Record<string, string | null>
      | undefined;
    const description =
      (descObj && (descObj['nl-NL'] || descObj['en-US'])) || null;
    const thumbnail = typeof p.thumbnail === 'string' ? p.thumbnail : null;
    const durationMin =
      typeof p.durationInMinutes === 'number' ? p.durationInMinutes : null;
    const screenings: DecodedProduction['screenings'] = [];
    if (Array.isArray(p.screenings)) {
      for (const sc of p.screenings) {
        if (!sc || typeof sc !== 'object') continue;
        const s = sc as Record<string, unknown>;
        const sid = typeof s.id === 'string' ? s.id : null;
        const sstart = typeof s.startAtUtc === 'string' ? s.startAtUtc : null;
        if (!sid || !sstart) continue;
        screenings.push({
          id: sid,
          startAtUtc: sstart,
          endsAtUtc: typeof s.endsAtUtc === 'string' ? s.endsAtUtc : null,
          hallName: typeof s.hallName === 'string' ? s.hallName : null,
          url:
            typeof s.url === 'string'
              ? s.url
              : `https://kassa.cinecenter.nl/#/checkout/${sid}`,
        });
      }
    }
    out.push({
      id,
      title: stripHtml(title),
      description: description ? stripHtml(description) : null,
      thumbnail,
      slug,
      durationMin,
      screenings,
    });
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

