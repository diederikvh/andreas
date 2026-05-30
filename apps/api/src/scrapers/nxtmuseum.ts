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
 *     voor single-day shows, óf voor multi-day exhibitions:
 *     `<span>15 APR 2026<br/><span class="end-date">…13 MAY 2026</span></span>`.
 *     Vage "November 1" zonder jaar laten we vallen.
 *   - `.c-event-card__title`: titel
 *   - srcSet met Next.js image-proxy URL → originele admin.nxtmuseum.com
 *     URL eruit decoderen voor de hero.
 *
 * Single-day → kind 'show' op 20:00 Amsterdam-tijd, endsAt null.
 * Multi-day → kind 'exhibition' op 11:00 startdag → 18:00 einddag
 * (museum-openingstijden, ruwe defaults). Filter: events skippen alleen
 * als hun eind-datum (of start als geen eind) >24u in het verleden ligt.
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
  endsAt: Date | null;
  isMultiDay: boolean;
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

    // Pak het hele `.c-event-card__date`-blok (incl. eventuele
    // multi-day end-date span met `<br/>`-separator). Daarna extraheren
    // we alle `D MMM YYYY`-tokens — één voor single-day, twee voor een
    // range.
    const dateBlock = block.match(
      /c-event-card__date"[^>]*>([\s\S]*?)<\/div>/
    );
    if (!dateBlock) continue;
    const dateTokens = [
      ...dateBlock[1].matchAll(/(\d{1,2})\s+([A-Z]{3})\s+(\d{4})/g),
    ];
    if (dateTokens.length === 0) continue;
    const startMonth = EN_MONTHS_UPPER[dateTokens[0][2]];
    if (startMonth === undefined) continue;
    const startDay = parseInt(dateTokens[0][1], 10);
    const startYear = parseInt(dateTokens[0][3], 10);

    const isMultiDay = dateTokens.length >= 2;
    let endsAt: Date | null = null;
    let startsAt: Date;
    if (isMultiDay) {
      const endMonth = EN_MONTHS_UPPER[dateTokens[1][2]];
      if (endMonth === undefined) continue;
      const endDay = parseInt(dateTokens[1][1], 10);
      const endYear = parseInt(dateTokens[1][3], 10);
      // Exhibitions / multi-day residencies: 11:00 opening → 18:00 close
      // op einddatum. Ruwe defaults; per-event-detailpagina zou nauwkeuriger
      // kunnen, maar deze ranges zijn altijd dagdekkend.
      startsAt = shiftToLocalTime(startYear, startMonth, startDay, 11, 0);
      endsAt = shiftToLocalTime(endYear, endMonth, endDay, 18, 0);
    } else {
      // Single-day shows: 20:00 Amsterdam-tijd (artist talks, openings).
      startsAt = shiftToLocalTime(startYear, startMonth, startDay, 20, 0);
    }
    // Skip alleen als het hele event >24u in het verleden ligt: voor
    // multi-day kijken we naar endsAt, voor single-day naar startsAt
    // zodat lopende exhibitions zichtbaar blijven tot ze écht klaar zijn.
    const effectiveEnd = endsAt ?? startsAt;
    if (effectiveEnd.getTime() < now - 24 * 60 * 60_000) continue;

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

    cards.push({ url, slug, title, startsAt, endsAt, isMultiDay, imageUrl });
  }
  return cards;
}

/** NXT detail-pagina toont "Time:" met "6:00 pm - 8:30 pm" of "11:00".
 *  Listing-default 20:00 is fout voor launch-events (18:00) en
 *  ochtend-talks (11:00). Eerste pm/am tijd na "Time:" wint. */
async function fetchDetailStartTime(
  url: string,
): Promise<{ hour: number; minute: number } | null> {
  const html = await fetchHtml(url);
  if (!html) return null;
  const m = html.match(
    /Time[<\s][^<]*<[^>]*>[\s\S]{0,200}?(\d{1,2}):(\d{2})\s*(am|pm)/i,
  );
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  const period = m[3].toLowerCase();
  if (period === 'pm' && hour < 12) hour += 12;
  if (period === 'am' && hour === 12) hour = 0;
  return { hour, minute };
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
      // Voor single-day events: probeer de echte tijd uit de detail-
      // pagina te halen ("Time: 6:00 pm - 8:30 pm"). Listing geeft
      // alleen de datum; default 20:00 was fout voor launches/talks.
      if (!card.isMultiDay) {
        const t = await fetchDetailStartTime(card.url);
        if (t) {
          const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Europe/Amsterdam',
            year: 'numeric', month: '2-digit', day: '2-digit',
          }).formatToParts(card.startsAt);
          const get = (p: string) => parseInt(parts.find((x) => x.type === p)!.value, 10);
          card.startsAt = shiftToLocalTime(
            get('year'), get('month') - 1, get('day'),
            t.hour, t.minute,
          );
        }
      }
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
            endsAt: card.endsAt,
            priceCents: null,
            priceNote: null,
            ticketUrl: card.url,
            room: null,
            lineup: null,
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: {
              startsAt: card.startsAt,
              endsAt: card.endsAt,
              ticketUrl: card.url,
            },
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

      // Multi-day = exhibition (default), single-day = show.
      // `refineKindByDuration` corrigeert daarna nog op basis van de
      // werkelijke duur (bv. een single-day 'show' die >24u duurt wordt
      // alsnog 'exhibition').
      const baseKind = card.isMultiDay ? 'exhibition' : 'show';
      const refinedKind = refineKindByDuration(
        baseKind,
        card.startsAt,
        card.endsAt
      );

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
            endsAt: card.endsAt,
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
              endsAt: card.endsAt,
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
