/**
 * Het Ketelhuis scraper.
 *
 * Westergasfabriek, hét NL-film-podium. De /films/-index en de
 * detailpagina's zijn server-rendered en dragen hun voorstellingen in
 * JSON-LD, dus een kale fetch volstaat. Dit liep tot 13 sep 2026 via
 * Playwright; naast elkaar gelegd geeft de HTTP-versie exact dezelfde
 * 32 film-URLs en op vijf detailpagina's dezelfde JSON-LD, og:image,
 * h1 en eerste alinea.
 *
 * Plan:
 *   1. Open /films/ → 30+ film-URLs.
 *   2. Per film: JSON-LD met
 *      - 1× MovieTheater (skip)
 *      - 1× Event array met alle screenings (datetime + ticket URL)
 *      - 1× Movie/Article met description (uit `p` op page).
 *   3. Cross-venue dedup op (title, category='Film', kind='show').
 *   4. Occurrence-id = `ketelhuis-show-{ticketing-id}` (zelfde
 *      ticketing-platform als Kriterion: tickets.{venue}.nl/.../show/{id}).
 *
 * Title-cleaning: Ketelhuis suffixed soms met "(NL)" of " | 40th
 * Anniversary"-achtige labels. Voor cross-venue dedup houden we de
 * volledige titel — dat is wat de venue zelf vertoont, en die
 * onderscheidende info hoort erbij ("Top Gun | 40th Anniversary"
 * is een ander event dan de gewone "Top Gun").
 */

import { eq } from 'drizzle-orm';

import { parseFilmPage, parseFilmUrls } from './_ketelhuis-page.js';
import { db, schema } from '../db/index.js';
import {
  findOrCreateFilmEvent,
  loadFilmDedupeMap,
  pruneStaleOccurrences,
} from './_film-dedup.js';

const FILMS_INDEX_URL = 'https://www.ketelhuis.nl/films/';

async function fetchPagina(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': UA, 'accept-language': 'nl-NL' },
      signal: AbortSignal.timeout(20000),
    });
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  }
}
const VENUE_ID = 'ketelhuis';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';

export interface KetelhuisResult {
  venueId: 'ketelhuis';
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  occurrencesPruned: number;
  skipped: number;
  errors: string[];
}

interface EventLd {
  '@type': string;
  name: string;
  description?: string;
  image?: string;
  startDate?: string;
  /** Ketelhuis zet de film-pagina-URL in `url` en de ticket-URL onder
      `offers.url`. We pakken offers.url. */
  url?: string;
  offers?: {
    url?: string;
    price?: string | number;
    priceCurrency?: string;
  };
}

export async function scrapeKetelhuis(): Promise<KetelhuisResult[]> {
  const result: KetelhuisResult = {
    venueId: 'ketelhuis',
    fetched: 0,
    inserted: 0,
    occurrencesUpserted: 0,
    occurrencesPruned: 0,
    skipped: 0,
    errors: [],
  };

  // Server-rendered, dus geen browser nodig. Naast elkaar gelegd op de
  // index en vijf detailpagina's: exact dezelfde 32 URLs en dezelfde
  // JSON-LD, og:image, h1 en eerste alinea.
  const indexHtml = await fetchPagina(FILMS_INDEX_URL);
  if (!indexHtml) {
    result.errors.push('films-index niet op te halen');
    return [result];
  }
  const filmUrls = parseFilmUrls(indexHtml);
  {

    const dedupeMap = await loadFilmDedupeMap();
    const now = Date.now();
    for (const filmUrl of filmUrls) {
      try {
        const filmHtml = await fetchPagina(
          filmUrl.startsWith('http') ? filmUrl : `https://www.ketelhuis.nl${filmUrl}`
        );
        if (!filmHtml) { result.skipped += 1; continue; }
        result.fetched += 1;

        const data = parseFilmPage(filmHtml);

        // Parse alle Event-items uit JSON-LD; ze hebben name (filmtitel),
        // startDate (ISO), description, image. Verzamel uniques per
        // ticket-show-id zodat dezelfde voorstelling niet dubbel telt.
        const events: EventLd[] = [];
        for (const raw of data.blocks) {
          try {
            const parsed = JSON.parse(raw);
            const items = Array.isArray(parsed) ? parsed : [parsed];
            for (const it of items) {
              if (
                it &&
                typeof it === 'object' &&
                (it as { '@type'?: string })['@type'] === 'Event'
              ) {
                events.push(it as EventLd);
              }
            }
          } catch {
            /* skip */
          }
        }

        if (events.length === 0) {
          result.skipped += 1;
          continue;
        }

        const title = decodeEntities(
          (events[0].name?.trim() || data.titleH1?.trim() || '')
        ).trim();
        if (!title) {
          result.skipped += 1;
          continue;
        }
        const description =
          events[0].description?.trim() || data.descP || null;
        const imageUrl = events[0].image?.trim() || data.ogImage || null;

        // Filter op toekomstige screenings.
        const future = events.filter((e) => {
          if (!e.startDate) return false;
          const t = new Date(fixIsoTimezone(e.startDate)).getTime();
          return Number.isFinite(t) && t >= now;
        });
        if (future.length === 0) {
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

        // Dedup per ticket-show-id zodat Ketelhuis' meerdere JSON-LD
        // entries voor dezelfde voorstelling niet leiden tot dubbele
        // occurrence-upserts.
        const seenShowIds = new Set<string>();
        const seenOccIds = new Set<string>();
        for (const e of future) {
          const ticketUrl = e.offers?.url ?? null;
          const showId = parseShowId(ticketUrl ?? undefined);
          if (!showId || seenShowIds.has(showId)) continue;
          seenShowIds.add(showId);
          const occId = `ketelhuis-show-${showId}`;
          seenOccIds.add(occId);
          const startsAt = new Date(fixIsoTimezone(e.startDate!));
          if (Number.isNaN(startsAt.getTime())) continue;
          const priceCents =
            e.offers?.price != null
              ? Math.round(parseFloat(String(e.offers.price)) * 100)
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
                ticketUrl,
                priceCents: priceCents,
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
  }

  return [result];
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** Ketelhuis schrijft soms `+1:00` i.p.v. `+01:00` — JS Date faalt dan. */
/**
 * Ketelhuis publiceert in JSON-LD een wall-time in UTC maar tagged
 * 'm met een broken `+1:00`-offset (zonder leading-zero) — bv
 * `"2026-06-11T08:45:00+1:00"` voor een vertoning die op de website
 * als `10:45` getoond wordt. Naïef gefixt naar `+01:00` zou JS er
 * 09:45 Ams van maken — 1u te vroeg. De wall-time IS dus UTC; de
 * offset-tag liegt. Strip 'm en behandel als Z.
 */
function fixIsoTimezone(s: string): string {
  // Naive trailing `+1:00`/`+01:00` weghalen, vervangen door 'Z' zodat
  // JS de tijd correct als UTC interpreteert. Zonder Z zou Node het
  // als host-local lezen (= UTC in Fly = correct, maar fragiel).
  return s.replace(/[+-]\d{1,2}:?\d{2}$/, 'Z');
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

function parseShowId(url?: string): string | null {
  if (!url) return null;
  const m = url.match(/\/show\/(\d+)/);
  return m ? m[1] : null;
}

