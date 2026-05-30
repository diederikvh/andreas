/**
 * Filmhuis Cavia scraper.
 *
 * Klein Cavia is een vrijwilligers-gerund filmhuis aan de Van
 * Hallstraat. De programma-pagina's zijn per maand: `/programma/
 * {nl-maand}-{jaar}`. We pakken de current + volgende paar maanden;
 * niet-bestaande maanden geven 404 en worden geskipt.
 *
 * Per maand-pagina:
 *   - Events worden gescheiden door `<hr id="{anchor}" />`.
 *   - Elke event-block start met `<p>...<strong>{date+time}</strong>...</p>`
 *     gevolgd door optioneel `<h3>{series}</h3>` dan `<h2>{title}</h2>`,
 *     description-paragrafen, eventueel ticket-link naar
 *     `amsterdamalternative.nl/tickets/{id}` of `/agenda/{id}`.
 *
 * Idempotency: occurrence-id = `cavia-{anchor}-{YYYYMMDD-HHMM}`.
 * Cavia heeft geen vaste numerieke show-id — anchor + datetime is
 * stabiel genoeg.
 */

import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { parseAmsterdamLocal } from './_amsterdam-tz.js';
import { fetchTextWithTimeout } from './_fetch.js';
import {
  findOrCreateFilmEvent,
  loadFilmDedupeMap,
  pruneStaleOccurrences,
} from './_film-dedup.js';

const VENUE_ID = 'cavia';
const UA = 'AndreasBot/1.0 (+https://andreas.amsterdam)';
const MONTHS_AHEAD = 3;

const NL_MONTHS = [
  'januari', 'februari', 'maart', 'april', 'mei', 'juni',
  'juli', 'augustus', 'september', 'oktober', 'november', 'december',
];
const NL_MONTH_INDEX: Record<string, number> = Object.fromEntries(
  NL_MONTHS.map((m, i) => [m, i])
);

export interface CaviaResult {
  venueId: 'cavia';
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  occurrencesPruned: number;
  skipped: number;
  errors: string[];
}

