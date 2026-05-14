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
  stripHtml,
} from './_museum-helpers.js';

/**
 * Wereldmuseum Amsterdam (amsterdam.wereldmuseum.nl) scraper.
 *
 * /nl/zien-en-doen is een Drupal-listing met cards naar:
 *   - /nl/zien-en-doen/activiteiten/SLUG  — workshops, lezingen, feesten
 *   - /nl/zien-en-doen/tentoonstellingen/SLUG  — lopende exposities
 *
 * De listing bevat date-snippets ("t/m 28 juni") maar zonder jaar.
 * Voor de scrape fetchen we daarom elke detail-page voor og:title,
 * og:description, og:image en een volledig parseable date-range
 * ("t/m 30 augustus 2026" of "10 oktober 2026 tot en met 25 oktober").
 *
 * Kind = 'exhibition' (multi-day) of 'show' afhankelijk van de duur,
 * laat `refineKindByDuration` beslissen.
 */

const VENUE_ID = 'wereldmuseum-amsterdam';
const BASE = 'https://amsterdam.wereldmuseum.nl';
const LISTING_URL = `${BASE}/nl/zien-en-doen`;

type CardRaw = {
  url: string;
  slug: string;
  title: string;
  description: string | null;
  startsAt: Date;
  endsAt: Date;
  imageUrl: string | null;
};

function extractListingPaths(html: string): Array<{
  path: string;
  slug: string;
}> {
  const out: Array<{ path: string; slug: string }> = [];
  const seen = new Set<string>();
  const re =
    /href="(\/nl\/zien-en-doen\/(?:activiteiten|tentoonstellingen)\/([a-z0-9-]+))"\s+rel="bookmark"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (seen.has(m[2])) continue;
    seen.add(m[2]);
    out.push({ path: m[1], slug: m[2] });
  }
  return out;
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
      `media/events/wereldmuseum-${slug}.${ext}`,
      buf,
      mime
    );
  } catch (e) {
    console.warn(`[wereldmuseum] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type WereldmuseumResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeWereldmuseum(options?: {
  venueIds?: string[];
}): Promise<WereldmuseumResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: WereldmuseumResult = {
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

  for (const { path, slug } of paths) {
    const detailHtml = await fetchHtml(`${BASE}${path}`);
    if (!detailHtml) {
      result.skipped++;
      continue;
    }
    const og = parseOgTags(detailHtml);
    if (!og.title) {
      result.skipped++;
      continue;
    }
    // Zoek de volledige body-tekst af op een NL-date-range. We pakken
    // de eerste hit; date-range parser herkent "t/m D maand YYYY"
    // (open-ended) én "D maand [YYYY] tot D maand YYYY".
    const text = stripHtml(detailHtml);
    const range = parseDateRangeNL(text);
    if (!range) {
      result.skipped++;
      continue;
    }
    if (range.end.getTime() < now - 24 * 60 * 60_000) {
      result.skipped++;
      continue;
    }
    cards.push({
      url: `${BASE}${path}`,
      slug,
      title: og.title,
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
      const eventId = `evt-wereldmuseum-${card.slug}`;
      const occurrenceId = `occ-wereldmuseum-${card.slug}`;

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

  return [result];
}
