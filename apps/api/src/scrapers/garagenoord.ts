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

/** "16 May, 2026" + 23:00 → Date in Amsterdam. Geen tijd in de feed,
 *  default 23:00 (typische club-night). */
function buildDate(dateStr: string): Date | null {
  const m = dateStr.match(/(\d{1,2})\s+(\w+),?\s+(\d{4})/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = ENGLISH_MONTHS[m[2]];
  const year = parseInt(m[3], 10);
  if (!month) return null;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T23:00:00+02:00`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** Parse de homepage en extract per tile slug+title+date+ticket-link. */
function parseHomepage(html: string): RawEvent[] {
  const out: RawEvent[] = [];
  // Vang tiles die met de event-link starten en aan een tickets-link eindigen.
  // Tussenliggende DOM kan complex zijn; we parsen lazy van event-link tot
  // de eerstvolgende `weticket.io/{slug}/shop` of `ra.co/events/N`.
  const tileRe = /<a\s+href="https:\/\/garagenoord\.com\/club\/([a-z0-9-]+)"\s+class="event-link"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)href="(https:\/\/garagenoord\.weticket\.io\/[^"]+|https:\/\/ra\.co\/events\/[^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = tileRe.exec(html)) !== null) {
    const slug = m[1];
    const titleRaw = decodeHtmlEntities(stripTags(m[2]));
    const between = stripTags(m[3]);
    const ticketUrl = m[4];
    // Datum staat tussen titel en tickets-link
    const dm = between.match(/(\d{1,2}\s+\w+,?\s+\d{4})/);
    if (!dm || !titleRaw) continue;
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
      const startsAt = buildDate(tile.date);
      if (!startsAt || startsAt.getTime() < cutoff) { result.skipped++; continue; }
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
