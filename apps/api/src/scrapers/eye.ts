/**
 * Eye Filmmuseum scraper.
 *
 * Eye serveert per film-pagina een `application/ld+json`-array met alle
 * ScreeningEvents (alle voorstellingen van die film, ook andere data).
 * Plan:
 *   1. Sitemap-index → laatste N show-sitemaps (oplopend genummerd).
 *   2. Unieke film-URLs verzamelen (strip `?show=` query).
 *   3. Per film: fetch HTML, parse JSON-LD ScreeningEvent[].
 *   4. Event-niveau: dedup op title + `kind='show'` + `category='Film'`.
 *      Dezelfde "Anora"-film die later ook door bv. Kriterion gescraped
 *      wordt vindt deze event en hangt zijn eigen venue-occurrences eraan.
 *   5. Per ScreeningEvent: occurrence upsert met `venueId='eye'`.
 *
 * Films draaien typisch op meerdere bioscopen. We zetten de venue daarom
 * op occurrence-niveau (slice 1 van het film-aware schema). Het event
 * blijft één rij; occurrences spreiden zich over venues.
 */

import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { fetchTextWithTimeout } from './_fetch.js';
import {
  findOrCreateFilmEvent,
  loadFilmDedupeMap,
  pruneStaleOccurrences,
} from './_film-dedup.js';

const SITEMAP_INDEX = 'https://www.eyefilm.nl/sitemap.xml';
const VENUE_ID = 'eye';
// Hoeveel show-sitemaps van achteren oppakken. Elke sitemap dekt ~100
// shows; 5 = ~500 recente screenings, dik voldoende voor komende weken.
const RECENT_SHOW_SITEMAPS = 5;
const UA = 'AndreasBot/1.0 (+https://andreas.amsterdam)';

export interface EyeResult {
  venueId: 'eye';
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  occurrencesPruned: number;
  skipped: number;
  errors: string[];
}

interface ScreeningEventLd {
  '@type': 'ScreeningEvent';
  name: string;
  description?: string;
  startDate: string;
  offers?: { url?: string; price?: string; priceCurrency?: string };
}

export async function scrapeEye(): Promise<EyeResult[]> {
  const result: EyeResult = {
    venueId: 'eye',
    fetched: 0,
    inserted: 0,
    occurrencesUpserted: 0,
    occurrencesPruned: 0,
    skipped: 0,
    errors: [],
  };

  // 1) Sitemap-index → show-sitemap-URLs.
  const idx = await fetchText(SITEMAP_INDEX);
  if (!idx) {
    result.errors.push('sitemap-index fetch failed');
    return [result];
  }
  const showSitemaps = [
    ...idx.matchAll(/<loc>([^<]*sitemap\/show_\d+\.xml)<\/loc>/g),
  ]
    .map((m) => m[1])
    // Numeriek sorteren op het show-getal — lexical sort plakt show_99
    // achter show_98 maar vóór show_100, terwijl chronologisch oplopend
    // (show_1, show_2, …, show_351) wat we willen voor "recent".
    .sort((a, b) => {
      const na = Number(a.match(/show_(\d+)\.xml$/)?.[1] ?? 0);
      const nb = Number(b.match(/show_(\d+)\.xml$/)?.[1] ?? 0);
      return na - nb;
    });
  if (showSitemaps.length === 0) {
    result.errors.push('no show sitemaps in index');
    return [result];
  }
  const recent = showSitemaps.slice(-RECENT_SHOW_SITEMAPS);

  // 2) Unieke film-URLs uit recente show-sitemaps.
  const filmUrls = new Set<string>();
  for (const url of recent) {
    const xml = await fetchText(url);
    if (!xml) continue;
    for (const m of xml.matchAll(/<loc>([^<]+\/whats-on\/[^<]+)<\/loc>/g)) {
      const stripped = m[1].split('?')[0];
      filmUrls.add(stripped);
    }
  }

  // 3) Per film: fetch + JSON-LD parse.
  // Cross-venue dedupe-map: één query, daarna in-memory lookup. Shared
  // helper normaliseert suffix-varianten ((ENG subs), (4K), etc).
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

      const screenings = parseJsonLdScreenings(html);
      const future = screenings.filter(
        (s) => new Date(s.startDate).getTime() >= now
      );
      if (future.length === 0) {
        result.skipped += 1;
        continue;
      }

      const title = future[0].name.trim();
      if (!title) {
        result.skipped += 1;
        continue;
      }
      const description = future[0].description?.trim() || null;
      const ogImage = extractMeta(html, 'og:image');

      // 4) Cross-venue dedup via shared helper — normaliseert
      //    suffix-varianten zodat "Anora" en "Anora (4K)" matchen.
      const { eventId, inserted } = await findOrCreateFilmEvent(dedupeMap, {
        title,
        description,
        imageUrl: ogImage,
        venueId: VENUE_ID,
      });
      if (inserted) result.inserted += 1;

      // 5) Occurrences upsert. Eye's `show`-ID uit de ticket-URL is
      //    stabiel — gebruik 't als deterministische occurrence-id zodat
      //    re-scrapes idempotent zijn.
      const seenOccIds = new Set<string>();
      for (const s of future) {
        const showId = parseShowId(s.offers?.url);
        if (!showId) continue;
        const occId = `eye-show-${showId}`;
        seenOccIds.add(occId);
        const startsAt = new Date(s.startDate);
        if (Number.isNaN(startsAt.getTime())) continue;
        const priceCents = parsePriceCents(s.offers?.price);
        const ticketUrl = s.offers?.url ?? null;

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

function parseJsonLdScreenings(html: string): ScreeningEventLd[] {
  const out: ScreeningEventLd[] = [];
  // De `s`-flag matched newlines binnen het JSON-blok.
  const re = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  for (const m of html.matchAll(re)) {
    try {
      const data = JSON.parse(m[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (
          item &&
          item['@type'] === 'ScreeningEvent' &&
          typeof item.name === 'string' &&
          typeof item.startDate === 'string'
        ) {
          out.push(item as ScreeningEventLd);
        }
      }
    } catch {
      /* skip kapotte JSON-LD blokken */
    }
  }
  return out;
}

function extractMeta(html: string, property: string): string | null {
  const re = new RegExp(
    `<meta property="${escapeRegex(property)}"[^>]*content="([^"]+)"`,
    'i'
  );
  const m = html.match(re);
  return m ? decodeEntities(m[1]) : null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function parseShowId(url?: string): string | null {
  if (!url) return null;
  const m = url.match(/[?&]show=(\d+)/);
  return m ? m[1] : null;
}

function parsePriceCents(p?: string): number | null {
  if (!p) return null;
  // Eye rapporteert in JSON-LD `offers.price` al in cents (bv. "1250.00"
  // = €12.50, niet €1250). Detecteer: als de waarde >= 100 (= ≥ €1.00
  // in cents) plus integer-deel >= 100 → al cents. Andere filmhuizen
  // gebruiken typically de standaard schema.org-conventie (euros). We
  // pakken hier de Eye-conventie en passen 't later aan als nodig.
  const n = parseFloat(p);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

