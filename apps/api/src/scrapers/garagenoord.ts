import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Garage Noord — pure-HTTP scraper.
 *
 * `garagenoord.com/` toont de aankomende events. Per event:
 *   - `<a href="https://garagenoord.com/club/{slug}" class="event-link">` →
 *     opening tag van een tile
 *   - Title-tekst, datum ("DD MMM, YYYY"), Tickets-link
 *     (`garagenoord.weticket.io/{slug}/shop` of soms `ra.co/events/...`)
 *
 * Per event halen we de detail-page `garagenoord.com/club/{slug}` op voor
 * de `og:image` (cover-art per event, gehost op garagenoord.com).
 *
 * End-time is niet op de homepage — default startsAt + 7u (typische club).
 *
 * Idempotency:
 *  - eventId      = `evt-gn-{slug}`
 *  - occurrenceId = `occ-gn-{slug}`
 */

const UA = 'Mozilla/5.0 (Andreas/1.0)';
const VENUE_ID = 'garage-noord';
const HOMEPAGE = 'https://garagenoord.com/';
const DETAIL_BASE = 'https://garagenoord.com/club/';

const ENGLISH_MONTHS: Record<string, number> = {
  Jan: 1, January: 1, Feb: 2, February: 2, Mar: 3, March: 3, Apr: 4, April: 4,
  May: 5, Jun: 6, June: 6, Jul: 7, July: 7, Aug: 8, August: 8,
  Sep: 9, Sept: 9, September: 9, Oct: 10, October: 10, Nov: 11, November: 11,
  Dec: 12, December: 12,
};

