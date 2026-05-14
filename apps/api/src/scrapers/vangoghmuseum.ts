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
 * Van Gogh Museum (vangoghmuseum.nl) scraper.
 *
 * /nl/bezoek/tentoonstellingen is een SSR-listing met cards naar
 * /nl/bezoek/tentoonstellingen/<slug>. Detail-pages tonen de datum in
 * een `<li><span class="label">Van</span><span>D maand YYYY</span></li>`
 * /…label="Tot en met"…` structuur — bij plain-text strip ontstaat
 * "Van D maand YYYY Tot en met D maand YYYY" wat de shared NL-parser
 * herkent.
 *
 * og:title/description/image leveren de metadata. `/overzicht-geweest`
 * is een archief-link en wordt geskipt.
 */

const VENUE_ID = 'van-gogh-museum';
const BASE = 'https://www.vangoghmuseum.nl';
const LISTING_URL = `${BASE}/nl/bezoek/tentoonstellingen`;

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
    /href="(\/nl\/bezoek\/tentoonstellingen\/([a-z0-9-]+))"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (seen.has(m[2])) continue;
    if (m[2] === 'overzicht-geweest') continue; // archief-link
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
      `media/events/vangoghmuseum-${slug}.${ext}`,
      buf,
      mime
    );
  } catch (e) {
    console.warn(`[vangoghmuseum] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type VanGoghMuseumResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeVanGoghMuseum(options?: {
  venueIds?: string[];
}): Promise<VanGoghMuseumResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: VanGoghMuseumResult = {
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
    // og:title bevat soms "Tentoonstelling " prefix — strip dat zodat
    // de titel schoon is voor de listing.
    const title = og.title.replace(/^Tentoonstelling\s+/i, '');
    cards.push({
      url: `${BASE}${path}`,
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
      const eventId = `evt-vangoghmuseum-${card.slug}`;
      const occurrenceId = `occ-vangoghmuseum-${card.slug}`;

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
