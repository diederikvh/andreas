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
 * STRAAT Museum (NDSM, Amsterdam-Noord) scraper.
 *
 * /zien-doen is een Nuxt SSR-pagina met een JSON-LD `ItemList` die
 * alle agenda-items als schema.org Event-objecten levert. Elke entry:
 *
 *   {
 *     "@type": "ExhibitionEvent" | "Event" | "SocialEvent" |
 *              "EducationEvent" | "Activity",
 *     "name": "the ESSENCE",
 *     "startDate": "2026-04-10 10:00:00",
 *     "endDate":   "2026-12-30 17:00:00",
 *     "url":       "https://straatmuseum.com/tentoonstellingen/the-essence/"
 *   }
 *
 * Datums zijn lokale Amsterdam-tijd (geen timezone-suffix). We zetten
 * ze om naar UTC via shiftToLocalTime.
 *
 * Images: detail-pages renderen `<img src="https://api.straatmuseum
 * .com/img/assets/<path>.webp?...">`-tags die door de raw HTML wel
 * uit te plukken zijn (Nuxt-image-componenten worden SSR gerendered,
 * niet pas client-side). We pakken de eerste img/assets-URL per
 * detail-page als hero, strippen de transform-query, en mirroren
 * naar Bunny.
 */

const VENUE_ID = 'straat-museum';
const LISTING_URL = 'https://www.straatmuseum.com/zien-doen';

/** Mapping van schema.org @type naar Andreas-kind. */
function kindFromSchemaType(t: string): 'exhibition' | 'show' {
  return t === 'ExhibitionEvent' ? 'exhibition' : 'show';
}

type CardRaw = {
  url: string;
  slug: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  schemaType: string;
};

type DetailEnrichment = {
  imageUrl: string | null;
  description: string | null;
};

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
      `media/events/straatmuseum-${slug}.${ext}`,
      buf,
      mime
    );
  } catch (e) {
    console.warn(`[straatmuseum] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Fetch detail-page en haal hero-image + description eruit. Hero =
 * eerste `https://api.straatmuseum.com/img/assets/<path>`-URL in de
 * HTML (query-strings strippen we zodat we de originele asset krijgen
 * en niet de Nuxt-transform).
 *
 * Description = eerste paragraphs binnen `<div class="content-text…">`
 * (de hoofdtekst-sectie van een Straat detail-page). We knippen op
 * ~500 chars zodat we onder de description-limit blijven.
 */
async function fetchDetail(url: string): Promise<DetailEnrichment> {
  const html = await fetchHtml(url);
  if (!html) return { imageUrl: null, description: null };

  // Hero image — pak eerste img/assets URL, strip query.
  let imageUrl: string | null = null;
  const img = html.match(
    /https:\/\/api\.straatmuseum\.com\/img\/assets\/[^"'?\s]+/
  );
  if (img) imageUrl = img[0];

  // Description — eerste paragraphs binnen `.content-text`-blok.
  let description: string | null = null;
  const block = html.match(
    /<div\s+class="content-text[^"]*"[^>]*>([\s\S]*?)<\/div>/
  );
  if (block) {
    const paragraphs = [...block[1].matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)]
      .map((m) =>
        decode(m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim()
      )
      .filter((p) => p && p.length > 30 && !/^let op[:.]/i.test(p));
    if (paragraphs.length > 0) {
      description = paragraphs.join(' ').slice(0, 500);
    }
  }

  return { imageUrl, description };
}

/** Parse de eerste schema.org "YYYY-MM-DD HH:MM:SS"-style datum als
 *  lokale Amsterdam-tijd. */
function parseLocalDate(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return shiftToLocalTime(
    parseInt(y, 10),
    parseInt(mo, 10) - 1,
    parseInt(d, 10),
    parseInt(h, 10),
    parseInt(mi, 10)
  );
}

/**
 * Pak alle JSON-LD blobs uit het document en collect alle Event/
 * Exhibition-entries (inclusief geneste `itemListElement`s).
 */
function extractCards(html: string): CardRaw[] {
  const seen = new Set<string>();
  const out: CardRaw[] = [];

  const blobs = [
    ...html.matchAll(
      /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g
    ),
  ];

  for (const b of blobs) {
    let data: unknown;
    try {
      data = JSON.parse(b[1].trim());
    } catch {
      continue;
    }
    walk(data, (node) => {
      const t = node['@type'];
      if (typeof t !== 'string') return;
      if (
        !/^(ExhibitionEvent|Event|SocialEvent|EducationEvent|Activity)$/.test(t)
      )
        return;
      const url = typeof node.url === 'string' ? node.url : null;
      const name = typeof node.name === 'string' ? decode(node.name) : null;
      const startStr =
        typeof node.startDate === 'string' ? node.startDate : null;
      const endStr = typeof node.endDate === 'string' ? node.endDate : null;
      if (!url || !name || !startStr || !endStr) return;

      // Slug uit URL: laatste niet-lege path-segment.
      const slug = url
        .replace(/\/$/, '')
        .split('/')
        .filter(Boolean)
        .pop();
      if (!slug || seen.has(slug)) return;

      const startsAt = parseLocalDate(startStr);
      const endsAt = parseLocalDate(endStr);
      if (!startsAt || !endsAt) return;

      seen.add(slug);
      out.push({ url, slug, title: name, startsAt, endsAt, schemaType: t });
    });
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function walk(node: any, fn: (n: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    for (const v of node) walk(v, fn);
    return;
  }
  if (node && typeof node === 'object') {
    fn(node);
    for (const v of Object.values(node)) walk(v, fn);
  }
}

export type StraatMuseumResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeStraatMuseum(options?: {
  venueIds?: string[];
}): Promise<StraatMuseumResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: StraatMuseumResult = {
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
      const eventId = `evt-straatmuseum-${card.slug}`;
      const occurrenceId = `occ-straatmuseum-${card.slug}`;

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
        // Repareer images/description voor events die in eerdere runs
        // zonder enrichment zijn opgeslagen.
        const needsImageRepair =
          !existing.imageUrl || !existing.imageUrl.startsWith('http');
        const needsDescRepair = !existing.description;
        if (needsImageRepair || needsDescRepair) {
          const detail = await fetchDetail(card.url);
          const patch: Partial<typeof schema.events.$inferInsert> = {};
          if (needsImageRepair && detail.imageUrl) {
            patch.imageUrl =
              (await mirrorImage(detail.imageUrl, card.slug)) ?? detail.imageUrl;
          }
          if (needsDescRepair && detail.description) {
            patch.description = detail.description;
          }
          if (Object.keys(patch).length > 0) {
            await db
              .update(schema.events)
              .set(patch)
              .where(eq(schema.events.id, eventId));
          }
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

      const detail = await fetchDetail(card.url);

      const enriched = await enrichEvent({
        title: card.title,
        description: detail.description,
        venueName: venue.name,
        venueCategory,
      });

      let imageUrl: string | null = null;
      if (detail.imageUrl) {
        imageUrl =
          (await mirrorImage(detail.imageUrl, card.slug)) ?? detail.imageUrl;
      }

      const baseKind = kindFromSchemaType(card.schemaType);
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
          description: enriched.cleanedDescription ?? detail.description,
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
