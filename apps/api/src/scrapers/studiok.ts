/**
 * Studio/K scraper.
 *
 * Studio/K (Timorplein 62, Oost) — film + café-restaurant + club.
 * Per-film pagina's hebben:
 *   - JSON-LD ScreeningEvent (titel, image, description, eerste
 *     upcoming-showing)
 *   - HTML met alle screenings: `<li id="show{numericId}">` met
 *     daarin een datum-label ("vr 22 mei"), tijd-label ("11:30") en
 *     ticket-link naar `kassa.studio-k.nu/#/checkout/{uuid}`.
 *
 * De JSON-LD geeft ons maar één screening; de overige moeten we uit
 * de HTML halen. Datum is "vr 22 mei" zonder jaar — we infereren
 * 't jaar door uit te gaan van current year, en als de datum dan
 * voorbij is +1 jaar (overlap rond december/januari).
 *
 * Idempotency: occurrence-id = `studiok-show-{numericId}` uit de
 * `id="show12345"` attribuut.
 */

import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { fetchTextWithTimeout } from './_fetch.js';
import {
  findOrCreateFilmEvent,
  loadFilmDedupeMap,
  pruneStaleOccurrences,
} from './_film-dedup.js';

const AGENDA_URL = 'https://studio-k.nu/';
const VENUE_ID = 'aa-studio-k';
const UA = 'AndreasBot/1.0 (+https://andreas.amsterdam)';

export interface StudiokResult {
  venueId: 'aa-studio-k';
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
  image?: string;
  startDate: string;
}

const DUTCH_DOW = new Set([
  'ma', 'di', 'wo', 'do', 'vr', 'za', 'zo',
]);
const DUTCH_MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mrt: 2, maa: 2, apr: 3, mei: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, okt: 9, nov: 10, dec: 11,
};

