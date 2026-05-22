/**
 * Cinema The Pulse scraper.
 *
 * Webflow + FilmGenie. De homepage rendert pas client-side haar
 * volledige programma (Finsweet `fs-list-load="all"` paged door
 * Webflow CMS). We hebben Playwright nodig — eenmaal in-page haalt
 * 't ~267 screening-items op verspreid over ~8 dagen.
 *
 * Per item in `.home_shows_item`:
 *   - .program-ref         = "{uuid}_{title}" (slug voor film-page)
 *   - .shows-date          = "DD/M/YYYY"
 *   - .shows-time          = "HH:MM"
 *   - .shows-hall-number   = "Cinema 3"
 *   - .shows-item-title h3 = filmtitel
 *   - .home_shows_genre_string = comma-separated genres
 *   - shows-time-container[id] = screening-UUID (occurrence-id)
 *
 * Film-pagina's `/films/{program-ref}` hebben og:title/description/
 * image — die fetchen we via gewone HTTP (geen Playwright nodig per
 * film-page).
 *
 * Idempotency: occurrence-id = `thepulse-show-{screening-uuid}`.
 */

import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import {
  findOrCreateFilmEvent,
  loadFilmDedupeMap,
  pruneStaleOccurrences,
} from './_film-dedup.js';

const HOME_URL = 'https://www.cinemathepulse.com/';
const VENUE_ID = 'cinema-the-pulse';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

export interface ThePulseResult {
  venueId: 'cinema-the-pulse';
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  occurrencesPruned: number;
  skipped: number;
  errors: string[];
}

interface PulseItem {
  programRef: string;
  title: string;
  date: string; // "DD/M/YYYY"
  time: string; // "HH:MM"
  hall: string | null;
  screeningId: string;
  genres: string[];
}

export async function scrapeThePulse(): Promise<ThePulseResult[]> {
  const result: ThePulseResult = {
    venueId: VENUE_ID,
    fetched: 0,
    inserted: 0,
    occurrencesUpserted: 0,
    occurrencesPruned: 0,
    skipped: 0,
    errors: [],
  };

  let items: PulseItem[] = [];
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ userAgent: UA, locale: 'nl-NL' });
    const page = await ctx.newPage();
    await page.goto(HOME_URL, { waitUntil: 'networkidle', timeout: 45000 });
    // Finsweet's `fs-list-load="all"` paged loading — geef 't even tijd
    // om alle items binnen te halen.
    await page.waitForTimeout(8000);

    const raw = (await page.evaluate(`(() => {
      const out = [];
      const items = document.querySelectorAll('.home_shows_item');
      for (const item of items) {
        const programRef = item.querySelector('.program-ref')?.textContent?.trim() || '';
        const title = item.querySelector('.shows-item-title')?.textContent?.trim() || '';
        const date = item.querySelector('.shows-date')?.textContent?.trim() || '';
        // Pak alleen de eerste shows-time-container met een id (de
        // andere zijn invisible-template-placeholders).
        const tc = [...item.querySelectorAll('.shows-time-container')]
          .find(el => el.id && el.id.length === 36);
        const screeningId = tc?.id || '';
        const time = tc?.querySelector('.shows-time')?.textContent?.trim() || '';
        const hall = item.querySelector('.shows-hall-number')?.textContent?.trim() || null;
        const genres = [...item.querySelectorAll('.home_shows_genre_list .genre-item')]
          .map(el => el.textContent?.trim())
          .filter(Boolean);
        if (programRef && title && date && time && screeningId) {
          out.push({ programRef, title, date, time, hall, screeningId, genres });
        }
      }
      return out;
    })()`)) as PulseItem[];
    items = raw;
  } finally {
    await browser.close();
  }

  if (items.length === 0) {
    result.errors.push('no items rendered');
    return [result];
  }

  // Groepeer per program-ref voor metadata-fetch.
  const byRef = new Map<string, PulseItem[]>();
  for (const it of items) {
    const list = byRef.get(it.programRef);
    if (list) list.push(it);
    else byRef.set(it.programRef, [it]);
  }

  // Per unieke film: één fetch voor og:title/description/image.
  const filmMeta = new Map<
    string,
    { title: string; description: string | null; imageUrl: string | null }
  >();
  for (const [ref, list] of byRef) {
    result.fetched += 1;
    const html = await fetchText(`https://www.cinemathepulse.com/films/${ref}`);
    if (!html) {
      // Fallback: gebruik de titel uit het listing-item.
      filmMeta.set(ref, {
        title: list[0].title,
        description: null,
        imageUrl: null,
      });
      continue;
    }
    const ogTitle = decodeEntities(
      (html.match(/<meta property="og:title"[^>]*content="([^"]+)"/)?.[1] ?? '').trim()
    ).replace(/\s+\|\s+Cinema The Pulse\s*$/i, '').trim();
    const title = ogTitle || list[0].title;
    const description =
      decodeEntities(
        (html.match(/<meta property="og:description"[^>]*content="([^"]+)"/)?.[1] ?? '').trim()
      ) || null;
    const imageUrl =
      html.match(/<meta property="og:image"[^>]*content="([^"]+)"/)?.[1] || null;
    filmMeta.set(ref, { title, description, imageUrl });
  }

  const dedupeMap = await loadFilmDedupeMap();
  const nowMs = Date.now();
  const eventByRef = new Map<string, string>();
  const seenByEventId = new Map<string, Set<string>>();
  for (const it of items) {
    try {
      const meta = filmMeta.get(it.programRef);
      if (!meta) continue;
      const startsAt = parseDateTime(it.date, it.time);
      if (!startsAt || startsAt.getTime() < nowMs - 6 * 3600 * 1000) continue;

      let eventId = eventByRef.get(it.programRef);
      if (!eventId) {
        const r = await findOrCreateFilmEvent(dedupeMap, {
          title: meta.title,
          description: meta.description,
          imageUrl: meta.imageUrl,
          venueId: VENUE_ID,
        });
        eventId = r.eventId;
        if (r.inserted) result.inserted += 1;
        eventByRef.set(it.programRef, eventId);
      }

      const occId = `thepulse-show-${it.screeningId}`;
      let seenSet = seenByEventId.get(eventId);
      if (!seenSet) {
        seenSet = new Set();
        seenByEventId.set(eventId, seenSet);
      }
      seenSet.add(occId);
      const room = it.hall;
      const ticketUrl = `https://www.cinemathepulse.com/films/${it.programRef}`;

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
          priceCents: null,
          ticketUrl,
          room,
          status: 'scheduled',
        });
      }
      result.occurrencesUpserted += 1;
    } catch (e) {
      result.errors.push(
        `${it.programRef} ${it.date} ${it.time}: ${(e as Error).message ?? String(e)}`
      );
    }
  }
  result.skipped = items.length - result.occurrencesUpserted;

  for (const [eventId, seenOccIds] of seenByEventId) {
    result.occurrencesPruned += await pruneStaleOccurrences({
      eventId,
      venueId: VENUE_ID,
      seenOccIds,
      nowMs,
    });
  }
  return [result];
}

/** "DD/M/YYYY" + "HH:MM" → Date in lokale tijd. */
function parseDateTime(date: string, time: string): Date | null {
  const dm = date.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const tm = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!dm || !tm) return null;
  const day = parseInt(dm[1], 10);
  const month = parseInt(dm[2], 10) - 1;
  const year = parseInt(dm[3], 10);
  const hour = parseInt(tm[1], 10);
  const minute = parseInt(tm[2], 10);
  const d = new Date(year, month, day, hour, minute);
  return Number.isNaN(d.getTime()) ? null : d;
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

