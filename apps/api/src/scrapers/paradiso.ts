import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Paradiso scraper. Hun site is Next.js zonder Cloudflare-block, dus
 * platte fetch werkt prima. Geen JSON-LD, geen public data-API — wel
 * rijke OG-meta op elke event-detail-pagina.
 *
 * Strategie:
 *   1. Fetch homepage → extract event-links `/programma/{slug}/{id}`
 *   2. Per event: fetch detail-pagina, parse og:title (bevat datum),
 *      og:description (rijke promotekst), og:image
 *   3. Date-extraction uit og:title pattern: "ARTIST - 15 juni 2026 - Paradiso"
 *
 * Idempotency: numerieke event-id uit de URL (`/programma/dygl/2887544`
 *   → 2887544) als stable hash-input. Paradiso hergebruikt die niet.
 */

const VENUE_ID = 'paradiso';
const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const HOMEPAGE = 'https://www.paradiso.nl';

const NL_MONTHS: Record<string, number> = {
  januari: 0, februari: 1, maart: 2, april: 3, mei: 4, juni: 5,
  juli: 6, augustus: 7, september: 8, oktober: 9, november: 10, december: 11,
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(parseInt(c, 10)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function extractOg(html: string, prop: string): string | null {
  const re = new RegExp(
    `<meta\\s+property="og:${prop}"\\s+content="([^"]+)"`,
    'i'
  );
  const m = html.match(re);
  return m ? decodeEntities(m[1]) : null;
}

/**
 * Extract Nederlandse datum (`28 oktober 2026`) uit een tekst-veld
 * (og:title óf og:description). Default 20:00 NL aanvang als geen
 * lichaams-tijd is.
 */
function parseDutchDate(text: string | null): Date | null {
  if (!text) return null;
  const m = text.match(/\b(\d{1,2})\s+(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)\s+(\d{4})\b/i);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = NL_MONTHS[m[2].toLowerCase()];
  const year = parseInt(m[3], 10);
  return shiftToLocalTime(year, month, day, 20, 0);
}

/**
 * Probeer een aanvang-tijd uit de body te lezen — Paradiso schrijft
 * meestal "Aanvang: 20:30" of "Doors: 20:00" in HTML. Returns null
 * als niet gevonden — caller valt terug op default 20:00.
 */
function parseStartTimeFromBody(html: string): { hour: number; minute: number } | null {
  // Zoek voor "Aanvang", "Show", "Concert", "Deuren"-context met tijd
  const patterns = [
    /Aanvang[:\s]+(\d{1,2}):(\d{2})/i,
    /Show[:\s]+(\d{1,2}):(\d{2})/i,
    /Concert[:\s]+(\d{1,2}):(\d{2})/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      const h = parseInt(m[1], 10);
      const mi = parseInt(m[2], 10);
      if (h <= 23 && mi <= 59) return { hour: h, minute: mi };
    }
  }
  return null;
}

function shiftToLocalTime(
  y: number, m: number, d: number, hour: number, minute: number
): Date {
  const tentative = new Date(Date.UTC(y, m, d, hour, minute, 0));
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Amsterdam',
    timeZoneName: 'longOffset',
  });
  const off = dtf
    .formatToParts(tentative)
    .find((p) => p.type === 'timeZoneName')?.value;
  const mm = off?.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  const sign = mm && mm[1] === '+' ? 1 : -1;
  const h = mm ? parseInt(mm[2], 10) : 0;
  const mins = mm ? parseInt(mm[3] ?? '0', 10) : 0;
  return new Date(tentative.getTime() - sign * (h * 60 + mins) * 60_000);
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

/** Render Paradiso event detail met Playwright en extract:
 *   - rich description (uit rendered DOM body)
 *   - hero image (uit rendered <img>, en URL upscalen naar 1200x)
 *   - aanvang-tijd (uit "Hoofdprogramma: HH:MM" in rendered tekst)
 *
 *  Per-event browser-call is duur; alleen gebruiken voor venues waar
 *  detail-data niet via platte fetch beschikbaar is. */
type ParadisoDetail = {
  description: string | null;
  imageUrl: string | null;
  hour: number | null;
  minute: number | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function renderDetail(browser: any, url: string): Promise<ParadisoDetail> {
  const ctx = await browser.newContext({ locale: 'nl-NL', userAgent: UA });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: ParadisoDetail = await page.evaluate(`(() => {
      const main = document.querySelector('main') ?? document.body;
      const text = main.innerText;
      // Description: pak alle paragrafen uit hoofdtekst, filter out
      // boilerplate ("Route naar Paradiso", "Cookies").
      const lines = text.split('\\n').map(s => s.trim()).filter(Boolean);
      const stop = lines.findIndex(l => /^(Line-up|Route|Accepteer|Bovenzaal\\s*$)/i.test(l));
      const start = lines.findIndex(l => l.length > 80);
      let desc = null;
      if (start >= 0) {
        const end = stop > start ? stop : Math.min(start + 6, lines.length);
        desc = lines.slice(start, end).filter(l => l.length > 30).join('\\n\\n');
      }

      // Image: pak grootste naturalWidth uit <img> die naar assets.paradiso.nl wijst.
      const imgs = Array.from(document.querySelectorAll('img'))
        .filter(i => /assets\\.paradiso\\.nl\\/images\\/transforms\\/event\\//.test(i.src))
        .sort((a, b) => (b.naturalWidth || 0) - (a.naturalWidth || 0));
      let imageUrl = imgs[0]?.src ?? null;
      // Upscale naar 1200x: Paradiso transform-pad heeft "_120x128_crop_..."
      // — vervang door grotere variant.
      if (imageUrl) {
        imageUrl = imageUrl.replace(
          /\\/transforms\\/event\\/_[0-9]+x[0-9]+_crop_center-center_(?:[0-9]+_)?none\\//,
          '/transforms/event/_1200x630_crop_center-center_none/'
        );
      }

      // Tijd: "Hoofdprogramma: 19:30" of "Aanvang: 19:30"
      const timeMatch = text.match(/(?:Hoofdprogramma|Aanvang|Show)[:\\s]+(\\d{1,2}):(\\d{2})/);
      const hour = timeMatch ? parseInt(timeMatch[1], 10) : null;
      const minute = timeMatch ? parseInt(timeMatch[2], 10) : null;

      return { description: desc, imageUrl, hour, minute };
    })()`);
    return result;
  } finally {
    await ctx.close();
  }
}

