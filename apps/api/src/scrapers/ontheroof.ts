import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * On the Roof scraper. Hybride bron:
 *   1. Weeztix shop (https://shop.weeztix.com/{shopId}/events) →
 *      Vue SPA met 9 zomerse jazz-concerten. Playwright rendert; we
 *      parsen de innerText voor title/datum/tijd.
 *   2. on-the-roof.com/artists/{slug}/ → per artiest een eigen pagina
 *      met og:title, og:description en og:image. Rijker dan Weeztix.
 *
 * Slug-matching: title van Weeztix ("OtR 2026 - Izaline Calister
 * Quintet") → genormaliseerde slug ("izaline-calister-quintet") →
 * fetch /artists/{slug}/ voor description + image. Fallback op
 * venue.imageUrl wanneer de match faalt.
 *
 * Idempotency: event-id = sha256(genormaliseerde titel). Title-
 * grouping niet nodig — per concertdate één event. Occurrence-id =
 * eventId omdat 1:1.
 */

import { createHash } from 'node:crypto';

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

const VENUE_ID = 'on-the-roof';
const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const SHOP_ID = 'c2186270-4bf2-11e9-8ed7-a5e3c4e2991e';
const SHOP_CODE = '2cd52jgy';
const WEEZTIX_URL = `https://shop.weeztix.com/${SHOP_ID}/events?shop_code=${SHOP_CODE}`;
const SITE = 'https://on-the-roof.com';

type WeeztixEvent = {
  title: string;
  rawTitle: string;
  startsAt: Date;
  endsAt: Date | null;
};

const NL_MONTHS_SHORT: Record<string, number> = {
  jan: 0, feb: 1, mrt: 2, mar: 2, apr: 3, mei: 4, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, okt: 9, oct: 9, nov: 10, dec: 11,
};

/** Parse "DD-MM-YYYY HH:MM" naar lokale tijd Europe/Amsterdam. */
function parseLocalDateTime(text: string): Date | null {
  const m = text.match(/(\d{1,2})-(\d{1,2})-(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10) - 1;
  const year = parseInt(m[3], 10);
  const hour = parseInt(m[4], 10);
  const minute = parseInt(m[5], 10);
  const tentative = new Date(Date.UTC(year, month, day, hour, minute, 0));
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Amsterdam',
    timeZoneName: 'longOffset',
  });
  const off = dtf.formatToParts(tentative).find((p) => p.type === 'timeZoneName')?.value;
  const mm = off?.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  const sign = mm && mm[1] === '+' ? 1 : -1;
  const oh = mm ? parseInt(mm[2], 10) : 0;
  const om = mm ? parseInt(mm[3] ?? '0', 10) : 0;
  return new Date(tentative.getTime() - sign * (oh * 60 + om) * 60_000);
}

/** Render de Weeztix-shop met Playwright en pak alle events. */
async function fetchWeeztixEvents(): Promise<WeeztixEvent[]> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ locale: 'nl-NL', userAgent: UA });
    const page = await ctx.newPage();
    await page.goto(WEEZTIX_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);
    const body: string = await page.evaluate('document.body.innerText');

    // Parse blocks: each event is "{MMM}.\n{DD}\n{TITLE}\n{DATE-RANGE}\n{LOCATION}"
    // We splitsen op het patroon van de date-range — die is altijd
    // herkenbaar als "DD-MM-YYYY HH:MM - DD-MM-YYYY HH:MM".
    const events: WeeztixEvent[] = [];
    const dateRangeRe = /(\d{1,2}-\d{1,2}-\d{4}\s+\d{1,2}:\d{2})\s+-\s+(\d{1,2}-\d{1,2}-\d{4}\s+\d{1,2}:\d{2})/g;
    const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);

    // Walk lines: when we hit a date-range line, pak titel uit vorige niet-datum lijn.
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const dr = line.match(dateRangeRe);
      if (!dr) continue;
      // De titel is de regel direct boven de date-range.
      const rawTitle = lines[i - 1];
      if (!rawTitle) continue;
      // Filter de "Contribute to a ticket"-donatie eruit.
      if (/contribute to a ticket/i.test(rawTitle)) continue;
      // Skip als titel een MMM-letter pattern is (zoals "JUN.")
      if (/^[A-Z]{3}\.\s*$/.test(rawTitle)) continue;
      const m = line.match(/(\d{1,2}-\d{1,2}-\d{4}\s+\d{1,2}:\d{2})\s+-\s+(\d{1,2}-\d{1,2}-\d{4}\s+\d{1,2}:\d{2})/);
      if (!m) continue;
      const startsAt = parseLocalDateTime(m[1]);
      const endsAt = parseLocalDateTime(m[2]);
      if (!startsAt) continue;
      // Cleanup title: strip "OtR 2026 - " prefix
      const cleanTitle = rawTitle.replace(/^O[tT]R\s+\d{4}\s*[-–]\s*/i, '').trim();
      events.push({
        title: cleanTitle,
        rawTitle,
        startsAt,
        endsAt,
      });
    }
    return events;
  } finally {
    await browser.close();
  }
}

