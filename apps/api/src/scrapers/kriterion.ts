/**
 * Kriterion scraper.
 *
 * Kriterion (Roetersstraat, sinds 1945, student-run) publiceert hun
 * volledige programma op één agenda-pagina in een JSON-LD `@graph` met
 * ScreeningEvent-items. Geen sitemap-loop nodig zoals bij Eye — de
 * agenda is een single fetch.
 *
 * Plan:
 *   1. Fetch `/agenda/`.
 *   2. Parse `@graph` ScreeningEvents.
 *   3. Strip " - Filmvoorstelling" suffix uit de titel zodat
 *      cross-venue dedup met Eye werkt ("Anora" matched "Anora",
 *      niet "Anora - Filmvoorstelling").
 *   4. Event-niveau dedup op title + kind='show' + category='Film'.
 *   5. Per ScreeningEvent een occurrence upsert met venueId='kriterion'.
 *
 * Kriterion's `offers.url` heeft `/show/{id}` — stabiel als occurrence-id.
 * Geen prijs in offers (alleen priceCurrency); priceCents = null.
 * Image is een generieke logo.png — niet film-specifiek, dus skippen
 * we 'm bij nieuwe events (laten 'm null; cross-scraper kan 'm later
 * vullen).
 */

import { randomBytes } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';

const AGENDA_URL = 'https://www.kriterion.nl/agenda/';
const VENUE_ID = 'kriterion';
const UA = 'AndreasBot/1.0 (+https://andreas.amsterdam)';

export interface KriterionResult {
  venueId: 'kriterion';
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
}

interface ScreeningEventLd {
  '@type': 'ScreeningEvent';
  name: string;
  description?: string;
  startDate: string;
  endDate?: string;
  offers?: { url?: string; price?: string };
}

export async function scrapeKriterion(): Promise<KriterionResult[]> {
  const result: KriterionResult = {
    venueId: 'kriterion',
    fetched: 0,
    inserted: 0,
    occurrencesUpserted: 0,
    skipped: 0,
    errors: [],
  };

  const html = await fetchText(AGENDA_URL);
  if (!html) {
    result.errors.push('agenda fetch failed');
    return [result];
  }
  result.fetched = 1;

  const screenings = parseScreenings(html);
  const now = Date.now();
  const future = screenings.filter((s) => {
    const t = new Date(s.startDate).getTime();
    return Number.isFinite(t) && t >= now;
  });

  // Groepeer per (gestripte) titel zodat we per film één event-row
  // hebben en daar alle occurrences aan hangen. Cross-venue dedup
  // gebeurt in de event-lookup hieronder.
  const byTitle = new Map<string, ScreeningEventLd[]>();
  for (const s of future) {
    const title = cleanTitle(s.name);
    if (!title) continue;
    const arr = byTitle.get(title);
    if (arr) arr.push(s);
    else byTitle.set(title, [s]);
  }

  for (const [title, items] of byTitle) {
    try {
      // Cross-venue dedup: vind bestaand Film-event met deze titel.
      // Werkt voor Eye-films die we al hebben — Kriterion hangt z'n
      // occurrences daaraan. Anders nieuw event.
      const [existing] = await db
        .select({ id: schema.events.id })
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
      } else {
        eventId = `film-${slugify(title)}-${randomBytes(3).toString('hex')}`;
        // Kriterion's description is een sjabloon ("Filmvoorstelling van
        // X in Filmtheater Kriterion Amsterdam") — niet bruikbaar als
        // event-omschrijving. Lege description; Wikipedia-of-andere-
        // scraper kan 'm later verrijken.
        await db.insert(schema.events).values({
          id: eventId,
          venueId: VENUE_ID,
          title,
          description: null,
          kind: 'show',
          imageUrl: null,
          category: 'Film',
        });
        result.inserted += 1;
      }

      for (const s of items) {
        const showId = parseShowId(s.offers?.url);
        if (!showId) continue;
        const occId = `kriterion-show-${showId}`;
        const startsAt = new Date(s.startDate);
        if (Number.isNaN(startsAt.getTime())) continue;
        const endsAt = s.endDate ? new Date(s.endDate) : null;
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
              endsAt,
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
            priceCents: null,
            ticketUrl,
            status: 'scheduled',
          });
        }
        result.occurrencesUpserted += 1;
      }
    } catch (e) {
      result.errors.push(`${title}: ${(e as Error).message ?? String(e)}`);
    }
  }

  result.skipped = screenings.length - future.length;
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

function parseScreenings(html: string): ScreeningEventLd[] {
  const out: ScreeningEventLd[] = [];
  const re = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  for (const m of html.matchAll(re)) {
    try {
      const data = JSON.parse(m[1]);
      // Kriterion zet alles onder een `@graph`. Andere blokken zijn
      // MovieTheater/WebSite — die slaan we over.
      const graph = (data as { '@graph'?: unknown[] })['@graph'];
      const items = Array.isArray(graph)
        ? graph
        : Array.isArray(data)
          ? data
          : [data];
      for (const item of items) {
        if (
          item &&
          typeof item === 'object' &&
          (item as { '@type'?: string })['@type'] === 'ScreeningEvent' &&
          typeof (item as { name?: unknown }).name === 'string' &&
          typeof (item as { startDate?: unknown }).startDate === 'string'
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

/** Strip Kriterion's " - Filmvoorstelling"-suffix. Sommige titels hebben
    extra info in tussen-haakjes (special-screenings, vooravonden) —
    die houden we, anders matched dedup niet. */
function cleanTitle(raw: string): string {
  return raw
    .replace(/\s*[-–]\s*Filmvoorstelling\s*$/i, '')
    .trim();
}

function parseShowId(url?: string): string | null {
  if (!url) return null;
  const m = url.match(/\/show\/(\d+)/);
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
