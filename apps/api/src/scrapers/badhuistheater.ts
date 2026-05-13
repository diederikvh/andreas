import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Mike's Badhuistheater (Englisch theater in Oost) scraper.
 *
 * Listing op `/agenda/` met per event `<a class="event-thumb clm-set"
 * href="/events/SLUG/">` met:
 *   - h3: titel
 *   - één of meer `<div class="date">DD / MM / YYYY - HH:MM</div>`
 *     → één event-rij met N occurrences
 *   - paragrafen met description
 *   - img + srcset (volledige website-paden)
 *
 * Idempotent: event-id = `evt-badhuis-{slug}`, occurrence-id per
 * timestamp.
 */

const VENUE_ID = 'aa-mike-s-badhuistheater';
const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const BASE = 'https://www.badhuistheater.nl';
const AGENDA_URL = `${BASE}/agenda/`;

type Item = {
  slug: string;
  url: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  occurrences: Date[];
};

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(parseInt(c, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, c) =>
      String.fromCodePoint(parseInt(c, 16))
    )
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function shiftToLocalTime(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number
): Date {
  const tentative = new Date(Date.UTC(y, mo, d, h, mi, 0));
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Amsterdam',
    timeZoneName: 'longOffset',
  });
  const off = dtf
    .formatToParts(tentative)
    .find((p) => p.type === 'timeZoneName')?.value;
  const m = off?.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  const sign = m && m[1] === '+' ? 1 : -1;
  const oh = m ? parseInt(m[2], 10) : 0;
  const om = m ? parseInt(m[3] ?? '0', 10) : 0;
  return new Date(tentative.getTime() - sign * (oh * 60 + om) * 60_000);
}

