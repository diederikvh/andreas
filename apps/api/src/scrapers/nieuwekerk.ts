import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';
import {
  ANDREAS_UA,
  decode,
  fetchHtml,
  parseDateRangeEN,
  parseOgTags,
} from './_museum-helpers.js';

/**
 * De Nieuwe Kerk (Dam, Amsterdam) scraper.
 *
 * /en/exhibitions is een statische WordPress-listing met 4-5 cards:
 *
 *   <a href="https://www.nieuwekerk.nl/en/exhibitions/SLUG/">
 *     <img src="https://www.nieuwekerk.nl/wp-content/uploads/...jpg">
 *     <h3>Titel</h3>
 *     <span>24 April 2026 - 27 September 2026</span>
 *   </a>
 *
 * Title + date + image staan in de listing — geen detail-fetch nodig
 * voor de hoofd-velden. Voor de event-beschrijving fetchen we wel de
 * detail-page voor og:description.
 *
 * Datum-format: EN "D Month YYYY - D Month YYYY" (hyphen-separator);
 * parseDateRangeEN pakt dat al.
 */

const VENUE_ID = 'nieuwe-kerk';
const LISTING_URL = 'https://www.nieuwekerk.nl/en/exhibitions';

type CardRaw = {
  url: string;
  slug: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  imageUrl: string | null;
};

function extractCards(html: string): CardRaw[] {
  const out: CardRaw[] = [];
  const seen = new Set<string>();

  // Voor elke link naar /en/exhibitions/SLUG/ — pak de eerstvolgende
  // ~1200 chars als card-context (waar de h3 + date + image-img zitten).
  const linkRe =
    /href="(https:\/\/www\.nieuwekerk\.nl\/en\/exhibitions\/([a-z0-9-]+)\/)"/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const slug = m[2];
    if (slug === 'feed' || seen.has(slug)) continue;

    // Title + date staan ná de link, image kan VOOR of NA staan
    // (verschilt per card). Daarom twee zoek-windows.
    const after = html.slice(m.index + m[0].length, m.index + m[0].length + 1200);
    const titleMatch = after.match(/<h3[^>]*>([^<]+)<\/h3>/);
    if (!titleMatch) continue;
    const title = decode(titleMatch[1]);

    const rangeMatch = after.match(
      /(\d{1,2}\s+[A-Z][a-z]+(?:\s+\d{4})?\s*[–—-]\s*\d{1,2}\s+[A-Z][a-z]+\s+\d{4})/
    );
    if (!rangeMatch) continue;
    const range = parseDateRangeEN(rangeMatch[1]);
    if (!range) continue;

    // Image — bredere context: 1500 chars vóór + 1200 chars na de link.
    // WP CDN gebruikt soms `data-src` voor lazy-loading. We pakken de
    // dichtstbijzijnde wp-uploads-URL die de slug-stem bevat (zodat we
    // niet per ongeluk het image van een andere card grijpen).
    const wide = html.slice(
      Math.max(0, m.index - 1500),
      m.index + m[0].length + 1200
    );
    const stem = slug.split('-').slice(0, 2).join('|');
    const stemRe = new RegExp(
      `(?:src|data-src|data-lazy-src)="(https://www\\.nieuwekerk\\.nl/wp-content/uploads/[^"]*(?:${stem})[^"]*\\.(?:jpg|jpeg|png|webp))"`,
      'i'
    );
    let imgMatch = wide.match(stemRe);
    if (!imgMatch) {
      // Fallback: eerste img in het smalle "after"-window.
      imgMatch = after.match(
        /(?:src|data-src|data-lazy-src)="(https:\/\/www\.nieuwekerk\.nl\/wp-content\/uploads\/[^"]+\.(?:jpg|jpeg|png|webp))"/i
      );
    }
    const imageUrl = imgMatch ? imgMatch[1] : null;

    seen.add(slug);
    out.push({
      url: m[1],
      slug,
      title,
      startsAt: range.start,
      endsAt: range.end,
      imageUrl,
    });
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
      `media/events/nieuwekerk-${slug}.${ext}`,
      buf,
      mime
    );
  } catch (e) {
    console.warn(`[nieuwekerk] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

/** Fetch detail-page enkel voor og:description. */
async function fetchDescription(url: string): Promise<string | null> {
  const html = await fetchHtml(url);
  if (!html) return null;
  const og = parseOgTags(html);
  return og.description;
}

export type NieuweKerkResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeNieuweKerk(options?: {
  venueIds?: string[];
}): Promise<NieuweKerkResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: NieuweKerkResult = {
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
      const eventId = `evt-nieuwekerk-${card.slug}`;
      const occurrenceId = `occ-nieuwekerk-${card.slug}`;

      const [existing] = await db
        .select({
          id: schema.events.id,
          imageUrl: schema.events.imageUrl,
          description: schema.events.description,
        })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      if (existing) {
        // Altijd re-mirror: Nieuwe Kerk publiceert maar 2-4 exhibitions
        // tegelijk, dus de extra fetch+upload kost niks. Een eerdere
        // bug overschreef Bunny-files met de wrong content (Queer-image
        // onder de world-press filename) — door bij elke run opnieuw
        // te uploaden komt de juiste content op de juiste filename.
        if (card.imageUrl) {
          const newImage =
            (await mirrorImage(card.imageUrl, card.slug)) ?? card.imageUrl;
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

      const description = await fetchDescription(card.url);

      const enriched = await enrichEvent({
        title: card.title,
        description,
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
          description: enriched.cleanedDescription ?? description,
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
