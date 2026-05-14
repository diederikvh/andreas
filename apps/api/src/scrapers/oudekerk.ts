import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';
import {
  ANDREAS_UA,
  parseDateRangeNL,
  parseOgTags,
  shiftToLocalTime,
} from './_museum-helpers.js';

/**
 * Oude Kerk (Amsterdam) scraper.
 *
 * /nu-te-zien is een Craft-CMS Chakra-UI listing met cards naar
 * /nu-te-zien/evenementen/<slug>/<id>. De listing toont een mix van
 * lopende tentoonstellingen (met `t/m D maand YYYY` of `D maand YYYY
 * t/m D maand YYYY`) en single-day events (concerten, workshops,
 * artist talks — zonder datum in de listing-card).
 *
 * Per detail-page proberen we twee parsing-paden:
 *   1. NL date-range op de gestripte body ("21 november 2025 t/m 6
 *      april 2026" of "t/m 27 september 2026").
 *   2. h1+h2-sequentie: "<h1>Titel</h1><h2>29 juli 2026</h2>" voor
 *      single-day events. Datum komt in een `chakra-heading`-h2
 *      direct ná de h1.
 *
 * Events zonder beide patronen worden geskipt (vaak placeholders
 * of "Pagina niet gevonden"-404s op verlopen URLs).
 */

const VENUE_ID = 'oude-kerk';
const BASE = 'https://www.oudekerk.nl';
const LISTING_URL = `${BASE}/nu-te-zien`;

/**
 * Oude Kerk blokt de generieke Andreas-Scraper UA na enkele requests
 * met een 403/HTML-error. Een browser-UA omzeilt die rate-limit en
 * werkt voor zowel de listing als detail-pages.
 */
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { 'user-agent': BROWSER_UA } });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

const NL_MONTHS_FULL: Record<string, number> = {
  januari: 0,
  februari: 1,
  maart: 2,
  april: 3,
  mei: 4,
  juni: 5,
  juli: 6,
  augustus: 7,
  september: 8,
  oktober: 9,
  november: 10,
  december: 11,
};

type CardRaw = {
  url: string;
  slug: string;
  composite: string;
  title: string;
  description: string | null;
  startsAt: Date;
  endsAt: Date | null;
  isMultiDay: boolean;
  imageUrl: string | null;
};

function extractListingPaths(html: string): Array<{
  path: string;
  slug: string;
  id: string;
}> {
  const out: Array<{ path: string; slug: string; id: string }> = [];
  const seen = new Set<string>();
  const re =
    /href="(\/nu-te-zien\/evenementen\/([a-z0-9-]+)\/(\d+))"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const composite = `${m[2]}-${m[3]}`;
    if (seen.has(composite)) continue;
    seen.add(composite);
    out.push({ path: m[1], slug: m[2], id: m[3] });
  }
  return out;
}

/**
 * Pak event-datum uit de h1+h2(+h2) sequence direct na de event-titel.
 * Oude Kerk's pattern:
 *
 *   Single-day:  <h1>Titel</h1><h2>5 juni 2026</h2><h2>20:15 – 21:45</h2>
 *   Multi-day:   <h1>Titel</h1><h2>25 april – 31 oktober 2026</h2>
 *
 * We parsen *alleen* uit dit blok — niet uit de body — zodat de
 * sidebar/banner van de huidige tentoonstelling (Jesse Darling) niet
 * per ongeluk als event-datum wordt opgepakt.
 */
