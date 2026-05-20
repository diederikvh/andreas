/**
 * Lab111 scraper.
 *
 * Lab111 (Arie Biemondstraat). Per-film pagina's hebben een
 * `<table id="programma{n}">` met `<tr class="day">` rijen waarin
 * een ticket-link met de format `{dow} {day} {month} {HH:MM}`
 * (Nederlandse afkortingen, geen jaar). Ticketing platform
 * `tickets.lab111.nl/labcinema/.../show/{id}` — zelfde structuur als
 * Kriterion en Ketelhuis.
 *
 * Idempotency: occurrence-id = `lab111-show-{ticketing-id}`.
 */

import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';

const HOME_URL = 'https://www.lab111.nl/';
const VENUE_ID = 'lab111';
const UA = 'AndreasBot/1.0 (+https://andreas.amsterdam)';

export interface Lab111Result {
  venueId: 'lab111';
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
}

const DUTCH_DOW = new Set(['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo']);
const DUTCH_MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mrt: 2, maa: 2, apr: 3, mei: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, okt: 9, nov: 10, dec: 11,
};

export async function scrapeLab111(): Promise<Lab111Result[]> {
  const result: Lab111Result = {
    venueId: VENUE_ID,
    fetched: 0,
    inserted: 0,
    occurrencesUpserted: 0,
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
      [...home.matchAll(/href="(https:\/\/www\.lab111\.nl\/movie\/[^"#]+\/?)"/g)].map(
        (m) => m[1]
      )
    ),
  ];

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
      )
        .replace(/\s*[-–|]\s*Lab111[\s\S]*$/i, '')
        .trim();
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

      const [existing] = await db
        .select({
          id: schema.events.id,
          description: schema.events.description,
          imageUrl: schema.events.imageUrl,
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
        const patch: Record<string, string> = {};
        if (!existing.description && description) patch.description = description;
        if (
          imageUrl &&
          (!existing.imageUrl ||
            /wiki(p|m)edia\.org/.test(existing.imageUrl))
        ) {
          patch.imageUrl = imageUrl;
        }
        if (Object.keys(patch).length > 0) {
          await db
            .update(schema.events)
            .set(patch)
            .where(eq(schema.events.id, eventId));
        }
      } else {
        eventId = `film-${slugify(title)}-${randomBytes(3).toString('hex')}`;
        await db.insert(schema.events).values({
          id: eventId,
          venueId: VENUE_ID,
          title,
          description,
          kind: 'show',
          imageUrl,
          category: 'Film',
        });
        result.inserted += 1;
      }

      for (const show of shows) {
        const occId = `lab111-show-${show.id}`;
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

/** Match `<a href="...show/{id}">{dow} {day} {month} {HH:MM}</a>`.
    De link-text bevat zowel datum als tijd. */
function parseShows(html: string, nowMs: number): Show[] {
  const shows: Show[] = [];
  const re =
    /<a href="(https:\/\/tickets\.lab111\.nl\/[^"]+\/show\/(\d+))">\s*([a-z]{2})\s+(\d{1,2})\s+([a-z]{3,4})\s+(\d{1,2}):(\d{2})\s*<\/a>/gi;
  for (const m of html.matchAll(re)) {
    const ticketUrl = m[1];
    const showId = m[2];
    const dow = m[3].toLowerCase();
    if (!DUTCH_DOW.has(dow)) continue;
    const day = parseInt(m[4], 10);
    const monthIdx = DUTCH_MONTHS[m[5].toLowerCase()];
    if (monthIdx === undefined) continue;
    const hour = parseInt(m[6], 10);
    const minute = parseInt(m[7], 10);
    const startsAt = resolveDate(monthIdx, day, hour, minute, nowMs);
    if (startsAt.getTime() < nowMs - 6 * 3600 * 1000) continue;
    shows.push({ id: showId, startsAt, ticketUrl });
  }
  return shows;
}

function resolveDate(
  monthIdx: number,
  day: number,
  hour: number,
  minute: number,
  nowMs: number
): Date {
  const now = new Date(nowMs);
  let year = now.getFullYear();
  let d = new Date(year, monthIdx, day, hour, minute);
  if (d.getTime() < nowMs - 6 * 3600 * 1000) {
    year += 1;
    d = new Date(year, monthIdx, day, hour, minute);
  }
  return d;
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

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}
