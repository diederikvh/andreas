import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';
import {
  ANDREAS_UA,
  decode,
  parseDateRangeEN,
  parseOgTags,
  stripHtml,
} from './_museum-helpers.js';

/**
 * FOAM (Fotografiemuseum, Keizersgracht) scraper.
 *
 * foam.org/programme zit achter een Vercel Security Checkpoint —
 * een JS-challenge anti-bot wall die simple fetch met user-agent
 * netjes serveert maar dan een loading-spinner pagina teruggeeft.
 * Pas na uitvoering van de challenge-JS krijg je de echte content.
 *
 * Daarom: playwright (chromium) voor zowel de listing- als detail-
 * pages. Run vanaf een dev-machine met een echte chromium-install —
 * NIET op Fly (browser binary niet in de image + lange checkpoint
 * wait verbruikt machine-tijd). Eénmaal per week is genoeg voor
 * FOAM's lage volume (~13 events tegelijk).
 *
 * Lokaal triggeren:
 *   pnpm scrape foam
 *
 * Een browser-like UA is nodig (Andreas-Scraper UA wordt vaker
 * door Vercel als bot gedetecteerd). Daarom override-bare UA hier.
 */

const VENUE_ID = 'foam';
const BASE = 'https://www.foam.org';
const LISTING_URL = `${BASE}/programme`;
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

type CardRaw = {
  url: string;
  slug: string;
  title: string;
  description: string | null;
  startsAt: Date;
  endsAt: Date;
  imageUrl: string | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function renderPage(browser: any, url: string): Promise<string | null> {
  const ctx = await browser.newContext({
    locale: 'en-GB',
    userAgent: BROWSER_UA,
  });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    // Vercel checkpoint klaart automatisch — extra wait om er zeker
    // van te zijn dat de echte content is gerenderd.
    await page.waitForTimeout(2000);
    return await page.content();
  } catch {
    return null;
  } finally {
    await ctx.close();
  }
}

function extractListingSlugs(html: string): string[] {
  const out = new Set<string>();
  const re = /href="\/events\/([a-z0-9-]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.add(m[1]);
  }
  return [...out];
}

async function mirrorImage(
  sourceUrl: string,
  slug: string
): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, { headers: { 'user-agent': ANDREAS_UA } });
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
      `media/events/foam-${slug}.${ext}`,
      buf,
      mime
    );
  } catch (e) {
    console.warn(`[foam] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type FoamResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeFoam(options?: {
  venueIds?: string[];
}): Promise<FoamResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: FoamResult = {
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

  // Playwright is een lazy import zodat de productie-server (zonder
  // chromium-install) niet faalt te laden — alleen handmatige runs
  // vanaf een dev-machine zullen deze scraper aanroepen.
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (e) {
    result.errors.push(`playwright niet beschikbaar: ${(e as Error).message}`);
    return [result];
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const listingHtml = await renderPage(browser, LISTING_URL);
    if (!listingHtml) {
      result.errors.push('listing niet gerenderd (Vercel checkpoint?)');
      return [result];
    }

    const slugs = extractListingSlugs(listingHtml);
    const now = Date.now();
    const cards: CardRaw[] = [];

    for (const slug of slugs) {
      const url = `${BASE}/events/${slug}`;
      const detailHtml = await renderPage(browser, url);
      if (!detailHtml) {
        result.skipped++;
        continue;
      }
      const og = parseOgTags(detailHtml);
      if (!og.title) {
        result.skipped++;
        continue;
      }
      const text = stripHtml(detailHtml);
      const range = parseDateRangeEN(text);
      if (!range) {
        // Geen parseable date-range → workshop/rondleiding zonder
        // einddatum, of free-guided-tour-style recurring item. Skip.
        result.skipped++;
        continue;
      }
      if (range.end.getTime() < now - 24 * 60 * 60_000) {
        result.skipped++;
        continue;
      }
      // og:title bevat altijd " | Foam"-suffix — strip dat.
      const title = decode(og.title).replace(/\s*\|\s*Foam.*$/i, '').trim();
      cards.push({
        url,
        slug,
        title,
        description: og.description,
        startsAt: range.start,
        endsAt: range.end,
        imageUrl: og.image,
      });
    }
    result.fetched = cards.length;

    const venueCategory = venue.categories?.[0] ?? 'Kunst';

    for (const card of cards) {
      try {
        const eventId = `evt-foam-${card.slug}`;
        const occurrenceId = `occ-foam-${card.slug}`;

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
          description: card.description,
          venueName: venue.name,
          venueCategory,
        });

        let imageUrl: string | null = null;
        if (card.imageUrl) {
          imageUrl = (await mirrorImage(card.imageUrl, card.slug)) ?? card.imageUrl;
        }

        const refinedKind = refineKindByDuration(
          'exhibition',
          card.startsAt,
          card.endsAt
        );

        await db.transaction(async (tx) => {
          await tx.insert(schema.events).values({
            id: eventId,
            venueId: venue.id,
            title: card.title,
            description: enriched.cleanedDescription ?? card.description,
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
  } finally {
    await browser.close();
  }

  return [result];
}
