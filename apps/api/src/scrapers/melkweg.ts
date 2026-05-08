import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Melkweg scraper. Hun /agenda is een Next.js SPA achter Cloudflare —
 * een platte fetch geeft 0 bytes. We gebruiken Playwright (headless
 * Chromium) om de pagina te renderen, parsen `__NEXT_DATA__` voor de
 * `initialEvents` array, en lopen die door.
 *
 * `__NEXT_DATA__.props.pageProps.pageData.attributes.content[0]
 *  .attributes.initialEvents` geeft ~200 events met velden:
 *   id, name, startDate, startTime, endDate, url, profile (bv "Concert"),
 *   tags[], isCancelled, isSoldOut, isMultiDayEvent, media.featuredImage[].
 *
 * Voor description hebben we per event geen veld in deze JSON — de
 * detail-pagina (/nl/agenda/<slug>) heeft 'em wel. We maken in v1 alleen
 * gebruik van wat de overzichts-JSON geeft; description kan later via
 * een tweede fetch.
 *
 * Idempotency: event-id = `evt-mw-melkweg-{numericId}` (Melkweg's eigen
 * event-id is een stabiel int).
 */

const VENUE_ID = 'melkweg';

type MelkwegImage = {
  width: number;
  height: number;
  filename: string;
};

type MelkwegEvent = {
  type: 'events';
  id: string;
  attributes: {
    name: string;
    startDate: string; // ISO UTC
    startTime: string; // ISO UTC
    endDate: string | null;
    url: string;
    profile: string; // categorie ("Concert", "Expositie", etc.)
    tags: string[];
    isCancelled: boolean;
    isSoldOut: boolean;
    isMultiDayEvent: boolean;
    isPublished: boolean;
    media: { featuredImage?: MelkwegImage[] };
    yesplan_id?: string;
  };
};

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';

async function fetchInitialEvents(): Promise<MelkwegEvent[]> {
  // Dynamic import zodat playwright alleen wordt geladen als deze
  // scraper draait — Fly's Docker-image hoeft 'em niet voor andere
  // scrapers in te bakken.
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ userAgent: UA, locale: 'nl-NL' });
    const page = await ctx.newPage();
    await page.goto('https://www.melkweg.nl/agenda', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(2000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await page.evaluate(`(() => {
      const el = document.getElementById('__NEXT_DATA__');
      return el ? JSON.parse(el.textContent || '{}') : null;
    })()`);
    if (!data) throw new Error('__NEXT_DATA__ niet gevonden');
    const events: MelkwegEvent[] | undefined =
      data?.props?.pageProps?.pageData?.attributes?.content?.[0]?.attributes
        ?.initialEvents;
    if (!Array.isArray(events)) throw new Error('initialEvents niet gevonden');
    return events;
  } finally {
    await browser.close();
  }
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
    const path = `media/events/mw-${stableId}.${ext}`;
    return await uploadToBunny(path, buf, mime);
  } catch (e) {
    console.warn(`[melkweg] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Map Melkweg-profile naar onze category-enum. Hun profile-strings:
 * Concert/Club/Expositie/Theater/Film/Lezing.
 */
function mapCategory(profile: string): 'Muziek' | 'Theater' | 'Film' | 'Kunst' | 'Literatuur' {
  const p = profile.toLowerCase();
  if (p.includes('expositie') || p.includes('exhibition') || p.includes('kunst')) return 'Kunst';
  if (p.includes('film')) return 'Film';
  if (p.includes('theater') || p.includes('dans')) return 'Theater';
  if (p.includes('lezing') || p.includes('talk') || p.includes('book')) return 'Literatuur';
  return 'Muziek';
}

export type MelkwegResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeMelkweg(options?: {
  venueIds?: string[];
}): Promise<MelkwegResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: MelkwegResult = {
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
    result.errors.push('venue melkweg niet in DB');
    return [result];
  }

  let events: MelkwegEvent[];
  try {
    events = await fetchInitialEvents();
  } catch (e) {
    result.errors.push(`playwright: ${(e as Error).message}`);
    return [result];
  }
  result.fetched = events.length;

  // Filter: gepubliceerd, niet voorbij (cutoff = nu - 6u)
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  const upcoming = events.filter((e) => {
    if (!e.attributes.isPublished) return false;
    const t = new Date(e.attributes.startDate).getTime();
    const end = e.attributes.endDate ? new Date(e.attributes.endDate).getTime() : null;
    return (end ?? t) > cutoff;
  });

  for (const ev of upcoming) {
    try {
      const a = ev.attributes;
      const eventId = `evt-mw-${VENUE_ID}-${ev.id}`;
      const occurrenceId = `occ-mw-${VENUE_ID}-${ev.id}`;
      const startsAt = new Date(a.startTime ?? a.startDate);
      const endsAt = a.endDate ? new Date(a.endDate) : null;
      const ticketUrl = a.url
        ? `https://www.melkweg.nl${a.url}`
        : null;
      const category = mapCategory(a.profile);
      // Tags als genres-fallback (lowercase)
      const fallbackGenres = (a.tags ?? [])
        .map((t) => t.toLowerCase().trim())
        .filter((t) => t.length > 0 && t.length < 30)
        .slice(0, 4);

      // Description niet beschikbaar in initialEvents — Claude krijgt
      // alleen titel + venue-context.
      const enriched = await enrichEvent({
        title: a.name,
        description: null,
        venueName: venue.name,
        venueCategory: category,
      });

      const status: 'scheduled' | 'cancelled' | 'sold_out' = a.isCancelled
        ? 'cancelled'
        : a.isSoldOut
          ? 'sold_out'
          : 'scheduled';

      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      let imageUrl: string | null = null;
      if (!existing && a.media?.featuredImage?.[0]?.filename) {
        imageUrl =
          (await mirrorImage(a.media.featuredImage[0].filename, ev.id)) ?? null;
      }

      const finalGenres = enriched.genres.length > 0 ? enriched.genres : fallbackGenres;
      const refinedKind = refineKindByDuration(enriched.kind, startsAt, endsAt);

      await db.transaction(async (tx) => {
        if (!existing) {
          await tx.insert(schema.events).values({
            id: eventId,
            venueId: venue.id,
            title: a.name,
            description: enriched.cleanedDescription,
            kind: refinedKind,
            imageUrl,
            category: enriched.category ?? category,
            featured: false,
            genres: finalGenres,
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
            endsAt,
            priceCents: null,
            priceNote: enriched.priceNote,
            ticketUrl,
            room: enriched.room,
            lineup: enriched.lineup,
            status,
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: {
              startsAt,
              endsAt,
              priceNote: enriched.priceNote,
              ticketUrl,
              room: enriched.room,
              lineup: enriched.lineup,
              status,
            },
          });
        result.occurrencesUpserted++;
      });
    } catch (e) {
      result.errors.push(`event ${ev.id}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
