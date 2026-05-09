import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';

import { db, schema } from '../db/index.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Het Sieraad — pure-HTTP scraper. De homepage rendert een serverside
 * tabel met `.event-row`s, elk met 4 spans (date+time, lineup, sound,
 * tickets) en een optionele `.event-details` `<div>` met description.
 *
 * Voorbeeld-rij:
 *   <div class="event-row">
 *     <span>Friday 15 May 2026<br>11:00 PM - 5:00 AM </span>
 *     <span> Anil Aras | Boris Coelman | Shanne</span>
 *     <span>House</span>
 *     <span><a class="get-tickets bb" href="https://shop.paylogic.com/...">…</a></span>
 *     <div class="event-details"><p>… description …</p></div>
 *   </div>
 *
 * Geen images op de homepage (Het Sieraad voert geen tile-art per event).
 *
 * Idempotency:
 *  - eventId      = `evt-sieraad-{paylogic-id-of-hash}`
 *  - occurrenceId = `occ-sieraad-{...}`
 */

const UA = 'Mozilla/5.0 (Andreas/1.0)';
const VENUE_ID = 'het-sieraad';
const HOMEPAGE = 'https://www.het-sieraad.nl/';

const ENGLISH_MONTHS: Record<string, number> = {
  Jan: 1, January: 1,
  Feb: 2, February: 2,
  Mar: 3, March: 3,
  Apr: 4, April: 4,
  May: 5,
  Jun: 6, June: 6,
  Jul: 7, July: 7,
  Aug: 8, August: 8,
  Sep: 9, Sept: 9, September: 9,
  Oct: 10, October: 10,
  Nov: 11, November: 11,
  Dec: 12, December: 12,
};