async function discoverEventUrls(): Promise<string[]> {
  const html = await fetchHtml(HOMEPAGE);
  if (!html) return [];
  const re = /\/programma\/[a-z0-9-]+\/(\d+)/g;
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const m of html.matchAll(re)) {
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    urls.push(`${HOMEPAGE}${m[0]}`);
  }
  return urls;
}

async function mirrorImage(
  sourceUrl: string,
  stableId: string
): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 8 * 1024 * 1024) return null;
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    const path = `media/events/par-${stableId}.${ext}`;
    return await uploadToBunny(path, buf, mime);
  } catch (e) {
    console.warn(`[paradiso] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type ParadisoResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeParadiso(options?: {
  venueIds?: string[];
}): Promise<ParadisoResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: ParadisoResult = {
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
    result.errors.push('venue paradiso niet in DB');
    return [result];
  }

  const urls = await discoverEventUrls();
  result.fetched = urls.length;
  const venueCategory = venue.categories?.[0] ?? 'Muziek';

  // Eén browser voor alle event-detail-renders — sneller dan een
  // nieuwe browser per event.
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });

  try {
  for (const url of urls) {
    try {
      const html = await fetchHtml(url);
      if (!html) { result.skipped++; continue; }
      const ogTitle = extractOg(html, 'title');
      const ogDescription = extractOg(html, 'description');
      if (!ogTitle) { result.skipped++; continue; }

      // Twee og:title-patterns:
      //   "DYGL - 15 juni 2026 - Paradiso"   → datum in title
      //   "Bel Cobain | Paradiso"            → datum in og:description ("Op 28 oktober 2026 geeft …")
      const cleanTitle = ogTitle
        .replace(/\s*\|\s*Paradiso\s*$/i, '')
        .split(' - ')[0]
        ?.trim() ?? ogTitle;
      const title = cleanTitle;
      let startsAt = parseDutchDate(ogTitle) ?? parseDutchDate(ogDescription);
      if (!startsAt) { result.skipped++; continue; }

      // Render detail-pagina voor rich description + image + tijd.
      // Per event ~3-5 sec — voor ~20 events totaal ~1-2 min.
      const detail = await renderDetail(browser, url);

      // Override default 20:00 met body-tijd als die er is.
      if (detail.hour != null && detail.minute != null) {
        const day = parseInt(
          new Intl.DateTimeFormat('nl-NL', {
            timeZone: 'Europe/Amsterdam',
            day: '2-digit',
          }).format(startsAt),
          10
        );
        startsAt = shiftToLocalTime(
          startsAt.getUTCFullYear(),
          startsAt.getUTCMonth(),
          day,
          detail.hour,
          detail.minute
        );
      }

      const description = detail.description ?? ogDescription;
      const imageSource = detail.imageUrl ?? extractOg(html, 'image');

      const idMatch = url.match(/\/(\d+)$/);
      const stableId = idMatch ? idMatch[1] : url.split('/').pop() ?? url;
      const eventId = `evt-par-${VENUE_ID}-${stableId}`;
      const occurrenceId = `occ-par-${VENUE_ID}-${stableId}`;

      const enriched = await enrichEvent({
        title,
        description,
        venueName: venue.name,
        venueCategory,
      });

      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      let imageUrl: string | null = null;
      if (!existing && imageSource) {
        imageUrl = (await mirrorImage(imageSource, stableId)) ?? null;
      }

      const refinedKind = refineKindByDuration(enriched.kind, startsAt, null);

      await db.transaction(async (tx) => {
        if (!existing) {
          await tx.insert(schema.events).values({
            id: eventId,
            venueId: venue.id,
            title,
            description: enriched.cleanedDescription ?? description,
            kind: refinedKind,
            imageUrl,
            category: enriched.category ?? venueCategory,
            featured: false,
            genres: enriched.genres,
            published: true,
          });
          result.inserted++;
        }

        await tx
          .insert(schema.occurrences)
          .values({
            id: occurrenceId,
            eventId,
            startsAt,
            endsAt: null,
            priceCents: null,
            priceNote: enriched.priceNote,
            ticketUrl: url,
            room: enriched.room,
            lineup: enriched.lineup,
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: {
              startsAt,
              priceNote: enriched.priceNote,
              ticketUrl: url,
              room: enriched.room,
              lineup: enriched.lineup,
            },
          });
        result.occurrencesUpserted++;
      });
    } catch (e) {
      result.errors.push(`event ${url}: ${(e as Error).message}`);
      result.skipped++;
    }
  }
  } finally {
    await browser.close();
  }

  return [result];
}
