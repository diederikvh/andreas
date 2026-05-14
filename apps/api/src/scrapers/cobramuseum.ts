import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';
import {
  ANDREAS_UA,
  decode,
  fetchHtml,
  shiftToLocalTime,
} from './_museum-helpers.js';

/**
 * Cobra Museum (Amstelveen) scraper.
 *
 * /te-doen/tentoonstellingen/ rendert ALLE tentoonstellingen (huidig +
 * archief, tot ~94 stuks) in één HTML; JS toggelt zichtbaarheid via
 * de `displayNot`-class voor de filter-tabs. Voor scraping pakken we
 * alle blokken en filteren we zelf op `endsAt >= nu`.
 *
 * Markup per card:
 *   <div class="standComBlock">
 *     <h2><a href="https://cobra-museum.nl/tentoonstelling/SLUG/">Titel</a></h2>
 *     <div class="standComBlockImgDT" style="background-image: url(IMG)"></div>
 *     <h3>Van 24 apr 2026 t/m 6 sep 2026</h3>
 *   </div>
 *
 * Alle datums zijn NL-afkortingen (jan/feb/mrt/...). Een paar bestaan
 * meerdere keren in de HTML (meerdere filter-views) — we de-dupliceren
 * op slug.
 */

const VENUE_ID = 'cobra-museum';
const LISTING_URL = 'https://cobra-museum.nl/te-doen/tentoonstellingen/';

const NL_MO_SHORT: Record<string, number> = {
  jan: 0, feb: 1, mrt: 2, apr: 3, mei: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, okt: 9, nov: 10, dec: 11,
};

type CardRaw = {
  url: string;
  slug: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  imageUrl: string | null;
};

function extractCards(html: string): CardRaw[] {
  const seen = new Set<string>();
  const out: CardRaw[] = [];
  // Split op `<div class="standComBlock`-block. Elk segment bevat één card.
  const re =
    /<div class="standComBlock\s*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const block = m[1];

    const a = block.match(
      /<h2><a\s+href="(https:\/\/cobra-museum\.nl\/tentoonstelling\/([a-z0-9-]+)\/)">([^<]+)<\/a><\/h2>/
    );
    if (!a) continue;
    const url = a[1];
    const slug = a[2];
    const title = decode(a[3]);
    if (seen.has(slug)) continue;

    // Datum: "Van 24 apr 2026 t/m  6 sep 2026" (variabele whitespace
    // door zero-padding).
    const d = block.match(
      /<h3>\s*Van\s+(\d{1,2})\s+([a-z]+)\s+(\d{4})\s+t\/m\s+(\d{1,2})\s+([a-z]+)\s+(\d{4})/i
    );
    if (!d) continue;
    const sm = NL_MO_SHORT[d[2].toLowerCase()];
    const em = NL_MO_SHORT[d[5].toLowerCase()];
    if (sm === undefined || em === undefined) continue;

    const startsAt = shiftToLocalTime(
      parseInt(d[3], 10),
      sm,
      parseInt(d[1], 10),
      11,
      0
    );
    const endsAt = shiftToLocalTime(
      parseInt(d[6], 10),
      em,
      parseInt(d[4], 10),
      18,
      0
    );

    // Image uit `background-image: url(...)`.
    let imageUrl: string | null = null;
    const img = block.match(
      /standComBlockImgDT[^>]*background-image:\s*url\(([^)]+)\)/
    );
    if (img) imageUrl = decode(img[1]).trim();

    seen.add(slug);
    out.push({ url, slug, title, startsAt, endsAt, imageUrl });
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
      `media/events/cobramuseum-${slug}.${ext}`,
      buf,
      mime
    );
  } catch (e) {
    console.warn(`[cobramuseum] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type CobraMuseumResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeCobraMuseum(options?: {
  venueIds?: string[];
}): Promise<CobraMuseumResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: CobraMuseumResult = {
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

  const html = await fetchHtml(LISTING_URL);
  if (!html) {
    result.errors.push('listing niet bereikbaar');
    return [result];
  }

  const all = extractCards(html);
  const now = Date.now();
  const cards = all.filter(
    (c) => c.endsAt.getTime() >= now - 24 * 60 * 60_000
  );
  result.fetched = cards.length;

  const venueCategory = venue.categories?.[0] ?? 'Kunst';

  for (const card of cards) {
    try {
      const eventId = `evt-cobramuseum-${card.slug}`;
      const occurrenceId = `occ-cobramuseum-${card.slug}`;

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
        description: null,
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
          description: enriched.cleanedDescription,
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
