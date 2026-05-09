import { eq } from 'drizzle-orm';
import { chromium } from 'playwright';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Skatecafe Karin & Yvonne — `skatecafe.weticket.io/` (WeTicket Next-app).
 *
 * Aanpak: de listing-page rendert SSR en bevat een `<script id="__NEXT_DATA__">`
 * met `props.pageProps.organisationWithShops.upcoming_events` — een rijke
 * lijst met name/slug/cover_photo/first_date/last_date/location_name.
 *
 * WeTicket zit achter een Vercel Security Checkpoint, dus pure HTTP krijgt
 * een challenge-page. Playwright omzeilt die, vandaar lokaal-only.
 *
 * Filter op `location_name === venue.name`: events bij externe locaties
 * (bv. STUZZI @ Melkweg) worden niet aan Skatecafe toegekend.
 *
 * Idempotency:
 *  - eventId      = `evt-skatecafe-{slug}`
 *  - occurrenceId = `occ-skatecafe-{slug}`
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36';
const VENUE_ID = 'skatecafe';
const LISTING_URL = 'https://skatecafe.weticket.io/';
const SHOP_BASE = 'https://skatecafe.weticket.io';

type WeTicketShop = {
  uuid: string;
  slug: string;
  name: string;
  location_name: string | null;
  type: string;
  is_hidden: boolean;
  is_published: boolean;
  upcoming_date: string | null;  // "YYYY-MM-DD HH:mm" (Amsterdam)
  first_date: string | null;
  last_date: string | null;
  cover_photo?: { path_url?: string; mime_type?: string } | null;
};

function decodeHtmlEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/** "2026-05-09 22:00" (Amsterdam, lokaal) → Date in UTC. */
function buildDate(s: string | null): Date | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  // Geen TZ-info in de string; Amsterdam is +02:00 (CEST) in zomer.
  // Gebruik dezelfde +02:00-anchor als andere CET-scrapers.
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+02:00`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** Strip "[UITVERKOCHT]" / "[SOLD OUT]" / overige status-tags uit titel. */
function cleanTitle(name: string): { title: string; soldOut: boolean } {
  const decoded = decodeHtmlEntities(name);
  const soldOut = /\[(?:UITVERKOCHT|SOLD\s*OUT)\]/i.test(decoded);
  const title = decoded.replace(/\s*\[(?:UITVERKOCHT|SOLD\s*OUT)\]\s*$/i, '').trim();
  return { title, soldOut };
}

async function fetchUpcomingEvents(): Promise<WeTicketShop[]> {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ userAgent: UA });
    const page = await ctx.newPage();
    await page.goto(LISTING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3500);
    const events = (await page.evaluate(`(() => {
      const s = document.querySelector('script#__NEXT_DATA__');
      if (!s) return [];
      try {
        const json = JSON.parse(s.textContent);
        return json.props?.pageProps?.organisationWithShops?.upcoming_events ?? [];
      } catch { return []; }
    })()`)) as WeTicketShop[];
    return events;
  } finally {
    await browser.close();
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
    return await uploadToBunny(`media/events/skatecafe-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[skatecafe] mirror image ${slug}: ${(e as Error).message}`);
    return null;
  }
}

export type SkatecafeResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeSkatecafe(options?: { venueIds?: string[] }): Promise<SkatecafeResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];
  const [venue] = await db.select().from(schema.venues).where(eq(schema.venues.id, VENUE_ID));
  if (!venue) return [];

  const result: SkatecafeResult = {
    venueId: VENUE_ID, fetched: 0, inserted: 0, occurrencesUpserted: 0, skipped: 0, errors: [],
  };

  let shops: WeTicketShop[];
  try {
    shops = await fetchUpcomingEvents();
  } catch (e) {
    result.errors.push(`fetch: ${(e as Error).message}`);
    return [result];
  }

  // Filter alleen events bij Skatecafe zelf (externe shows skippen).
  const own = shops.filter((s) => s.location_name === venue.name && s.is_published && !s.is_hidden);
  result.fetched = own.length;

  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  const venueCategory = venue.categories?.[0] ?? 'Muziek';

  for (const shop of own) {
    try {
      const startsAt = buildDate(shop.first_date ?? shop.upcoming_date);
      if (!startsAt || startsAt.getTime() < cutoff) { result.skipped++; continue; }
      const endsAt = buildDate(shop.last_date) ?? new Date(startsAt.getTime() + 7 * 60 * 60 * 1000);

      const eventId = `evt-skatecafe-${shop.slug}`;
      const occurrenceId = `occ-skatecafe-${shop.slug}`;

      const { title, soldOut } = cleanTitle(shop.name);
      if (!title) { result.skipped++; continue; }

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
            description: null,
            venueName: venue.name,
            venueCategory,
          });
        } catch (e) {
          result.errors.push(`enrich ${title}: ${(e as Error).message}`);
        }

        const src = shop.cover_photo?.path_url ?? null;
        if (src) imageUrl = await mirrorImage(src, shop.slug);

        const eventKind = refineKindByDuration(enriched?.kind ?? 'show', startsAt, endsAt);

        try {
          await db.insert(schema.events).values({
            id: eventId,
            venueId: VENUE_ID,
            title,
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
        const ticketUrl = `${SHOP_BASE}/${shop.slug}/shop`;
        const status = soldOut ? 'sold_out' : 'scheduled';
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
            status,
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: { startsAt, endsAt, ticketUrl, status },
          });
        result.occurrencesUpserted++;
      } catch (e) {
        result.errors.push(`occurrence ${shop.slug}: ${(e as Error).message}`);
        result.skipped++;
      }
    } catch (e) {
      result.errors.push(`shop ${shop.slug}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
