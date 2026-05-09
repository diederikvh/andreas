import { eq } from 'drizzle-orm';
import { chromium, type Browser } from 'playwright';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Fourvenues iframe-widget scraper. URL-vorm:
 *
 *   https://web.fourvenues.com/en/iframe/{slug}/events?date=YYYY-MM
 *
 * Events worden client-side gerenderd in `<div class="flex-grow relative p-3">`
 * tiles met text-format `{Day} {DD} {MMM} {start-time} {end-time} {title}`.
 * Per maand één page-load. Geen API-key, pure Playwright.
 *
 * Images: fourvenues serveert via `cdn-cgi/imagedelivery` maar koppelen
 * aan de tile is fragiel — voor MVP alleen titel + datum + tijd. Image
 * via `enrichEvent`/eigen-site augmentatie kan later.
 *
 * Ticket-link: events zijn niet linkable in de iframe — we gebruiken
 * `https://web.fourvenues.com/en/iframe/{slug}/events?date=YYYY-MM` als
 * ticket-URL (algemeen ticketshop).
 *
 * Idempotency:
 *  - eventId      = `evt-fv-{venueId}-{slugify(date+title)}`
 *  - occurrenceId = `occ-fv-{venueId}-{slugify(date+title)}`
 */

const UA = 'Mozilla/5.0 (Andreas/1.0)';
const MONTHS_AHEAD = 4;

const ENGLISH_MONTHS: Record<string, number> = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

