/**
 * Rialto scraper.
 *
 * Rialto Ceintuurbaan (De Pijp) + Rialto VU (campus VU, Zuid).
 * Per-occurrence wordt de juiste venue gekoppeld via de location-param
 * in de ticket-URL: "Rialto De Pijp" → venue `rialto`, "Rialto VU"
 * → venue `rialto-vu`. Event.venueId is altijd de primary (rialto);
 * occurrence.venueId reflecteert de daadwerkelijke locatie.
 *
 * Pagina /agenda heeft server-side rendered ticket-URLs met inline
 * metadata:
 *
 *   /nl/films/{filmId}/{slug}?location={loc}&date={YYYY-MM-DD}&time={HH:MM}
 *
 * Geen JSON-LD, geen API endpoint. Alle data zit in deze URLs.
 *
 * Plan:
 *   1. Fetch /agenda + komende 13 dagen (14 totaal) → ticket-URLs.
 *   2. Per unieke film-id: fetch /nl/films/{id}/{slug} voor og:title,
 *      og:description, og:image.
 *   3. Per ticket-URL: maak occurrence met juiste venueId per locatie.
 *
 * Idempotency: occurrence-id = `rialto-${filmId}-${YYYYMMDD}-${HHMM}`.
 */

import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';

const PRIMARY_VENUE_ID = 'rialto';
const VU_VENUE_ID = 'rialto-vu';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const DAYS_AHEAD = 14;

export interface RialtoResult {
  venueId: 'rialto';
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
}

/** Vertaal location-string uit ticket-URL naar onze venue-id. */
function venueIdForLocation(loc: string): string {
  const l = loc.toLowerCase();
  if (l.includes('vu')) return VU_VENUE_ID;
  return PRIMARY_VENUE_ID;
}

interface TicketUrl {
  filmId: string;
  slug: string;
  location: string;
  date: string;
  time: string;
  href: string;
}