export async function scrapeStudiok(): Promise<StudiokResult[]> {
  const result: StudiokResult = {
    venueId: VENUE_ID,
    fetched: 0,
    inserted: 0,
    occurrencesUpserted: 0,
    occurrencesPruned: 0,
    skipped: 0,
    errors: [],
  };

  // 1) Agenda → film-URLs.
  const agendaHtml = await fetchText(AGENDA_URL);
  if (!agendaHtml) {
    result.errors.push('agenda fetch failed');
    return [result];
  }
  const filmUrls = [
    ...new Set(
      [...agendaHtml.matchAll(/href="(https:\/\/studio-k\.nu\/film\/[^"]+)"/g)].map(
        (m) => m[1]
      )
    ),
  ];

  // Cross-venue dedupe-map: één query, daarna in-memory lookup. Shared
  // helper normaliseert suffix-varianten ((ENG SUBS), (4K), etc) zodat
  // Studio/K's "Anora (ENG SUBS)" aan Eye's bestaande "Anora" hangt.
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

      const screening = parseJsonLdScreening(html);
      const title = decodeEntities(
        (screening?.name?.trim() ||
          html.match(/<meta property="og:title"[^>]*content="([^"]+)"/)?.[1] ||
          '')
      ).replace(/\s*-\s*Studio\/K\s*$/i, '').trim();
      if (!title) {
        result.skipped += 1;
        continue;
      }
      const description = stripHtml(screening?.description ?? '') || null;
      const imageUrl = screening?.image ?? extractMeta(html, 'og:image');

      // 2) Parse HTML voor alle screenings (datum + tijd + ticket).
      // Dedup binnen één film op (startsAt + ticketUrl): Studio/K's
      // pagina toont soms dezelfde screening twee keer (in "Vandaag"
      // én "Alle voorstellingen"-widget) met verschillende show-ids.
      const rawShows = parseShowsFromHtml(html, now);
      const shows: typeof rawShows = [];
      const seenKey = new Set<string>();
      for (const s of rawShows) {
        const key = `${s.startsAt.toISOString()}|${s.ticketUrl}`;
        if (seenKey.has(key)) continue;
        seenKey.add(key);
        shows.push(s);
      }
      if (shows.length === 0) {
        result.skipped += 1;
        continue;
      }

      const { eventId, inserted } = await findOrCreateFilmEvent(dedupeMap, {
        title,
        description,
        imageUrl: imageUrl ?? null,
        venueId: VENUE_ID,
      });
      if (inserted) result.inserted += 1;

      const seenOccIds = new Set<string>();
      for (const show of shows) {
        const occId = `studiok-show-${show.id}`;
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

      // Future-occurrences van dit (event, Studio/K) die we deze run
      // niet meer zagen → opruimen. Houdt geschiedenis intact en raakt
      // andere venues niet.
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

function parseJsonLdScreening(html: string): ScreeningEventLd | null {
  const re = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  for (const m of html.matchAll(re)) {
    try {
      const data = JSON.parse(m[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const it of items) {
        if (
          it &&
          typeof it === 'object' &&
          (it as { '@type'?: string })['@type'] === 'ScreeningEvent' &&
          typeof (it as { name?: unknown }).name === 'string'
        ) {
          return it as ScreeningEventLd;
        }
      }
    } catch {
      /* skip */
    }
  }
  return null;
}

interface ParsedShow {
  id: string;
  startsAt: Date;
  ticketUrl: string;
}

/** Parse all `<li id="show{n}">` blocks. Elke block bevat:
    - `<span>{dow} {day} {month}<i></i></span>` (Nederlandse datum)
    - één of meer `<li><span class="stime">{HH:MM}</span> ...
      <a href="...kassa.studio-k.nu/#/checkout/{uuid}">` (tijden binnen
      die dag — Studio/K bundelt 11:30+19:00 op dezelfde dag onder één
      show-id wanneer ze als één programma worden verkocht). Voor onze
      occurrences hangen we per (show-id, time) een rij. */
function parseShowsFromHtml(html: string, nowMs: number): ParsedShow[] {
  const shows: ParsedShow[] = [];
  // Match `<li id="showNNNN">...next <li id="show` of einde-list.
  const blockRe = /<li id="show(\d+)">([\s\S]*?)(?=<li id="show\d+"|<\/ul><\/li>|<\/section>)/g;
  for (const block of html.matchAll(blockRe)) {
    const showNumericId = block[1];
    const body = block[2];
    const dateMatch = body.match(
      /<span>\s*([a-z]{2})\s+(\d{1,2})\s+([a-z]{3,4})\s*<i/i
    );
    if (!dateMatch) continue;
    const dow = dateMatch[1].toLowerCase();
    if (!DUTCH_DOW.has(dow)) continue;
    const day = parseInt(dateMatch[2], 10);
    const monthIdx = DUTCH_MONTHS[dateMatch[3].toLowerCase()];
    if (Number.isNaN(day) || monthIdx === undefined) continue;

    // Vind alle (tijd, ticket-URL)-paren binnen deze block.
    const timeRe =
      /<span class="stime">(\d{1,2}):(\d{2})<\/span>[\s\S]*?<a href="(https:\/\/kassa\.studio-k\.nu\/#\/checkout\/[a-f0-9-]+)"/g;
    for (const t of body.matchAll(timeRe)) {
      const hour = parseInt(t[1], 10);
      const minute = parseInt(t[2], 10);
      const ticketUrl = t[3];
      const startsAt = resolveDateTime(monthIdx, day, hour, minute, nowMs);
      // Voor occurrences met meerdere tijden op dezelfde show-id
      // maken we unique IDs door tijd-suffix toe te voegen.
      const occId =
        shows.some((s) => s.id === showNumericId)
          ? `${showNumericId}-${hour.toString().padStart(2, '0')}${minute.toString().padStart(2, '0')}`
          : showNumericId;
      shows.push({ id: occId, startsAt, ticketUrl });
    }
  }
  return shows.filter((s) => s.startsAt.getTime() >= nowMs);
}

/** "vr 22 mei" zonder jaar → Date. Pak current year; als de datum
    daardoor in 't verleden valt, +1 jaar (overlap rond Nieuwjaar). */
function resolveDateTime(
  monthIdx: number,
  day: number,
  hour: number,
  minute: number,
  nowMs: number
): Date {
  const now = new Date(nowMs);
  let year = now.getFullYear();
  let d = new Date(year, monthIdx, day, hour, minute);
  // Tolerance: 12h achter — Studio/K kan een vertoning vandaag-22:00
  // tonen wanneer 't nu 02:00 is. Niet als "vorig jaar" classen.
  if (d.getTime() < nowMs - 12 * 60 * 60 * 1000) {
    year += 1;
    d = new Date(year, monthIdx, day, hour, minute);
  }
  return d;
}

function extractMeta(html: string, property: string): string | null {
  const re = new RegExp(
    `<meta property="${property.replace(/[.*+?^${}()|[\\]/g, '\\$&')}"[^>]*content="([^"]+)"`,
    'i'
  );
  const m = html.match(re);
  return m ? decodeEntities(m[1]) : null;
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

function stripHtml(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