type RawEvent = {
  date: string;        // "Friday 15 May 2026"
  startTime: string;   // "11:00 PM"
  endTime: string;     // "5:00 AM"
  lineup: string;
  genres: string;
  ticketUrl: string;
  paylogicId: string | null;
  description: string | null;
};

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#038;/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/&#8217;/g, '’')
    .replace(/&#8216;/g, '‘')
    .replace(/&#8220;/g, '“')
    .replace(/&#8221;/g, '”')
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** "Friday 15 May 2026" + "11:00 PM" → Date in Amsterdam (CET, +02:00). */
function buildDate(dateStr: string, time: string): Date | null {
  const m = dateStr.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = ENGLISH_MONTHS[m[2]];
  const year = parseInt(m[3], 10);
  if (!month) return null;
  const t = time.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!t) return null;
  let hh = parseInt(t[1], 10);
  const mm = parseInt(t[2], 10);
  const isPm = t[3].toUpperCase() === 'PM';
  if (hh === 12) hh = 0;
  if (isPm) hh += 12;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+02:00`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function parseRows(html: string): RawEvent[] {
  const out: RawEvent[] = [];
  // Vang elke `<div class="event-row">…</div></div>` — capture-group
  // includeert de eerste `</div>` (event-details close) zodat de
  // description-regex hieronder beide tags kan vinden.
  const rowRe = /<div class="event-row">([\s\S]*?<\/div>)\s*<\/div>/g;
  let match: RegExpExecArray | null;
  while ((match = rowRe.exec(html)) !== null) {
    const block = match[1];
    // 4 hoofdspans
    const spans: string[] = [];
    const spanRe = /<span(?:[^>]*)>([\s\S]*?)<\/span>(?=\s*<(?:span|div))/g;
    // Eenvoudiger: split op `<span>…</span>` op het top-level. We gebruiken
    // een non-greedy regex die span-content vangt.
    const allSpans = [...block.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map((m) => m[1]);
    // De top-level spans zijn de eerste 4 wiens parents geen <span> zijn,
    // maar omdat het 4 platte spans zijn aan het begin werkt een simpele
    // slice meestal — wel filter we de inline LIVE-badge eruit.
    for (const s of allSpans) {
      // Skip de live-now-badge tekst en lege spans
      if (/live-now-badge/i.test(s)) continue;
      if (s.trim() === '') continue;
      spans.push(s);
      if (spans.length >= 4) break;
    }
    if (spans.length < 4) continue;

    const dateTimeRaw = decodeHtmlEntities(stripTags(spans[0]));
    // "Saturday 09 May 2026 10:00 PM - 5:00 AM" of met "<br>" → " "
    const dt = dateTimeRaw.match(/^(\w+\s+\d{1,2}\s+\w+\s+\d{4})\s+(\d{1,2}:\d{2}\s*(?:AM|PM))\s*-\s*(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
    if (!dt) continue;

    const lineup = decodeHtmlEntities(stripTags(spans[1])).trim();
    const genres = decodeHtmlEntities(stripTags(spans[2])).trim();

    const ticketM = spans[3].match(/href="([^"]+)"/i);
    if (!ticketM) continue;
    const ticketUrl = decodeHtmlEntities(ticketM[1]);
    const pidM = ticketUrl.match(/paylogic\.com\/([a-f0-9]{24,})/i);
    const paylogicId = pidM ? pidM[1] : null;

    // Description uit `.event-details`
    const detailsM = block.match(/<div class="event-details"[^>]*>([\s\S]*?)<\/div>/);
    const descRaw = detailsM ? stripTags(detailsM[1]) : '';
    // Filter de notionvc-comment en doors-info eruit voor cleaner text
    const description = descRaw
      .replace(/notionvc:\s*[a-f0-9-]+/i, '')
      .replace(/Doors open at[^.]+\./gi, '')
      .replace(/This event is 18\+\.?/gi, '')
      .replace(/\s+/g, ' ')
      .trim() || null;

    out.push({
      date: dt[1],
      startTime: dt[2],
      endTime: dt[3],
      lineup,
      genres,
      ticketUrl,
      paylogicId,
      description,
    });
  }
  return out;
}

/** "Anil Aras | Boris Coelman | Shanne" → [{ name: 'Anil Aras' }, …]. */
function splitLineup(s: string): Array<{ name: string }> {
  return s
    .split(/\s*\|\s*/)
    .map((n) => n.trim())
    .filter(Boolean)
    .map((name) => ({ name }));
}

/** "Saga W/ Makcim | Daniele …" → "Saga"; "Anil Aras | Boris …" → "Anil Aras …" */
function makeTitle(lineup: string): string {
  // Patroon "Naam w/ rest" → eerst stuk
  const wMatch = lineup.match(/^(.+?)\s+[wW]\/\s+/);
  if (wMatch) return wMatch[1].trim();
  // Anders: hele lineup tot 80 tekens
  return lineup.length > 80 ? lineup.slice(0, 77).trim() + '…' : lineup;
}

export type SieraadResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeSieraad(options?: { venueIds?: string[] }): Promise<SieraadResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];
  const [venue] = await db.select().from(schema.venues).where(eq(schema.venues.id, VENUE_ID));
  if (!venue) return [];

  const result: SieraadResult = {
    venueId: VENUE_ID, fetched: 0, inserted: 0, occurrencesUpserted: 0, skipped: 0, errors: [],
  };

  let html: string;
  try {
    const r = await fetch(HOMEPAGE, { headers: { 'user-agent': UA, accept: 'text/html' } });
    if (!r.ok) {
      result.errors.push(`fetch: HTTP ${r.status}`);
      return [result];
    }
    html = await r.text();
  } catch (e) {
    result.errors.push(`fetch: ${(e as Error).message}`);
    return [result];
  }

  const rows = parseRows(html);
  result.fetched = rows.length;
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  const venueCategory = venue.categories?.[0] ?? 'Muziek';

  for (const row of rows) {
    try {
      const startsAt = buildDate(row.date, row.startTime);
      if (!startsAt || startsAt.getTime() < cutoff) { result.skipped++; continue; }
      let endsAt = buildDate(row.date, row.endTime);
      if (endsAt && endsAt.getTime() < startsAt.getTime()) {
        endsAt = new Date(endsAt.getTime() + 24 * 60 * 60 * 1000);
      }

      // Stable id: paylogic-id als beschikbaar, anders sha256(date+lineup)
      const idKey = row.paylogicId
        ?? createHash('sha256').update(`${row.date}|${row.lineup}`).digest('hex').slice(0, 16);
      const eventId = `evt-sieraad-${idKey}`;
      const occurrenceId = `occ-sieraad-${idKey}`;
      const title = makeTitle(row.lineup);

      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;

      if (!existing) {
        try {
          enriched = await enrichEvent({
            title,
            description: row.description,
            venueName: venue.name,
            venueCategory,
          });
        } catch (e) {
          result.errors.push(`enrich ${title}: ${(e as Error).message}`);
        }

        const eventKind = refineKindByDuration(enriched?.kind ?? 'show', startsAt, endsAt);
        // Genres: parse de "House, Hard House" string in een array
        const venueGenres = row.genres.split(/[,&]+/).map((g) => g.trim().toLowerCase()).filter(Boolean);
        const genres = enriched?.genres?.length ? enriched.genres : venueGenres;

        try {
          await db.insert(schema.events).values({
            id: eventId,
            venueId: VENUE_ID,
            title,
            description: enriched?.cleanedDescription ?? row.description,
            kind: eventKind,
            imageUrl: null,
            category: enriched?.category ?? venueCategory,
            featured: false,
            genres,
            published: true,
          });
          result.inserted++;
        } catch (e) {
          result.errors.push(`insert ${eventId}: ${(e as Error).message}`);
          continue;
        }
      }

      try {
        await db
          .insert(schema.occurrences)
          .values({
            id: occurrenceId,
            eventId,
            startsAt,
            endsAt,
            priceCents: null,
            priceNote: existing ? null : (enriched?.priceNote ?? null),
            ticketUrl: row.ticketUrl,
            room: null,
            lineup: existing ? null : (enriched?.lineup ?? splitLineup(row.lineup)),
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: { startsAt, endsAt, ticketUrl: row.ticketUrl },
          });
        result.occurrencesUpserted++;
      } catch (e) {
        result.errors.push(`occurrence ${idKey}: ${(e as Error).message}`);
        result.skipped++;
      }
    } catch (e) {
      result.errors.push(`row: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