export async function scrapeRialto(): Promise<RialtoResult[]> {
  const result: RialtoResult = {
    venueId: PRIMARY_VENUE_ID,
    fetched: 0,
    inserted: 0,
    occurrencesUpserted: 0,
    skipped: 0,
    errors: [],
  };

  // 1) Verzamel ticket-URLs over komende 14 dagen.
  const allTickets: TicketUrl[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 0; i < DAYS_AHEAD; i += 1) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const url = i === 0
      ? 'https://rialtofilm.nl/agenda'
      : `https://rialtofilm.nl/agenda?date=${dateStr}`;
    const html = await fetchText(url);
    if (!html) continue;
    for (const t of parseTickets(html)) {
      allTickets.push(t);
    }
  }

  // Dedup op (filmId, date, time, location).
  const seen = new Set<string>();
  const unique = allTickets.filter((t) => {
    const k = `${t.filmId}|${t.date}|${t.time}|${t.location}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // 2) Per unieke filmId: één fetch voor metadata.
  const filmIds = [...new Set(unique.map((t) => t.filmId))];
  const filmMeta = new Map<
    string,
    { title: string; description: string | null; imageUrl: string | null }
  >();
  for (const t of unique) {
    if (filmMeta.has(t.filmId)) continue;
    const url = `https://rialtofilm.nl/nl/films/${t.filmId}/${t.slug}`;
    const html = await fetchText(url);
    result.fetched += 1;
    if (!html) continue;
    const title = decodeEntities(
      (html.match(/<meta property="og:title"[^>]*content="([^"]+)"/)?.[1] ?? '').trim()
    ).replace(/\s+/g, ' ');
    if (!title) continue;
    const description =
      decodeEntities(
        (html.match(/<meta property="og:description"[^>]*content="([^"]+)"/)?.[1] ?? '').trim()
      ) || null;
    const imageUrl =
      html.match(/<meta property="og:image"[^>]*content="([^"]+)"/)?.[1] || null;
    filmMeta.set(t.filmId, { title, description, imageUrl });
  }

  // 3) Maak per ticket een occurrence.
  const eventByFilmId = new Map<string, string>();
  const nowMs = Date.now();
  for (const t of unique) {
    try {
      const meta = filmMeta.get(t.filmId);
      if (!meta) continue;

      // Event-id reuse binnen deze scrape-run zodat we niet N× per film
      // de bestaande-event-lookup hoeven te doen.
      let eventId = eventByFilmId.get(t.filmId);
      if (!eventId) {
        const [existing] = await db
          .select({
            id: schema.events.id,
            description: schema.events.description,
            imageUrl: schema.events.imageUrl,
          })
          .from(schema.events)
          .where(
            and(
              eq(schema.events.title, meta.title),
              eq(schema.events.category, 'Film'),
              eq(schema.events.kind, 'show')
            )
          )
          .limit(1);

        if (existing) {
          eventId = existing.id;
          const patch: Record<string, string> = {};
          if (!existing.description && meta.description) patch.description = meta.description;
          if (
            meta.imageUrl &&
            (!existing.imageUrl ||
              /wiki(p|m)edia\.org/.test(existing.imageUrl))
          ) {
            patch.imageUrl = meta.imageUrl;
          }
          if (Object.keys(patch).length > 0) {
            await db
              .update(schema.events)
              .set(patch)
              .where(eq(schema.events.id, eventId));
          }
        } else {
          eventId = `film-${slugify(meta.title)}-${randomBytes(3).toString('hex')}`;
          await db.insert(schema.events).values({
            id: eventId,
            venueId: PRIMARY_VENUE_ID,
            title: meta.title,
            description: meta.description,
            kind: 'show',
            imageUrl: meta.imageUrl,
            category: 'Film',
          });
          result.inserted += 1;
        }
        eventByFilmId.set(t.filmId, eventId);
      }

      const startsAt = new Date(`${t.date}T${t.time}:00`);
      if (Number.isNaN(startsAt.getTime()) || startsAt.getTime() < nowMs - 6 * 3600 * 1000) {
        continue;
      }
      const occId = `rialto-${t.filmId}-${t.date.replace(/-/g, '')}-${t.time.replace(':', '')}`;
      const occVenueId = venueIdForLocation(t.location);
      // Voor De Pijp houden we 'm in 't room-veld als hall-label
      // (verkoopapparaat onderscheidt zalen niet apart). Voor VU laten
      // we room leeg — de venue-naam is al duidelijk.
      const room = occVenueId === PRIMARY_VENUE_ID ? null : null;
      const ticketUrl = t.href;

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
            venueId: occVenueId,
            eventId,
          })
          .where(eq(schema.occurrences.id, occId));
      } else {
        await db.insert(schema.occurrences).values({
          id: occId,
          eventId,
          venueId: occVenueId,
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
        `${t.filmId}/${t.date}: ${(e as Error).message ?? String(e)}`
      );
    }
  }
  result.skipped = filmIds.length - filmMeta.size;
  return [result];
}

/** Parse alle ticket-URLs uit agenda HTML. */
function parseTickets(html: string): TicketUrl[] {
  const out: TicketUrl[] = [];
  const re =
    /href="https:\/\/rialtofilm\.nl\/nl\/films\/(\d+)\/([^"?]+)\?location=([^"&]+)&amp;date=(\d{4}-\d{2}-\d{2})&amp;time=(\d{2}:\d{2})"/g;
  for (const m of html.matchAll(re)) {
    out.push({
      filmId: m[1],
      slug: m[2],
      location: decodeURIComponent(m[3].replace(/\+/g, ' ')),
      date: m[4],
      time: m[5],
      href: `https://rialtofilm.nl/nl/films/${m[1]}/${m[2]}?location=${m[3]}&date=${m[4]}&time=${m[5]}`,
    });
  }
  return out;
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