export async function scrapeCavia(): Promise<CaviaResult[]> {
  const result: CaviaResult = {
    venueId: VENUE_ID,
    fetched: 0,
    inserted: 0,
    occurrencesUpserted: 0,
    occurrencesPruned: 0,
    skipped: 0,
    errors: [],
  };

  // Verzamel pagina's voor huidige + komende maanden.
  const now = new Date();
  const monthUrls: Array<{ url: string; monthIdx: number; year: number }> = [];
  for (let i = 0; i < MONTHS_AHEAD; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    monthUrls.push({
      url: `https://www.filmhuiscavia.nl/programma/${NL_MONTHS[d.getMonth()]}-${d.getFullYear()}`,
      monthIdx: d.getMonth(),
      year: d.getFullYear(),
    });
  }

  const dedupeMap = await loadFilmDedupeMap();
  // Per-event seen-occurrence-set verzamelen over alle maanden — een
  // Cavia-film kan in mei én juni draaien. pruneStaleOccurrences pas
  // aan 't eind van de hele run, anders zou de juni-pas mei-occs
  // weggooien (en vice versa).
  const seenByEventId = new Map<string, Set<string>>();

  const nowMs = Date.now();
  for (const m of monthUrls) {
    const html = await fetchText(m.url);
    if (!html) {
      // Maand bestaat nog niet — niet als error markeren.
      continue;
    }
    result.fetched += 1;
    const events = parseMonth(html, m.year);
    for (const ev of events) {
      try {
        if (!ev.title || !ev.startsAt) {
          result.skipped += 1;
          continue;
        }
        if (ev.startsAt.getTime() < nowMs - 6 * 3600 * 1000) {
          result.skipped += 1;
          continue;
        }

        const { eventId, inserted } = await findOrCreateFilmEvent(dedupeMap, {
          title: ev.title,
          description: ev.description,
          imageUrl: ev.imageUrl,
          venueId: VENUE_ID,
        });
        if (inserted) result.inserted += 1;

        const dateStr = `${ev.startsAt.getFullYear()}${String(ev.startsAt.getMonth() + 1).padStart(2, '0')}${String(ev.startsAt.getDate()).padStart(2, '0')}`;
        const timeStr = `${String(ev.startsAt.getHours()).padStart(2, '0')}${String(ev.startsAt.getMinutes()).padStart(2, '0')}`;
        const occId = `cavia-${ev.anchor}-${dateStr}-${timeStr}`;
        let seenSet = seenByEventId.get(eventId);
        if (!seenSet) {
          seenSet = new Set();
          seenByEventId.set(eventId, seenSet);
        }
        seenSet.add(occId);

        const [existingOcc] = await db
          .select({ id: schema.occurrences.id })
          .from(schema.occurrences)
          .where(eq(schema.occurrences.id, occId))
          .limit(1);

        if (existingOcc) {
          await db
            .update(schema.occurrences)
            .set({
              startsAt: ev.startsAt,
              endsAt: ev.endsAt,
              ticketUrl: ev.ticketUrl,
              venueId: VENUE_ID,
              eventId,
            })
            .where(eq(schema.occurrences.id, occId));
        } else {
          await db.insert(schema.occurrences).values({
            id: occId,
            eventId,
            venueId: VENUE_ID,
            startsAt: ev.startsAt,
            endsAt: ev.endsAt,
            priceCents: null,
            ticketUrl: ev.ticketUrl,
            status: 'scheduled',
          });
        }
        result.occurrencesUpserted += 1;
      } catch (e) {
        result.errors.push(
          `${ev.title || ev.anchor}: ${(e as Error).message ?? String(e)}`
        );
      }
    }
  }

  // Stale-occurrence cleanup voor elke unieke Cavia-event die we deze
  // run gezien hebben. Doen we pas hier omdat een film in meerdere
  // maand-pagina's kan voorkomen.
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

interface ParsedEvent {
  anchor: string;
  title: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  description: string | null;
  imageUrl: string | null;
  ticketUrl: string | null;
}

function parseMonth(html: string, year: number): ParsedEvent[] {
  // Pak alle `<hr id="..." />` als event-delimiters, en de body tussen
  // de huidige hr en de volgende (of einde document) is de event-block.
  const out: ParsedEvent[] = [];
  const hrRe = /<hr id="([a-z0-9-]+)"\s*\/>/g;
  const matches = [...html.matchAll(hrRe)];
  for (let i = 0; i < matches.length; i += 1) {
    const m = matches[i];
    const anchor = m[1];
    const start = m.index! + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : html.length;
    const block = html.slice(start, end);
    out.push(parseEventBlock(block, anchor, year));
  }
  return out;
}

function parseEventBlock(block: string, anchor: string, year: number): ParsedEvent {
  // Date + time uit eerste <strong>{dow} {day} {month}[, {time}[- {time}]]</strong>.
  const dateMatch = block.match(
    /<strong>\s*([A-Z][a-z]+(?:dag)?)\s+(\d{1,2})\s+([a-z]+)\s*(?:,\s*(\d{1,2}:\d{2})(?:\s*-\s*(\d{1,2}:\d{2}))?)?\s*(?:&nbsp;)?\s*<\/strong>/i
  );
  let startsAt: Date | null = null;
  let endsAt: Date | null = null;
  if (dateMatch) {
    const day = parseInt(dateMatch[2], 10);
    const monthName = dateMatch[3].toLowerCase();
    const monthIdx = NL_MONTH_INDEX[monthName];
    if (monthIdx !== undefined) {
      const [sh, sm] = (dateMatch[4] ?? '20:30').split(':').map(Number);
      // Amsterdam-local Date — host-TZ in Fly UTC zou +2u verschuiven.
      const mkIso = (h: number, m: number) =>
        `${year}-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
      startsAt = parseAmsterdamLocal(mkIso(sh, sm));
      if (dateMatch[5]) {
        const [eh, em] = dateMatch[5].split(':').map(Number);
        endsAt = parseAmsterdamLocal(mkIso(eh, em));
        // Voor "18:00 - 01:00" cases: endsAt < startsAt → +1 dag.
        if (endsAt.getTime() < startsAt.getTime()) {
          endsAt = new Date(endsAt.getTime() + 24 * 3600 * 1000);
        }
      }
    }
  }

  // Title uit eerste <h2>{title}</h2> in de block.
  const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
  const title = titleMatch
    ? decodeEntities(stripTags(titleMatch[1])).trim() || null
    : null;

  // Description = eerste <p> ná de h2 met substantiële tekst (>40 chars
  // na strip).
  let description: string | null = null;
  if (titleMatch && titleMatch.index !== undefined) {
    const afterTitle = block.slice(titleMatch.index + titleMatch[0].length);
    const pMatches = [...afterTitle.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)];
    for (const p of pMatches) {
      const text = decodeEntities(stripTags(p[1])).trim();
      if (text.length > 40) {
        description = text.slice(0, 800);
        break;
      }
    }
  }

  // Image: pakt eerste <source srcset="..."> in de block (Cavia gebruikt
  // <picture> met meerdere sources op verschillende breakpoints; we
  // pakken de eerste).
  const imgMatch = block.match(/srcset="([^"]+\.(?:jpg|jpeg|png|webp))"/i);
  const imageUrl = imgMatch ? imgMatch[1] : null;

  // Ticket-URL: amsterdamalternative.nl/tickets/{id} of /agenda/{id}.
  const ticketMatch = block.match(
    /href="(https?:\/\/(?:amsterdamalternative\.nl\/(?:tickets|agenda)\/\d+|[^"]*tickets?[^"]*))"/
  );
  const ticketUrl = ticketMatch ? ticketMatch[1] : null;

  return { anchor, title, startsAt, endsAt, description, imageUrl, ticketUrl };
}

async function fetchText(url: string): Promise<string | null> {
  return fetchTextWithTimeout(url, { ua: UA });
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&rsquo;/g, '’')
    .replace(/&lsquo;/g, '‘')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&#8217;/g, '’')
    .replace(/&#8216;/g, '‘')
    .replace(/&#8211;/g, '–')
    .replace(/&#038;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&euro;/g, '€');
}