function extractEventDateFromHeading(html: string): {
  startsAt: Date;
  endsAt: Date | null;
  isMultiDay: boolean;
} | null {
  const m = html.match(
    /<h1[^>]*>[^<]+<\/h1>\s*<h2[^>]*>([^<]+)<\/h2>(?:\s*<h2[^>]*>([^<]+)<\/h2>)?/i
  );
  if (!m) return null;
  const dateText = m[1].trim();
  const timeText = m[2]?.trim() ?? null;

  // Multi-day range eerst — "25 april – 31 oktober 2026" of
  // "21 november 2025 t/m 6 april 2026".
  const range = parseDateRangeNL(dateText);
  if (range) {
    return { startsAt: range.start, endsAt: range.end, isMultiDay: true };
  }

  // Single-day: "D maand YYYY"
  const single = dateText.match(/^(\d{1,2})\s+([a-zA-Z]+)\s+(\d{4})$/);
  if (!single) return null;
  const mo = NL_MONTHS_FULL[single[2].toLowerCase()];
  if (mo === undefined) return null;
  const day = parseInt(single[1], 10);
  const year = parseInt(single[3], 10);

  // Tijd uit optionele tweede h2 — "HH:MM – HH:MM" of "HH:MM". Default
  // start = 20:00 (concerten/talks), endsAt null als tijd onbekend.
  let hour = 20;
  let minute = 0;
  let endsAt: Date | null = null;
  if (timeText) {
    const tm = timeText.match(
      /(\d{1,2}):(\d{2})\s*(?:[–—-]\s*(\d{1,2}):(\d{2}))?/
    );
    if (tm) {
      hour = parseInt(tm[1], 10);
      minute = parseInt(tm[2], 10);
      if (tm[3] && tm[4]) {
        endsAt = shiftToLocalTime(
          year,
          mo,
          day,
          parseInt(tm[3], 10),
          parseInt(tm[4], 10)
        );
      }
    }
  }
  const startsAt = shiftToLocalTime(year, mo, day, hour, minute);
  return { startsAt, endsAt, isMultiDay: false };
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
      `media/events/oudekerk-${slug}.${ext}`,
      buf,
      mime
    );
  } catch (e) {
    console.warn(`[oudekerk] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type OudeKerkResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeOudeKerk(options?: {
  venueIds?: string[];
}): Promise<OudeKerkResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: OudeKerkResult = {
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

  const listingHtml = await fetchHtml(LISTING_URL);
  if (!listingHtml) {
    result.errors.push('listing niet bereikbaar');
    return [result];
  }

  const paths = extractListingPaths(listingHtml);
  const now = Date.now();
  const cards: CardRaw[] = [];

  for (const { path, slug, id } of paths) {
    const detailHtml = await fetchHtml(`${BASE}${path}`);
    if (!detailHtml) {
      result.skipped++;
      continue;
    }
    const og = parseOgTags(detailHtml, BASE);
    // Verlopen URLs renderen een 404-template met og:title "Pagina
    // niet gevonden" — niet als event opslaan.
    if (!og.title || /pagina niet gevonden/i.test(og.title)) {
      result.skipped++;
      continue;
    }

    // Oude Kerk's og:image is een GENERIC museum-share image
    // (24C005F.jpg) en is voor elke event gelijk. De échte event-hero
    // staat in de body als `<img data-src=".../blocks/_WxH_crop_…/file.jpg">`.
    // We pakken de eerste lazy-loaded block-image als hero; fall back op
    // og:image als geen blocks-image gevonden wordt.
    const blockImg = detailHtml.match(
      /data-src="(https:\/\/assets\.oudekerk\.nl\/images\/transfroms\/blocks\/_\d+x\d+_crop_center-center_none\/[^"]+)"/
    );
    const heroImage = blockImg ? blockImg[1] : og.image;

    // Parse uitsluitend uit de h1+h2(+h2) sequence — de body bevat
    // banner-/sidebar-ruis met de huidige tentoonstelling-data wat
    // anders alle events op die date-range zou zetten.
    const dateInfo = extractEventDateFromHeading(detailHtml);
    if (!dateInfo) {
      result.skipped++;
      continue;
    }
    const { startsAt, endsAt, isMultiDay } = dateInfo;

    // Past-filter: skip alleen voor *nieuwe* events. Voor bestaande
    // events willen we ook past-dates corrigeren (vorige scrape-runs
    // hadden een bug die alle events op de verkeerde range zette;
    // door altijd te upsertten genezen die zichzelf).
    const eventId = `evt-oudekerk-${slug}-${id}`;
    const effectiveEnd = endsAt ?? startsAt;
    const [pre] = await db
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(eq(schema.events.id, eventId))
      .limit(1);
    if (!pre && effectiveEnd.getTime() < now - 24 * 60 * 60_000) {
      result.skipped++;
      continue;
    }

    cards.push({
      url: `${BASE}${path}`,
      slug,
      composite: `${slug}-${id}`,
      title: og.title,
      description: og.description,
      startsAt,
      endsAt,
      isMultiDay,
      imageUrl: heroImage,
    });
  }
  result.fetched = cards.length;

  const venueCategory = venue.categories?.[0] ?? 'Kunst';

  for (const card of cards) {
    try {
      const eventId = `evt-oudekerk-${card.composite}`;
      const occurrenceId = `occ-oudekerk-${card.composite}`;

      const [existing] = await db
        .select({ id: schema.events.id, imageUrl: schema.events.imageUrl })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      if (existing) {
        // Altijd re-mirror: een eerdere bug-batch sloeg de generic
        // og:image op voor alle events. Door nu altijd de detail-page
        // block-image te mirrorre fixen we die batch in één run.
        if (card.imageUrl) {
          const newImage =
            (await mirrorImage(card.imageUrl, card.composite)) ?? card.imageUrl;
          await db
            .update(schema.events)
            .set({ imageUrl: newImage })
            .where(eq(schema.events.id, eventId));
        }

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
        imageUrl =
          (await mirrorImage(card.imageUrl, card.composite)) ?? card.imageUrl;
      }

      const baseKind = card.isMultiDay ? 'exhibition' : 'show';
      const refinedKind = refineKindByDuration(
        baseKind,
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
      result.errors.push(`${card.composite}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
