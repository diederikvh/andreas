import { chromium } from 'playwright';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';
import { loadVenueTitleMap, resolveEventId } from './_title-dedup.js';

/**
 * Generieke WeTicket-scraper voor venues met `scraperConfig.weticket =
 * { subdomain }`. Listing-URL = `https://{subdomain}.weticket.io/`.
 *
 * WeTicket rendert SSR met een `<script id="__NEXT_DATA__">` met
 * `props.pageProps.organisationWithShops.upcoming_events`. Iedere shop
 * heeft slug/name/cover_photo/first_date/last_date/location_name.
 *
 * Achter een Vercel Security Checkpoint dus pure HTTP krijgt een
 * challenge-page. Playwright omzeilt die — niet in Fly Docker image
 * (lokaal-only via cron op een Mac).
 *
 * Filter `location_name === venue.name` zodat externe shows niet aan
 * deze venue worden gekoppeld (bv. Stuzzi @ Melkweg vanuit Skatecafe).
 *
 * Idempotency: ids zijn `evt-{venueId}-{slug}` / `occ-{venueId}-{slug}`.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36';

type WeTicketShop = {
  uuid: string;
  slug: string;
  name: string;
  location_name: string | null;
  type: string;
  is_hidden: boolean;
  is_published: boolean;
  upcoming_date: string | null; // "YYYY-MM-DD HH:mm" (Amsterdam, lokaal)
  first_date: string | null;
  last_date: string | null;
  cover_photo?: { path_url?: string; mime_type?: string } | null;
};

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** "2026-05-09 22:00" (Amsterdam, lokaal) → Date in UTC. */
function buildDate(s: string | null): Date | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  // Amsterdam-anchor +02:00 (CEST) — zelfde aanname als andere scrapers.
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+02:00`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** Strip "[UITVERKOCHT]" / "[SOLD OUT]" / overige status-tags uit titel. */
function cleanTitle(name: string): { title: string; soldOut: boolean } {
  const decoded = decodeHtmlEntities(name);
  const soldOut = /\[(?:UITVERKOCHT|SOLD\s*OUT)\]/i.test(decoded);
  const title = decoded
    .replace(/\s*\[(?:UITVERKOCHT|SOLD\s*OUT)\]\s*$/i, '')
    .trim();
  return { title, soldOut };
}

async function fetchUpcomingEvents(
  listingUrl: string,
): Promise<WeTicketShop[]> {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ userAgent: UA });
    const page = await ctx.newPage();
    await page.goto(listingUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
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

async function mirrorImage(
  sourceUrl: string,
  venueId: string,
  slug: string,
): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength < 1024 || buf.byteLength > 16 * 1024 * 1024) return null;
    const ext = mime.includes('png')
      ? 'png'
      : mime.includes('webp')
        ? 'webp'
        : 'jpg';
    return await uploadToBunny(
      `media/events/${venueId}-${slug}.${ext}`,
      buf,
      mime,
    );
  } catch (e) {
    console.warn(
      `[weticket] mirror image ${venueId}-${slug}: ${(e as Error).message}`,
    );
    return null;
  }
}

export type WeticketVenueResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeWeticket(options?: {
  venueIds?: string[];
}): Promise<WeticketVenueResult[]> {
  const allVenues = await db.select().from(schema.venues);
  const targets = allVenues.filter((v) => {
    if (options?.venueIds && !options.venueIds.includes(v.id)) return false;
    return Boolean(v.scraperConfig?.weticket?.subdomain);
  });

  const results: WeticketVenueResult[] = [];

  for (const venue of targets) {
    const cfg = venue.scraperConfig!.weticket!;
    const listingUrl = `https://${cfg.subdomain}.weticket.io/`;
    const shopBase = `https://${cfg.subdomain}.weticket.io`;

    const result: WeticketVenueResult = {
      venueId: venue.id,
      fetched: 0,
      inserted: 0,
      occurrencesUpserted: 0,
      skipped: 0,
      errors: [],
    };

    let shops: WeTicketShop[];
    try {
      shops = await fetchUpcomingEvents(listingUrl);
    } catch (e) {
      result.errors.push(`fetch: ${(e as Error).message}`);
      results.push(result);
      continue;
    }

    // Filter alleen events bij déze venue (externe shows skippen).
    // Default: exact-match op venue.name. Config kan via
    // `locationName` een andere string forceren (bv. Sissi's heet
    // op WeTicket "Sissi's Amsterdam (Anthony Fokkerweg 3)").
    const expected = cfg.locationName ?? venue.name;
    const own = shops.filter(
      (s) => s.location_name === expected && s.is_published && !s.is_hidden,
    );
    result.fetched = own.length;

    const cutoff = Date.now() - 6 * 60 * 60 * 1000;
    const venueCategory = venue.categories?.[0] ?? 'Muziek';

    const byTitle = await loadVenueTitleMap(venue.id, `evt-${venue.id}-`);

    for (const shop of own) {
      try {
        const startsAt = buildDate(shop.first_date ?? shop.upcoming_date);
        if (!startsAt || startsAt.getTime() < cutoff) {
          result.skipped++;
          continue;
        }
        const endsAt =
          buildDate(shop.last_date) ??
          new Date(startsAt.getTime() + 7 * 60 * 60 * 1000);

        const occurrenceId = `occ-${venue.id}-${shop.slug}`;

        const { title, soldOut } = cleanTitle(shop.name);
        if (!title) {
          result.skipped++;
          continue;
        }

        // Shop-listing geeft geen description, dus alleen de datum.
        const { eventId } = resolveEventId(
          byTitle,
          title,
          `evt-${venue.id}-${shop.slug}`,
          { startsAt }
        );

        const { eq } = await import('drizzle-orm');
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
          if (src) imageUrl = await mirrorImage(src, venue.id, shop.slug);

          const eventKind = refineKindByDuration(
            enriched?.kind ?? 'show',
            startsAt,
            endsAt,
          );

          try {
            await db.insert(schema.events).values({
              id: eventId,
              venueId: venue.id,
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
          const ticketUrl = `${shopBase}/${shop.slug}/shop`;
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
              // eventId meenemen: occurrences die nog aan een los
              // event hingen verhuizen zo zelf mee.
              set: { eventId, startsAt, endsAt, ticketUrl, status },
            });
          result.occurrencesUpserted++;
        } catch (e) {
          result.errors.push(
            `occurrence ${shop.slug}: ${(e as Error).message}`,
          );
          result.skipped++;
        }
      } catch (e) {
        result.errors.push(`shop ${shop.slug}: ${(e as Error).message}`);
        result.skipped++;
      }
    }

    results.push(result);
  }

  return results;
}
