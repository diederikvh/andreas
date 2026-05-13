import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Nxt Museum (media-museum Noord) scraper.
 *
 * Nxt's /events is een Next.js SSR-listing met alle programma's
 * (verleden + toekomst) als `<a class="c-event-card" href="/event/SLUG">`.
 * Per card:
 *   - URL + slug
 *   - `.c-event-card__date span`: "11 JUN 2026" (DD MMM-uppercase YYYY)
 *     of "November 1" (vaag, geen jaar) — die vage variant skippen we.
 *   - `.c-event-card__title`: titel
 *   - srcSet met Next.js image-proxy URL → originele admin.nxtmuseum.com
 *     URL eruit decoderen voor de hero.
 *
 * Alle Nxt-events zijn single-day shows (artist talks, openings,
 * performances) — geen multi-day ranges. Kind blijft 'show' op 20:00
 * Amsterdam-tijd. Filter: skip events vóór vandaag.
 */

const VENUE_ID = 'nxt-museum';
const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const LISTING_URL = 'https://nxtmuseum.com/events';
const BASE = 'https://nxtmuseum.com';

const EN_MONTHS_UPPER: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

type CardRaw = {
  url: string;
  slug: string;
  title: string;
  startsAt: Date;
  imageUrl: string | null;
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
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
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

/**
 * Decodeer de Next.js image-proxy URL terug naar de originele
 * admin.nxtmuseum.com URL. `/_next/image?url=https%3A%2F%2F...&w=640&q=75`
 * → `https://admin.nxtmuseum.com/...`.
 */
function unwrapNextImage(src: string): string {
  const m = src.match(/[?&]url=([^&]+)/);
  if (!m) return src;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return src;
  }
}

function extractCards(html: string): CardRaw[] {
  const cards: CardRaw[] = [];
  // Splits op de outer event-card link-tag.
  const segments = html.split(/<a class="c-event-card[^"]*" href="\/event\//);
  const now = Date.now();
  for (const block of segments.slice(1)) {
    // Slug + URL: alles tot het volgende `"`
    const slugEnd = block.indexOf('"');
    if (slugEnd === -1) continue;
    const slug = block.slice(0, slugEnd);
    if (!slug || slug.includes('/')) continue;
    const url = `${BASE}/event/${slug}`;

    // Datum binnen `.c-event-card__date span`
    const dateMatch = block.match(
      /c-event-card__date"[^>]*>\s*<span>([^<]+)<\/span>/
    );
    if (!dateMatch) continue;
    const dateText = decode(dateMatch[1]).trim();
    // Match `D MMM YYYY` (uppercase 3-letter English month). Vage
    // varianten als "November 1" zonder jaar laten we vallen.
    const dm = dateText.match(/^(\d{1,2})\s+([A-Z]{3})\s+(\d{4})$/);
    if (!dm) continue;
    const day = parseInt(dm[1], 10);
    const month = EN_MONTHS_UPPER[dm[2]];
    const year = parseInt(dm[3], 10);
    if (month === undefined) continue;
    const startsAt = shiftToLocalTime(year, month, day, 20, 0);
    // Skip events in het verleden (24u-marge zodat lopende events
    // tot middernacht zichtbaar blijven).
    if (startsAt.getTime() < now - 24 * 60 * 60_000) continue;

    // Titel binnen `.c-event-card__title`
    const titleMatch = block.match(
      /c-event-card__title">([^<]+)<\/div>/
    );
    if (!titleMatch) continue;
    const title = decode(titleMatch[1]);
    if (!title) continue;

    // Image — Next.js srcSet, pak de eerste URL en unwrappen.
    let imageUrl: string | null = null;
    const srcMatch =
      block.match(/srcSet="([^"]+)"/) ?? block.match(/src="([^"]+)"/);
    if (srcMatch) {
      const first = srcMatch[1].split(',')[0]?.trim().split(/\s+/)[0];
      if (first) imageUrl = unwrapNextImage(first);
    }

    cards.push({ url, slug, title, startsAt, imageUrl });
  }
  return cards;
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
      `media/events/nxtmuseum-${slug}.${ext}`,
      buf,
      mime
    );
  } catch (e) {
    console.warn(`[nxtmuseum] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type NxtMuseumResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeNxtMuseum(options?: {
  venueIds?: string[];
}): Promise<NxtMuseumResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: NxtMuseumResult = {
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

  const html = await fetchHtml(LISTING_URL);
  if (!html) {
    result.errors.push('/events niet bereikbaar');
    return [result];
  }

  const cards = extractCards(html);
  result.fetched = cards.length;

  const venueCategory = venue.categories?.[0] ?? 'Kunst';

  for (const card of cards) {
    try {
      const eventId = `evt-nxtmuseum-${card.slug}`;
      const occurrenceId = `occ-nxtmuseum-${card.slug}`;

      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      if (existing) {
        await db
          .insert(schema.occurrences)
          .values({
            id: occurrenceId,
            eventId,
            startsAt: card.startsAt,
            endsAt: null,
            priceCents: null,
            priceNote: null,
            ticketUrl: card.url,
            room: null,
            lineup: null,
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: { startsAt: card.startsAt, ticketUrl: card.url },
          });
        result.occurrencesUpserted++;
        continue;
      }

      const enriched = await enrichEvent({
        title: card.title,
        description: null,
        venueName: venue.name,
        venueCategory,
      });

      let imageUrl: string | null = null;
      if (card.imageUrl) {
        imageUrl = (await mirrorImage(card.imageUrl, card.slug)) ?? card.imageUrl;
      }

      const refinedKind = refineKindByDuration('show', card.startsAt, null);

      await db.transaction(async (tx) => {
        await tx.insert(schema.events).values({
          id: eventId,
          venueId: venue.id,
          title: card.title,
          description: enriched.cleanedDescription,
          kind: refinedKind,
          imageUrl,
          category: enriched.category ?? venueCategory,
          featured: false,
          genres: enriched.genres,
          published: true,
        });
        result.inserted++;

        await tx
          .insert(schema.occurrences)
          .values({
            id: occurrenceId,
            eventId,
            startsAt: card.startsAt,
            endsAt: null,
            priceCents: null,
            priceNote: enriched.priceNote,
            ticketUrl: card.url,
            room: enriched.room,
            lineup: enriched.lineup,
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: {
              startsAt: card.startsAt,
              priceNote: enriched.priceNote,
              ticketUrl: card.url,
              room: enriched.room,
              lineup: enriched.lineup,
            },
          });
        result.occurrencesUpserted++;
      });
    } catch (e) {
      result.errors.push(`${card.slug}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