type RawEvent = {
  slug: string;
  title: string;
  date: string;        // "16 May, 2026"
  ticketUrl: string;
};

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#038;/g, '&').replace(/&amp;/g, '&')
    .replace(/&#8217;/g, '’').replace(/&#8216;/g, '‘')
    .replace(/&#8220;/g, '“').replace(/&#8221;/g, '”')
    .replace(/&#8211;/g, '–').replace(/&#8212;/g, '—')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** "16 May, 2026" + 23:00 → Date in Amsterdam. Default-tijd is 23:00
 *  (club-night) — wordt later evt. overschreven door de echte
 *  first_date uit de weticket shop-page. */
function buildDate(dateStr: string): Date | null {
  const m = dateStr.match(/(\d{1,2})\s+(\w+),?\s+(\d{4})/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = ENGLISH_MONTHS[m[2]];
  const year = parseInt(m[3], 10);
  if (!month) return null;
  const dst = month >= 3 && month <= 10;
  const off = dst ? '+02:00' : '+01:00';
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T23:00:00${off}`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** Pak de echte event-tijd uit de weticket shop-HTML. Het page is een
 *  Next.js SPA — `first_date` zit in de raw JSON-fragments. Listing-
 *  default 23:00 is fout voor day-events (bv. klub krai listening
 *  session 12:30, bar40 jubileum 23:30). */
async function fetchWeticketFirstDate(shopUrl: string): Promise<Date | null> {
  try {
    const r = await fetch(shopUrl, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const html = await r.text();
    // `__NEXT_DATA__` heeft `first_datetime` (niet `first_date` zoals
    // de listing-feed) — formaat "YYYY-MM-DD HH:MM" Amsterdam-local.
    const m = html.match(/"first_datetime"\s*:\s*"(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2})"/);
    if (!m) return null;
    const [, date, hh, mm] = m;
    const month = parseInt(date.slice(5, 7), 10);
    const dst = month >= 3 && month <= 10;
    const off = dst ? '+02:00' : '+01:00';
    const d = new Date(`${date}T${hh}:${mm}:00${off}`);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

/** Parse de homepage en extract per tile slug+title+date+ticket-link. */
function parseHomepage(html: string): RawEvent[] {
  const out: RawEvent[] = [];
  // Splits per-tile op `<div class="event  ">`. Eerder gebruikte we een
  // lazy regex over de hele HTML die per ongeluk de tickets-link van
  // het VOLGENDE tile pakte als het huidige tile er geen had (bv.
  // "peel" zonder ticket → kreeg tim-reaper's URL, die op zijn beurt
  // bar40's URL kreeg, enzovoort — off-by-one cascade door de hele
  // lijst). Per-tile parsing fixt dat: een tile zonder eigen
  // weticket/ra-link levert geen RawEvent op.
  const tiles = html.split(/(?=<div class="event  ")/);
  for (const tile of tiles) {
    const slugM = tile.match(
      /<a\s+href="https:\/\/garagenoord\.com\/club\/([a-z0-9-]+)"\s+class="event-link"[^>]*>([\s\S]*?)<\/a>/,
    );
    if (!slugM) continue;
    const slug = slugM[1];
    const titleRaw = decodeHtmlEntities(stripTags(slugM[2]));
    if (!titleRaw) continue;
    // Ticket-URL alleen accepteren als 'ie BINNEN ditzelfde tile zit
    // (geen lazy match over tile-grenzen). Eerst weticket, dan ra.co.
    const ticketM = tile.match(
      /href="(https:\/\/garagenoord\.weticket\.io\/[^"]+|https:\/\/ra\.co\/events\/[^"]+)"/,
    );
    if (!ticketM) continue;
    const ticketUrl = ticketM[1];
    const dm = stripTags(tile).match(/(\d{1,2}\s+\w+,?\s+\d{4})/);
    if (!dm) continue;
    out.push({ slug, title: titleRaw, date: dm[1], ticketUrl });
  }
  return out;
}

async function fetchOgImage(slug: string): Promise<string | null> {
  try {
    const r = await fetch(`${DETAIL_BASE}${slug}`, { headers: { 'user-agent': UA, accept: 'text/html' } });
    if (!r.ok) return null;
    const html = await r.text();
    const m = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
    return m ? decodeHtmlEntities(m[1]) : null;
  } catch {
    return null;
  }
}

async function mirrorImage(sourceUrl: string, slug: string): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength < 1024 || buf.byteLength > 16 * 1024 * 1024) return null;
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    return await uploadToBunny(`media/events/gn-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[garagenoord] mirror image ${slug}: ${(e as Error).message}`);
    return null;
  }
}

export type GarageNoordResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeGarageNoord(options?: { venueIds?: string[] }): Promise<GarageNoordResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];
  const [venue] = await db.select().from(schema.venues).where(eq(schema.venues.id, VENUE_ID));
  if (!venue) return [];

  const result: GarageNoordResult = {
    venueId: VENUE_ID, fetched: 0, inserted: 0, occurrencesUpserted: 0, skipped: 0, errors: [],
  };

  let html: string;
  try {
    const r = await fetch(HOMEPAGE, { headers: { 'user-agent': UA, accept: 'text/html' } });
    if (!r.ok) { result.errors.push(`fetch home: HTTP ${r.status}`); return [result]; }
    html = await r.text();
  } catch (e) {
    result.errors.push(`fetch home: ${(e as Error).message}`);
    return [result];
  }

  const tiles = parseHomepage(html);
  // Dedup op slug
  const seen = new Set<string>();
  const unique = tiles.filter((t) => {
    if (seen.has(t.slug)) return false;
    seen.add(t.slug);
    return true;
  });
  result.fetched = unique.length;

  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  const venueCategory = venue.categories?.[0] ?? 'Muziek';

  for (const tile of unique) {
    try {
      let startsAt = buildDate(tile.date);
      if (!startsAt || startsAt.getTime() < cutoff) { result.skipped++; continue; }
      // Probeer de echte first_date uit weticket te halen (klopt voor
      // day-events die anders op default 23:00 belanden).
      if (tile.ticketUrl.includes('weticket.io/')) {
        const better = await fetchWeticketFirstDate(tile.ticketUrl);
        if (better) startsAt = better;
      }
      const endsAt = new Date(startsAt.getTime() + 7 * 60 * 60 * 1000);

      const eventId = `evt-gn-${tile.slug}`;
      const occurrenceId = `occ-gn-${tile.slug}`;

      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;
      let imageUrl: string | null = null;

      if (!existing) {
        try {
          enriched = await enrichEvent({
            title: tile.title,
            description: null,
            venueName: venue.name,
            venueCategory,
          });
        } catch (e) {
          result.errors.push(`enrich ${tile.title}: ${(e as Error).message}`);
        }

        const ogImage = await fetchOgImage(tile.slug);
        if (ogImage) imageUrl = await mirrorImage(ogImage, tile.slug);

        const eventKind = refineKindByDuration(enriched?.kind ?? 'show', startsAt, endsAt);

        try {
          await db.insert(schema.events).values({
            id: eventId,
            venueId: VENUE_ID,
            title: tile.title,
            description: enriched?.cleanedDescription ?? null,
            kind: eventKind,
            imageUrl,
            category: enriched?.category ?? venueCategory,
            featured: false,
            genres: enriched?.genres ?? [],
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
            ticketUrl: tile.ticketUrl,
            room: null,
            lineup: existing ? null : (enriched?.lineup ?? null),
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: { startsAt, endsAt, ticketUrl: tile.ticketUrl },
          });
        result.occurrencesUpserted++;
      } catch (e) {
        result.errors.push(`occurrence ${tile.slug}: ${(e as Error).message}`);
        result.skipped++;
      }
    } catch (e) {
      result.errors.push(`tile ${tile.slug}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
