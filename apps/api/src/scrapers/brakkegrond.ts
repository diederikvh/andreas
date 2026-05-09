import { eq } from 'drizzle-orm';
import { chromium, type Browser } from 'playwright';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Vlaams Cultuurhuis De Brakke Grond. Hun /agenda is volledig CSR
 * (klanten-side rendered) en detail-pages óók — geen JSON-LD, geen
 * og-meta met betekenisvolle description, geen sitemap die helpt.
 *
 * Strategie:
 *  1. Playwright open `/agenda`, harvest show-URLs `/agenda/{id}/{slug}`
 *  2. Per show-page (Playwright, `domcontentloaded` want `networkidle`
 *     timeout't door long-poll websockets):
 *       - h1 → title
 *       - .text-block.block (NL) → description
 *       - figure.gallery-block__image img → image
 *       - body text "Data di 02 jun, 20:00 — 21:35 wo 03 jun, ..."
 *         → parse Dutch dates voor occurrences
 *
 * Title-grouping: één event-row per show, N occurrences per speeldag
 * (multi-night theater is regel hier).
 *
 * Idempotency:
 *  - eventId      = `evt-bg-{showId}` (numeriek deel uit URL)
 *  - occurrenceId = `occ-bg-{showId}-{YYYY-MM-DD}T{HH-MM}`
 */

const VENUE_ID = 'de-brakke-grond';
const UA = 'Mozilla/5.0 (Andreas/1.0)';
const AGENDA_URL = 'https://brakkegrond.nl/agenda';

const DUTCH_MONTHS_SHORT: Record<string, number> = {
  jan: 1, feb: 2, mrt: 3, mar: 3, maart: 3, apr: 4, mei: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dec: 12,
};

type Slot = { startsAt: Date; endsAt: Date | null };
type ShowMeta = {
  url: string;
  showId: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  slots: Slot[];
};

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function parseDutchDateTime(dayMonth: string, time: string, anchor: Date): Date | null {
  const m = dayMonth.toLowerCase().match(/(\d{1,2})\s+(\w{3,})/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = DUTCH_MONTHS_SHORT[m[2].slice(0, 3)];
  if (!month) return null;
  const t = time.match(/(\d{1,2}):(\d{2})/);
  if (!t) return null;
  const hh = parseInt(t[1], 10);
  const mm = parseInt(t[2], 10);

  for (const y of [anchor.getFullYear(), anchor.getFullYear() + 1, anchor.getFullYear() - 1]) {
    const d = new Date(`${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+02:00`);
    if (isNaN(d.getTime())) continue;
    const delta = d.getTime() - anchor.getTime();
    if (delta > -7 * 24 * 60 * 60 * 1000 && delta < 365 * 24 * 60 * 60 * 1000) return d;
  }
  return null;
}

/**
 * Parse "di 02 jun, 20:00 — 21:35 wo 03 jun, 20:00 — 21:35" naar slots.
 * Format na de string "Data": dag-naam + dag + maand + ", " + tijd "—" tijd.
 */
function parseSlotsFromBody(bodyText: string): Slot[] {
  const slots: Slot[] = [];
  const now = new Date();
  // Capture "DD MMM, HH:MM — HH:MM" (or "HH:MM" without end)
  const re = /(?:ma|di|wo|do|vr|za|zo)\s+(\d{1,2}\s+(?:jan|feb|mrt|maart|apr|mei|jun|jul|aug|sep|okt|nov|dec)\w*)\s*,\s*(\d{1,2}:\d{2})(?:\s*[—-]\s*(\d{1,2}:\d{2}))?/gi;
  for (const m of bodyText.matchAll(re)) {
    const startsAt = parseDutchDateTime(m[1], m[2], now);
    if (!startsAt) continue;
    let endsAt: Date | null = null;
    if (m[3]) {
      const end = parseDutchDateTime(m[1], m[3], now);
      if (end && end.getTime() > startsAt.getTime()) endsAt = end;
    }
    slots.push({ startsAt, endsAt });
  }
  return slots;
}

async function harvestShowUrls(browser: Browser): Promise<string[]> {
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();
  try {
    await page.goto(AGENDA_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    // Trigger render door scroll
    for (let i = 0; i < 4; i++) {
      await page.evaluate(`window.scrollTo(0, document.body.scrollHeight * ${(i + 1) / 4})`);
      await page.waitForTimeout(500);
    }
    const urls = (await page.evaluate(`(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/agenda/"]'));
      const out = new Set();
      const re = /\\/agenda\\/(\\d+)\\/[a-z][a-z0-9-]+$/;
      for (const a of links) {
        const href = a.href || '';
        if (re.test(href)) out.add(href);
      }
      return Array.from(out);
    })()`)) as string[];
    return urls;
  } finally {
    await ctx.close();
  }
}

async function fetchShowMeta(browser: Browser, url: string): Promise<ShowMeta | null> {
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    // Scroll naar onder voor lazy content
    await page.evaluate(`window.scrollTo(0, document.body.scrollHeight)`);
    await page.waitForTimeout(800);

    const data = (await page.evaluate(`(() => {
      const h1 = document.querySelector('h1');
      const title = h1 ? (h1.textContent || '').replace(/\\s+/g, ' ').trim() : '';
      // Image: fullscreen--trigger data-src is hi-res; img src is thumb
      const fs = document.querySelector('.fullscreen--trigger[data-src]');
      const galleryImg = document.querySelector('.gallery-block__item-image');
      const image = (fs && fs.getAttribute('data-src')) || (galleryImg && galleryImg.src) || '';
      // Description (NL eerst): meerdere .text-block kunnen voorkomen,
      // pak de eerste die niet alleen credits/whitespace heeft.
      const blocks = Array.from(document.querySelectorAll('.text-block.block, .text-block, .event-detail__english-description'));
      let description = '';
      for (const b of blocks) {
        const t = (b.textContent || '').replace(/\\s+/g, ' ').trim();
        if (t.length > 80) { description = t; break; }
      }
      // Body text voor datums (Ticketinfo sectie)
      const main = document.querySelector('main, article, [class*="event-detail"]');
      const bodyText = main ? (main.textContent || '').replace(/\\s+/g, ' ').trim() : '';
      return { title, image, description, bodyText };
    })()`)) as { title: string; image: string; description: string; bodyText: string };

    if (!data.title) return null;
    const idMatch = url.match(/\/agenda\/(\d+)\//);
    const showId = idMatch?.[1] ?? slugify(data.title);
    const slots = parseSlotsFromBody(data.bodyText);
    if (slots.length === 0) return null;

    return {
      url,
      showId,
      title: data.title,
      description: data.description.length > 30 ? data.description : null,
      imageUrl: data.image && !data.image.startsWith('data:') ? data.image : null,
      slots,
    };
  } catch {
    return null;
  } finally {
    await ctx.close();
  }
}

async function mirrorImage(sourceUrl: string, slug: string): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 8 * 1024 * 1024) return null;
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    return await uploadToBunny(`media/events/bg-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[brakkegrond] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type BrakkeGrondResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeBrakkeGrond(options?: {
  venueIds?: string[];
}): Promise<BrakkeGrondResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: BrakkeGrondResult = {
    venueId: VENUE_ID, fetched: 0, inserted: 0, occurrencesUpserted: 0, skipped: 0, errors: [],
  };

  const [venue] = await db.select().from(schema.venues).where(eq(schema.venues.id, VENUE_ID));
  if (!venue) {
    result.errors.push('venue niet in DB');
    return [result];
  }
  const venueCategory = venue.categories?.[0] ?? 'Theater';

  const browser = await chromium.launch();
  try {
    const urls = await harvestShowUrls(browser);
    result.fetched = urls.length;
    if (urls.length === 0) {
      result.errors.push('geen show-URLs op /agenda');
      return [result];
    }

    const cutoff = Date.now() - 6 * 60 * 60 * 1000;

    for (const url of urls) {
      try {
        const meta = await fetchShowMeta(browser, url);
        if (!meta) { result.skipped++; continue; }

        const futureSlots = meta.slots.filter((s) => (s.endsAt ?? s.startsAt).getTime() > cutoff);
        if (futureSlots.length === 0) { result.skipped++; continue; }

        const eventId = `evt-bg-${meta.showId}`;
        const [existing] = await db
          .select({ id: schema.events.id })
          .from(schema.events)
          .where(eq(schema.events.id, eventId))
          .limit(1);

        let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;

        if (!existing) {
          let imageUrl: string | null = null;
          if (meta.imageUrl) {
            imageUrl = (await mirrorImage(meta.imageUrl, meta.showId)) ?? meta.imageUrl;
          }
          try {
            enriched = await enrichEvent({
              title: meta.title,
              description: meta.description,
              venueName: venue.name,
              venueCategory,
            });
          } catch (e) {
            result.errors.push(`enrich ${meta.title}: ${(e as Error).message}`);
          }

          const headStart = futureSlots[0]!.startsAt;
          const headEnd = futureSlots[0]!.endsAt;
          const eventKind = refineKindByDuration(enriched?.kind ?? 'show', headStart, headEnd);

          try {
            await db.insert(schema.events).values({
              id: eventId,
              venueId: venue.id,
              title: meta.title,
              description: enriched?.cleanedDescription ?? meta.description,
              kind: eventKind,
              imageUrl,
              category: enriched?.category ?? venueCategory,
              featured: false,
              genres: enriched?.genres ?? [],
              published: true,
            });
            result.inserted++;
          } catch (e) {
            result.errors.push(`insert event ${eventId}: ${(e as Error).message}`);
            continue;
          }
        }

        for (const slot of futureSlots) {
          try {
            const isoDate = slot.startsAt.toISOString().slice(0, 10);
            const isoTime = slot.startsAt.toISOString().slice(11, 16).replace(':', '-');
            const occurrenceId = `occ-bg-${meta.showId}-${isoDate}T${isoTime}`;
            await db
              .insert(schema.occurrences)
              .values({
                id: occurrenceId,
                eventId,
                startsAt: slot.startsAt,
                endsAt: slot.endsAt,
                priceCents: null,
                priceNote: existing ? null : (enriched?.priceNote ?? null),
                ticketUrl: meta.url,
                room: null,
                lineup: existing ? null : (enriched?.lineup ?? null),
                status: 'scheduled',
              })
              .onConflictDoUpdate({
                target: schema.occurrences.id,
                set: { startsAt: slot.startsAt, endsAt: slot.endsAt, ticketUrl: meta.url },
              });
            result.occurrencesUpserted++;
          } catch (err) {
            result.errors.push(`occurrence ${meta.url} ${slot.startsAt.toISOString()}: ${(err as Error).message}`);
            result.skipped++;
          }
        }
      } catch (e) {
        result.errors.push(`show ${url}: ${(e as Error).message}`);
        result.skipped++;
      }
    }
  } finally {
    await browser.close();
  }

  return [result];
}
