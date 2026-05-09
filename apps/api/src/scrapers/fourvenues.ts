import { eq } from 'drizzle-orm';
import { chromium, type Browser } from 'playwright';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Fourvenues iframe-widget scraper. URL-vorm (de slug kan `@`/`:` bevatten
 * en moet daarom URL-encoded):
 *
 *   https://site.fourvenues.com/en/iframe/{encodeURIComponent(slug)}/events?date=YYYY-MM
 *
 * Events zitten in `<app-event-card>` Angular-componenten. Tile-tekst:
 *   `{title} {Day}, {Mon} {DD}{Day}, {Mon} {DD}{HH:MM AM/PM}{HH:MM AM/PM} {venueName} More info`
 * (de date-rij staat 2× voor accessibility). Image-src in een nested
 * `<img src="https://fourvenues.com/cdn-cgi/imagedelivery/.../width=534">`.
 *
 * Ticket-link: per tile een fourvenues short-id URL (bv.
 * `…/events/7BVU?date=2026-05`), met fallback naar de maand-URL.
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
  monthAnchor: number; // 1-12
  day: number;         // 1-31
  startTime: string;   // "23:00" (24h)
  endTime: string;     // "06:00" (24h)
  title: string;
  imageUrl: string | null;
  ticketUrl: string | null;
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

/** "09:00 PM" → 21:00; "12:00 AM" → 00:00; "03:00 AM" → 03:00. */
function to24h(timeAmPm: string): string | null {
  const m = timeAmPm.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const isPm = m[3].toUpperCase() === 'PM';
  if (hh === 12) hh = 0;
  if (isPm) hh += 12;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** Day + month + 24h-time + monthYearHint → Date (Amsterdam, +02:00). */
function buildDate(month: number, day: number, time: string, monthYearHint: string): Date | null {
  const t = time.match(/(\d{2}):(\d{2})/);
  if (!t) return null;
  const hh = parseInt(t[1], 10);
  const mm = parseInt(t[2], 10);
  const anchorYear = parseInt(monthYearHint.split('-')[0], 10) || new Date().getFullYear();
  for (const y of [anchorYear, anchorYear + 1, anchorYear - 1]) {
    const d = new Date(`${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+02:00`);
    if (isNaN(d.getTime())) continue;
    const delta = d.getTime() - Date.now();
    if (delta > -7 * 24 * 60 * 60 * 1000 && delta < 240 * 24 * 60 * 60 * 1000) return d;
  }
  return null;
}

/** Higher-res image-URL: vervang `width=534` door `width=800`. */
function upscaleImage(src: string): string {
  return src.replace(/width=\d+/, 'width=800');
}

type RawTile = {
  text: string;
  imageUrl: string | null;
  ticketUrl: string | null;
};

async function fetchTilesForMonth(browser: Browser, slug: string, monthYear: string): Promise<Tile[]> {
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();
  try {
    const slugEnc = encodeURIComponent(slug);
    const url = `https://site.fourvenues.com/en/iframe/${slugEnc}/events?date=${monthYear}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4500);
    // Trigger lazy-loading van images
    for (let i = 0; i < 4; i++) {
      await page.evaluate(`window.scrollTo(0, document.body.scrollHeight * ${(i + 1) / 4})`);
      await page.waitForTimeout(400);
    }

    const raw = (await page.evaluate(`(() => {
      const cards = Array.from(document.querySelectorAll('app-event-card'));
      return cards.map(card => {
        const text = (card.textContent || '').replace(/\\s+/g, ' ').trim();
        const img = card.querySelector('img[src*="imagedelivery"]');
        const link = card.querySelector('a[href*="/events/"]');
        // Angular gebruikt SkipLocationChange-style routing waarbij ?/= in
        // de href URL-encoded staan (%3F/%3D); fix terug naar query-string.
        const fixedHref = link
          ? link.href.replace(/%3F/g, '?').replace(/%3D/g, '=')
          : null;
        return { text, imageUrl: img ? img.src : null, ticketUrl: fixedHref };
      });
    })()`)) as RawTile[];

    const monthAnchor = parseInt(monthYear.split('-')[1], 10);

    const tiles: Tile[] = [];
    for (const r of raw) {
      // Tekst: "Madam by Night invites: Guerrilla Sat, May 9Sat, May 909:00 PM03:00 AM Madam More info"
      // De date-rij staat 2× herhaald — match dat met optionele tweede groep.
      const m = r.text.match(/^(.+?)\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+(\w{3})\s+(\d{1,2})(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+\w{3}\s+\d{1,2})?\s*(\d{1,2}:\d{2}\s*(?:AM|PM))\s*(\d{1,2}:\d{2}\s*(?:AM|PM))/);
      if (!m) continue;
      const title = m[1].trim();
      const month = ENGLISH_MONTHS[m[2]];
      const day = parseInt(m[3], 10);
      const start24 = to24h(m[4]);
      const end24 = to24h(m[5]);
      if (!month || !start24 || !end24 || !title) continue;
      tiles.push({
        monthAnchor: month,
        day,
        startTime: start24,
        endTime: end24,
        title,
        imageUrl: r.imageUrl ? upscaleImage(r.imageUrl) : null,
        ticketUrl: r.ticketUrl,
        monthYear,
      });
    }
    void monthAnchor;
    return tiles;
  } finally {
    await ctx.close();
  }
}

async function mirrorImage(sourceUrl: string, key: string): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength < 1024 || buf.byteLength > 16 * 1024 * 1024) return null;
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    return await uploadToBunny(`media/events/fv-${key}.${ext}`, buf, mime);
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

      // Dedup op (month-day+title) — events kunnen in meerdere maanden voorkomen
      const seen = new Set<string>();
      const unique = allTiles.filter((t) => {
        const key = `${t.monthAnchor}-${t.day}__${t.title.toLowerCase()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      result.fetched = unique.length;

      const cutoff = Date.now() - 6 * 60 * 60 * 1000;

      for (const tile of unique) {
        try {
          const startsAt = buildDate(tile.monthAnchor, tile.day, tile.startTime, tile.monthYear);
          if (!startsAt || startsAt.getTime() < cutoff) {
            result.skipped++;
            continue;
          }
          // End: als endTime < startTime, dan volgende dag
          let endsAt: Date | null = buildDate(tile.monthAnchor, tile.day, tile.endTime, tile.monthYear);
          if (endsAt && endsAt.getTime() < startsAt.getTime()) {
            endsAt = new Date(endsAt.getTime() + 24 * 60 * 60 * 1000);
          }

          const dateLabel = `${String(tile.monthAnchor).padStart(2, '0')}-${String(tile.day).padStart(2, '0')}`;
          const titleSlug = slugify(`${dateLabel}-${tile.title}`);
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
            const imageUrl = tile.imageUrl
              ? await mirrorImage(tile.imageUrl, `${venue.id}-${titleSlug}`)
              : null;
            try {
              await db.insert(schema.events).values({
                id: eventId,
                venueId: venue.id,
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
              result.errors.push(`insert event ${eventId}: ${(e as Error).message}`);
              continue;
            }
          }

          try {
            const occurrenceId = `occ-fv-${venue.id}-${titleSlug}`;
            const slugEnc = encodeURIComponent(cfg.slug);
            const ticketUrl = tile.ticketUrl
              ?? `https://site.fourvenues.com/en/iframe/${slugEnc}/events?date=${tile.monthYear}`;
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
      results.push(result);
    }
  } finally {
    await browser.close();
  }

  return results;
}