type Tile = {
  date: string;        // "Sat 09 May"
  startTime: string;   // "23:00"
  endTime: string;     // "06:00"
  title: string;
  monthYear: string;   // "2026-05"
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

/** "Sat 09 May" + "23:00" → Date in juiste jaar (kies dichtstbijzijnde
 *  toekomstige). monthYear hint helpt bij december/januari edge-cases. */
function parseDateTime(date: string, time: string, monthYearHint: string): Date | null {
  const m = date.match(/(\d{1,2})\s+(\w{3})/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = ENGLISH_MONTHS[m[2]];
  if (!month) return null;
  const t = time.match(/(\d{1,2}):(\d{2})/);
  if (!t) return null;
  const hh = parseInt(t[1], 10);
  const mm = parseInt(t[2], 10);
  // monthYearHint is bv. "2026-05"; gebruik year uit hint als anchor
  const anchorYear = parseInt(monthYearHint.split('-')[0], 10) || new Date().getFullYear();
  for (const y of [anchorYear, anchorYear + 1, anchorYear - 1]) {
    const d = new Date(`${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+02:00`);
    if (isNaN(d.getTime())) continue;
    const delta = d.getTime() - Date.now();
    if (delta > -7 * 24 * 60 * 60 * 1000 && delta < 200 * 24 * 60 * 60 * 1000) return d;
  }
  return null;
}

async function fetchTilesForMonth(browser: Browser, slug: string, monthYear: string): Promise<Tile[]> {
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();
  try {
    const url = `https://web.fourvenues.com/en/iframe/${slug}/events?date=${monthYear}`;
    // `networkidle` timeout't soms door long-poll WebSockets; gebruik
    // `domcontentloaded` + manuele wait voor de tile-render.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4500);
    const tiles = (await page.evaluate(`(() => {
      const inners = Array.from(document.querySelectorAll('div.flex-grow.relative.p-3'));
      const out = [];
      for (const inner of inners) {
        const text = (inner.textContent || '').replace(/\\s+/g, ' ').trim();
        // "Sat 09 May 23:00 06:00 Shelter | De Sluwe Vos curates"
        const m = text.match(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\\s+(\\d{1,2}\\s+\\w{3})\\s+(\\d{1,2}:\\d{2})\\s+(\\d{1,2}:\\d{2})\\s+(.+)$/);
        if (!m) continue;
        out.push({ date: m[1], startTime: m[2], endTime: m[3], title: m[4].trim() });
      }
      return out;
    })()`)) as Array<{ date: string; startTime: string; endTime: string; title: string }>;
    return tiles.map((t) => ({ ...t, monthYear }));
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
    if (buf.byteLength < 1024 || buf.byteLength > 16 * 1024 * 1024) return null;
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    return await uploadToBunny(`media/events/fv-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[fourvenues] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type FourvenuesResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeFourvenues(options?: {
  venueIds?: string[];
}): Promise<FourvenuesResult[]> {
  const allVenues = await db.select().from(schema.venues);
  const targets = allVenues.filter((v) => {
    if (options?.venueIds && !options.venueIds.includes(v.id)) return false;
    return Boolean(v.scraperConfig?.fourvenues?.slug);
  });

  const results: FourvenuesResult[] = [];
  if (targets.length === 0) return results;

  const browser = await chromium.launch();
  try {
    for (const venue of targets) {
      const cfg = venue.scraperConfig!.fourvenues!;
      const result: FourvenuesResult = {
        venueId: venue.id, fetched: 0, inserted: 0, occurrencesUpserted: 0, skipped: 0, errors: [],
      };
      const venueCategory = venue.categories?.[0] ?? 'Muziek';

      // Fetch tiles voor 4 maanden vooruit
      const allTiles: Tile[] = [];
      const now = new Date();
      for (let i = 0; i < MONTHS_AHEAD; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
        const monthYear = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        try {
          const tiles = await fetchTilesForMonth(browser, cfg.slug, monthYear);
          allTiles.push(...tiles);
        } catch (e) {
          result.errors.push(`month ${monthYear}: ${(e as Error).message}`);
        }
      }

      // Dedup op (date+title) — events kunnen in meerdere maanden voorkomen
      const seen = new Set<string>();
      const unique = allTiles.filter((t) => {
        const key = `${t.date}__${t.title.toLowerCase()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      result.fetched = unique.length;

      const cutoff = Date.now() - 6 * 60 * 60 * 1000;

      for (const tile of unique) {
        try {
          const startsAt = parseDateTime(tile.date, tile.startTime, tile.monthYear);
          if (!startsAt || startsAt.getTime() < cutoff) {
            result.skipped++;
            continue;
          }
          // End: als endTime < startTime, dan volgende dag
          let endsAt: Date | null = parseDateTime(tile.date, tile.endTime, tile.monthYear);
          if (endsAt && endsAt.getTime() < startsAt.getTime()) {
            endsAt = new Date(endsAt.getTime() + 24 * 60 * 60 * 1000);
          }

          const titleSlug = slugify(`${tile.date}-${tile.title}`);
          if (!titleSlug) { result.skipped++; continue; }
          const eventId = `evt-fv-${venue.id}-${titleSlug}`;
          const [existing] = await db
            .select({ id: schema.events.id })
            .from(schema.events)
            .where(eq(schema.events.id, eventId))
            .limit(1);

          let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;

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
            const eventKind = refineKindByDuration(enriched?.kind ?? 'show', startsAt, endsAt);
            try {
              await db.insert(schema.events).values({
                id: eventId,
                venueId: venue.id,
                title: tile.title,
                description: enriched?.cleanedDescription ?? null,
                kind: eventKind,
                imageUrl: null,
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

          try {
            const occurrenceId = `occ-fv-${venue.id}-${titleSlug}`;
            const ticketUrl = `https://web.fourvenues.com/en/iframe/${cfg.slug}/events?date=${tile.monthYear}`;
            await db
              .insert(schema.occurrences)
              .values({
                id: occurrenceId,
                eventId,
                startsAt,
                endsAt,
                priceCents: null,
                priceNote: existing ? null : (enriched?.priceNote ?? null),
                ticketUrl,
                room: null,
                lineup: existing ? null : (enriched?.lineup ?? null),
                status: 'scheduled',
              })
              .onConflictDoUpdate({
                target: schema.occurrences.id,
                set: { startsAt, endsAt, ticketUrl },
              });
            result.occurrencesUpserted++;
          } catch (e) {
            result.errors.push(`occurrence ${tile.title}: ${(e as Error).message}`);
            result.skipped++;
          }
        } catch (e) {
          result.errors.push(`tile ${tile.title}: ${(e as Error).message}`);
          result.skipped++;
        }
      }
      // Suppress unused-import lint
      void mirrorImage;
      results.push(result);
    }
  } finally {
    await browser.close();
  }

  return results;
}