/** Slugify een titel volgens OnTheRoof's URL-conventie. */
function titleToSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e').replace(/[íìï]/g, 'i')
    .replace(/[óòö]/g, 'o').replace(/[úùü]/g, 'u')
    .replace(/[(){}[\]]/g, '')
    .replace(/young creator[s]?/gi, '')
    .replace(/double[\s-]*bill[s]?/gi, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(parseInt(c, 10)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

function extractOg(html: string, prop: string): string | null {
  const re = new RegExp(`<meta\\s+property="og:${prop}"\\s+content="([^"]+)"`, 'i');
  const m = html.match(re);
  return m ? decodeEntities(m[1]) : null;
}

/** Probeer de artist-pagina op OnTheRoof. Eerst exact slug, daarna
 *  fallback varianten. Returnt og-data of null. */
async function fetchArtistPage(title: string): Promise<{
  description: string | null;
  imageUrl: string | null;
} | null> {
  const baseSlug = titleToSlug(title);
  const candidates = [
    baseSlug,
    `${baseSlug}-2`,
    `2026-${baseSlug}`,
    // Splits double-bill: probeer eerste deel
    baseSlug.split(/[-]/)[0],
  ];
  for (const slug of candidates) {
    if (!slug) continue;
    const html = await fetchHtml(`${SITE}/artists/${slug}/`);
    if (!html) continue;
    const ogTitle = extractOg(html, 'title');
    if (!ogTitle) continue;
    // Page must mention 2026 to be the current edition
    if (!/2026/.test(ogTitle)) continue;
    return {
      description: extractOg(html, 'description'),
      imageUrl: extractOg(html, 'image'),
    };
  }
  return null;
}

async function mirrorImage(sourceUrl: string, hash: string): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 8 * 1024 * 1024) return null;
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    return await uploadToBunny(`media/events/otr-${hash}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[ontheroof] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type OnTheRoofResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeOnTheRoof(options?: {
  venueIds?: string[];
}): Promise<OnTheRoofResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: OnTheRoofResult = {
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

  let events: WeeztixEvent[];
  try {
    events = await fetchWeeztixEvents();
  } catch (e) {
    result.errors.push(`weeztix: ${(e as Error).message}`);
    return [result];
  }
  result.fetched = events.length;

  const venueCategory = venue.categories?.[0] ?? 'Muziek';

  for (const ev of events) {
    try {
      const groupHash = shortHash(`otr|${ev.title.toLowerCase()}`);
      const eventId = `evt-otr-${VENUE_ID}-${groupHash}`;
      const occurrenceId = `occ-otr-${VENUE_ID}-${groupHash}`;

      // Existing-check
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
            startsAt: ev.startsAt,
            endsAt: ev.endsAt,
            priceCents: null,
            priceNote: null,
            ticketUrl: WEEZTIX_URL,
            room: null,
            lineup: null,
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: { startsAt: ev.startsAt, endsAt: ev.endsAt, ticketUrl: WEEZTIX_URL },
          });
        result.occurrencesUpserted++;
        continue;
      }

      // Nieuw event — fetch OnTheRoof artist-pagina voor desc + image.
      const artist = await fetchArtistPage(ev.title);
      const description = artist?.description ?? null;

      const enriched = await enrichEvent({
        title: ev.title,
        description,
        venueName: venue.name,
        venueCategory,
      });

      let imageUrl: string | null = null;
      if (artist?.imageUrl) {
        imageUrl = (await mirrorImage(artist.imageUrl, groupHash)) ?? artist.imageUrl;
      }

      const refinedKind = refineKindByDuration(enriched.kind, ev.startsAt, ev.endsAt);

      await db.transaction(async (tx) => {
        await tx.insert(schema.events).values({
          id: eventId,
          venueId: venue.id,
          title: ev.title,
          description: enriched.cleanedDescription ?? description,
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
            startsAt: ev.startsAt,
            endsAt: ev.endsAt,
            priceCents: null,
            priceNote: enriched.priceNote,
            ticketUrl: WEEZTIX_URL,
            room: enriched.room,
            lineup: enriched.lineup,
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: {
              startsAt: ev.startsAt,
              endsAt: ev.endsAt,
              priceNote: enriched.priceNote,
              ticketUrl: WEEZTIX_URL,
              room: enriched.room,
              lineup: enriched.lineup,
            },
          });
        result.occurrencesUpserted++;
      });
    } catch (e) {
      result.errors.push(`event ${ev.title}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
