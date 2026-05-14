import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';
import {
  ANDREAS_UA,
  decode,
  fetchHtml,
  parseDateRangeNL,
  parseOgTags,
  shiftToLocalTime,
  stripHtml,
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
 * Single-day event: `<h1>Titel</h1><h2 ...chakra-heading...>29 juli
 * 2026</h2>`. We zoeken een h2 met alleen "D maand YYYY" tekst direct
 * na de eerste h1 — dat is het oude-kerk-patroon voor concerten/talks.
 */
function extractSingleDayDate(html: string): Date | null {
  const m = html.match(
    /<h1[^>]*>[^<]+<\/h1>\s*<h2[^>]*>\s*(\d{1,2})\s+([a-zA-Z]+)\s+(\d{4})\s*<\/h2>/i
  );
  if (!m) return null;
  const mo = NL_MONTHS_FULL[m[2].toLowerCase()];
  if (mo === undefined) return null;
  // 20:00 als default start (concerten/talks beginnen meestal 's avonds);
  // refineKindByDuration corrigeert eventueel naar exhibition als de
  // werkelijke duur dat suggereert (gebeurt hier niet — single-day).
  return shiftToLocalTime(parseInt(m[3], 10), mo, parseInt(m[1], 10), 20, 0);
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

    let startsAt: Date | null = null;
    let endsAt: Date | null = null;
    let isMultiDay = false;

    const text = stripHtml(detailHtml);
    const range = parseDateRangeNL(text);
    if (range) {
      startsAt = range.start;
      endsAt = range.end;
      isMultiDay = true;
    } else {
      const single = extractSingleDayDate(detailHtml);
      if (single) {
        startsAt = single;
      }
    }
    if (!startsAt) {
      result.skipped++;
      continue;
    }

    const effectiveEnd = endsAt ?? startsAt;
    if (effectiveEnd.getTime() < now - 24 * 60 * 60_000) {
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
      imageUrl: og.image,
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
        const needsImageRepair =
          !existing.imageUrl || !existing.imageUrl.match(/^https?:\/\//i);
        if (needsImageRepair && card.imageUrl) {
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
