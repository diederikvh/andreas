import { eq } from 'drizzle-orm';
import { chromium } from 'playwright';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Radio Radio (Westerpark) — eigen Nuxt-site `radioradio.radio/club`.
 *
 * Strategie: de page is een Nuxt-app met de hele DatoCMS-payload inline
 * in `window.__NUXT__.data.{key}.data.allEvents`. Elke event-record bevat:
 *  - `title`, `description`, `date` (YYYY-MM-DD), `startTime`/`endTime` (HH:MM)
 *  - `ticket` (directe Weeztix/RA-URL)
 *  - `image.responsiveImage.src` (DatoCMS image)
 *  - `id` (stable DatoCMS UUID)
 *
 * Dat is rijker dan de Weeztix-shop API, dus deze scraper vervangt
 * de Weeztix-bron voor radioradio. Andere Weeztix-clubs blijven die
 * scraper gebruiken.
 *
 * Idempotency:
 *  - eventId      = `evt-rr-{venueId}-{slugifiedId}`
 *  - occurrenceId = `occ-rr-{venueId}-{slugifiedId}`
 */

const UA = 'Mozilla/5.0 (Andreas/1.0)';
const VENUE_ID = 'radio-radio';
const PROGRAM_URL = 'https://radioradio.radio/club';

type DatoEvent = {
  id: string;
  title: string;
  description: string | null;
  date: string;        // "2026-05-09"
  startTime: string;   // "15:00"
  endTime: string;     // "22:00"
  ticket: string | null;
  soldOut: boolean;
  label?: string | null;
  image?: {
    responsiveImage?: { src?: string; width?: number; height?: number };
  } | null;
  artists?: Array<{ name?: string }>;
};

function slugifyId(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

async function fetchAllEvents(): Promise<DatoEvent[]> {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ userAgent: UA });
    const page = await ctx.newPage();
    await page.goto(PROGRAM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    const events = (await page.evaluate(`(() => {
      const nuxt = window.__NUXT__;
      if (!nuxt || !nuxt.data) return [];
      for (const k of Object.keys(nuxt.data)) {
        const v = nuxt.data[k];
        if (v?.data?.allEvents && Array.isArray(v.data.allEvents)) {
          return v.data.allEvents;
        }
      }
      return [];
    })()`)) as DatoEvent[];
    return events;
  } finally {
    await browser.close();
  }
}

/** "2026-05-09" + "23:00" → Date in Amsterdam (CEST/CET via +02:00). */
function buildDate(date: string, time: string): Date | null {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const t = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!m || !t) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${t[1].padStart(2, '0')}:${t[2]}:00+02:00`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
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
    return await uploadToBunny(`media/events/rr-${key}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[radioradio] mirror image ${key}: ${(e as Error).message}`);
    return null;
  }
}

export type RadioRadioResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeRadioRadio(options?: { venueIds?: string[] }): Promise<RadioRadioResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];
  const [venue] = await db.select().from(schema.venues).where(eq(schema.venues.id, VENUE_ID));
  if (!venue) return [];

  const result: RadioRadioResult = {
    venueId: VENUE_ID, fetched: 0, inserted: 0, occurrencesUpserted: 0, skipped: 0, errors: [],
  };

  let events: DatoEvent[];
  try {
    events = await fetchAllEvents();
  } catch (e) {
    result.errors.push(`fetch program: ${(e as Error).message}`);
    return [result];
  }

  result.fetched = events.length;
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  const venueCategory = venue.categories?.[0] ?? 'Muziek';

  for (const ev of events) {
    try {
      const startsAt = buildDate(ev.date, ev.startTime);
      if (!startsAt || startsAt.getTime() < cutoff) { result.skipped++; continue; }
      let endsAt = buildDate(ev.date, ev.endTime);
      if (endsAt && endsAt.getTime() < startsAt.getTime()) {
        endsAt = new Date(endsAt.getTime() + 24 * 60 * 60 * 1000);
      }

      const idSlug = slugifyId(ev.id);
      if (!idSlug) { result.skipped++; continue; }
      const eventId = `evt-rr-${VENUE_ID}-${idSlug}`;
      const occurrenceId = `occ-rr-${VENUE_ID}-${idSlug}`;

      const title = (ev.title ?? '').trim();
      if (!title) { result.skipped++; continue; }
      const description = ev.description?.trim() || null;

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
            title,
            description,
            venueName: venue.name,
            venueCategory,
          });
        } catch (e) {
          result.errors.push(`enrich ${title}: ${(e as Error).message}`);
        }

        const src = ev.image?.responsiveImage?.src ?? null;
        if (src) imageUrl = await mirrorImage(src, `${VENUE_ID}-${idSlug}`);

        const eventKind = refineKindByDuration(enriched?.kind ?? 'show', startsAt, endsAt);

        try {
          await db.insert(schema.events).values({
            id: eventId,
            venueId: VENUE_ID,
            title,
            description: enriched?.cleanedDescription ?? description,
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
        const status = ev.soldOut ? 'sold_out' : 'scheduled';
        await db
          .insert(schema.occurrences)
          .values({
            id: occurrenceId,
            eventId,
            startsAt,
            endsAt,
            priceCents: null,
            priceNote: existing ? null : (enriched?.priceNote ?? null),
            ticketUrl: ev.ticket ?? null,
            room: null,
            lineup: existing ? null : (enriched?.lineup ?? null),
            status,
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: { startsAt, endsAt, ticketUrl: ev.ticket ?? null, status },
          });
        result.occurrencesUpserted++;
      } catch (e) {
        result.errors.push(`occurrence ${ev.id}: ${(e as Error).message}`);
        result.skipped++;
      }
    } catch (e) {
      result.errors.push(`event ${ev.id}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
