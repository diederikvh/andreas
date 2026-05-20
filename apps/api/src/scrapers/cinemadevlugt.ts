/**
 * Cinema De Vlugt scraper.
 *
 * De Vlugt (Slotermeer, twee zalen). Per-film pagina heeft een
 * `<ul id="tickets">` met `<li class="mobile1">`/`<li class="desktop1">`
 * paren (dezelfde screening 2× — eentje voor mobile, eentje voor
 * desktop weergave). Per `<li>`: date "Za 23-05-2026", time "13:00",
 * hall, ticket-URL naar tickets.cinemadevlugt.nl/.../show/{id}.
 *
 * Idempotency: occurrence-id = `vlugt-show-{ticketing-id}`.
 */

import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';

const HOME_URL = 'https://www.cinemadevlugt.nl/';
const VENUE_ID = 'cinema-de-vlugt';
const UA = 'AndreasBot/1.0 (+https://andreas.amsterdam)';

export interface CinemaDeVlugtResult {
  venueId: 'cinema-de-vlugt';
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
}

export async function scrapeCinemaDeVlugt(): Promise<CinemaDeVlugtResult[]> {
  const result: CinemaDeVlugtResult = {
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
      [...home.matchAll(/href="(https:\/\/www\.cinemadevlugt\.nl\/film\/[^"#]+\/?)"/g)].map(
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
        .replace(/\s*[-–]\s*Cinema de Vlugt\s*$/i, '')
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
        const occId = `vlugt-show-${show.id}`;
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
              room: show.room,
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
            room: show.room,
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
  room: string | null;
}

/** Parse `<ul id="tickets">` block — per show heeft de mobile + desktop
    variant dezelfde show-id, dus we dedupen op die id. Datum is in
    Nederlandse short-form "Za 23-05-2026". */
function parseShows(html: string, nowMs: number): Show[] {
  const m = html.match(/<ul id="tickets"[^>]*>([\s\S]*?)<\/ul>/);
  if (!m) return [];
  const content = m[1];
  const shows: Show[] = [];
  const seen = new Set<string>();
  // Per <li>: pak datum, tijd, zaal, ticket-URL.
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/g;
  for (const li of content.matchAll(liRe)) {
    const body = li[1];
    const dateMatch = body.match(/class="date"[^>]*>([^<]+)</);
    // <p class="time"><i class="..."></i>13:00</p> — pak de tijd na </i>.
    const timeMatch = body.match(/class="time"[\s\S]*?<\/i>\s*(\d{1,2}):(\d{2})/);
    const zaalMatch = body.match(/class="zaal"[^>]*>(?:<strong>[^<]+<\/strong>)?([^<]+)</);
    const ticketMatch = body.match(
      /href="(https:\/\/tickets\.cinemadevlugt\.nl\/[^"]*\/show\/(\d+))"/
    );
    if (!dateMatch || !timeMatch || !ticketMatch) continue;
    const showId = ticketMatch[2];
    if (seen.has(showId)) continue;
    seen.add(showId);
    const dateRaw = dateMatch[1].replace(/&nbsp;/g, ' ').trim();
    const dmMatch = dateRaw.match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
    if (!dmMatch) continue;
    const day = parseInt(dmMatch[1], 10);
    const month = parseInt(dmMatch[2], 10) - 1;
    const year = parseInt(dmMatch[3], 10);
    const hour = parseInt(timeMatch[1], 10);
    const minute = parseInt(timeMatch[2], 10);
    const startsAt = new Date(year, month, day, hour, minute);
    if (startsAt.getTime() < nowMs - 6 * 3600 * 1000) continue;
    shows.push({
      id: showId,
      startsAt,
      ticketUrl: ticketMatch[1],
      room: zaalMatch?.[1]?.trim() || null,
    });
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

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}