function extractItems(html: string): Item[] {
  const items: Item[] = [];
  const now = Date.now();
  // Splits op event-thumb anker — eerste segment is alles vóór de
  // eerste card.
  const segments = html.split(/<a href="(?=https:\/\/www\.badhuistheater\.nl\/events\/)/);
  for (const block of segments.slice(1)) {
    const urlMatch = block.match(
      /^(https:\/\/www\.badhuistheater\.nl\/events\/([^"\/]+)\/?)"[^>]*class="event-thumb/
    );
    if (!urlMatch) continue;
    const url = urlMatch[1];
    const slug = urlMatch[2];

    // Titel
    const titleMatch = block.match(/<h3>([\s\S]*?)<\/h3>/);
    if (!titleMatch) continue;
    const title = decode(stripTags(titleMatch[1]));
    if (!title) continue;

    // Alle date-divs binnen deze card. Card eindigt bij volgende
    // event-thumb of bij </a></div> rond `clm-set`. Het volstaat
    // om alle date-divs vóór de volgende `class="event-thumb"`
    // mee te nemen — door de split is dat het hele block.
    const dates: Date[] = [];
    const dateRe =
      /<div class="date">(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})\s*-\s*(\d{1,2}):(\d{2})<\/div>/g;
    for (const m of block.matchAll(dateRe)) {
      const d = parseInt(m[1], 10);
      const mo = parseInt(m[2], 10) - 1;
      const y = parseInt(m[3], 10);
      const h = parseInt(m[4], 10);
      const mi = parseInt(m[5], 10);
      const dt = shiftToLocalTime(y, mo, d, h, mi);
      // Skip events ouder dan 24u
      if (dt.getTime() < now - 24 * 60 * 60_000) continue;
      dates.push(dt);
    }
    if (dates.length === 0) continue;
    dates.sort((a, b) => a.getTime() - b.getTime());

    // Description: paragrafen binnen `<div class="clm title">` na de
    // datums. Pak alle <p>-blokken, concateneer.
    const descMatches = Array.from(block.matchAll(/<p>([\s\S]*?)<\/p>/g));
    let description: string | null = null;
    if (descMatches.length > 0) {
      const parts = descMatches
        .map((m) => decode(stripTags(m[1])))
        .filter((s) => s.length > 0);
      if (parts.length > 0) description = parts.join(' ').slice(0, 2000);
    }

    // Image — prefer een ~1024-1600w variant uit srcset (niet de
    // gigantische 2000+ originals).
    let imageUrl: string | null = null;
    const srcsetMatch = block.match(/srcset="([^"]+)"/);
    if (srcsetMatch) {
      const cands = srcsetMatch[1]
        .split(',')
        .map((c) => {
          const parts = c.trim().split(/\s+/);
          const w = parseInt(parts[1]?.replace('w', '') ?? '0', 10);
          return { url: parts[0], w };
        })
        .filter((c) => c.url && c.w > 0)
        .sort((a, b) => a.w - b.w);
      // Pak de eerste >=1024w, anders de grootste die we hebben.
      const preferred = cands.find((c) => c.w >= 1024) ?? cands[cands.length - 1];
      imageUrl = preferred?.url ?? null;
    }
    if (!imageUrl) {
      const srcMatch = block.match(/<img\s[^>]*src="([^"]+)"/);
      if (srcMatch) imageUrl = srcMatch[1];
    }

    items.push({ slug, url, title, description, imageUrl, occurrences: dates });
  }
  return items;
}

async function mirrorImage(
  sourceUrl: string,
  slug: string
): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 8 * 1024 * 1024) return null;
    const ext = mime.includes('png')
      ? 'png'
      : mime.includes('webp')
        ? 'webp'
        : 'jpg';
    return await uploadToBunny(
      `media/events/badhuis-${slug}.${ext}`,
      buf,
      mime
    );
  } catch (e) {
    console.warn(`[badhuis] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type BadhuistheaterResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeBadhuistheater(options?: {
  venueIds?: string[];
}): Promise<BadhuistheaterResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: BadhuistheaterResult = {
    venueId: VENUE_ID,
    fetched: 0,
    inserted: 0,
    occurrencesUpserted: 0,
    skipped: 0,
    errors: [],
  };

  const [venue] = await db
    .select()
    .from(schema.venues)
    .where(eq(schema.venues.id, VENUE_ID));
  if (!venue) {
    result.errors.push('venue niet in DB');
    return [result];
  }

  const html = await fetchHtml(AGENDA_URL);
  if (!html) {
    result.errors.push('/agenda/ niet bereikbaar');
    return [result];
  }

  const items = extractItems(html);
  result.fetched = items.length;

  const venueCategory = venue.categories?.[0] ?? 'Theater';

  for (const item of items) {
    try {
      const eventId = `evt-badhuis-${item.slug}`;

      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      if (!existing) {
        const enriched = await enrichEvent({
          title: item.title,
          description: item.description,
          venueName: venue.name,
          venueCategory,
        });

        let imageUrl: string | null = null;
        if (item.imageUrl) {
          imageUrl =
            (await mirrorImage(item.imageUrl, item.slug)) ?? item.imageUrl;
        }

        const firstStart = item.occurrences[0]!;
        const refinedKind = refineKindByDuration('show', firstStart, null);

        await db.insert(schema.events).values({
          id: eventId,
          venueId: venue.id,
          title: item.title,
          description: enriched.cleanedDescription ?? item.description,
          kind: refinedKind,
          imageUrl,
          category: enriched.category ?? venueCategory,
          featured: false,
          genres: enriched.genres,
          published: true,
        });
        result.inserted++;
      }

      for (const startsAt of item.occurrences) {
        const yyyy = startsAt.toISOString().slice(0, 10).replace(/-/g, '');
        const occurrenceId = `occ-badhuis-${item.slug}-${yyyy}`;
        await db
          .insert(schema.occurrences)
          .values({
            id: occurrenceId,
            eventId,
            startsAt,
            endsAt: null,
            priceCents: null,
            priceNote: null,
            ticketUrl: item.url,
            room: null,
            lineup: null,
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: { startsAt, ticketUrl: item.url },
          });
        result.occurrencesUpserted++;
      }
    } catch (e) {
      result.errors.push(`${item.slug}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
