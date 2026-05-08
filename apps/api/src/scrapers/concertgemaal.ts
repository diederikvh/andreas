import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Concertgemaal scraper. Wix Events op /agenda met
 * `/event-details-registration/{slug}` per event-page. Elke detail-page
 * heeft een Schema.org Event JSON-LD blok met start/end-date, image,
 * location, description.
 *
 * Strategie: plain fetch /agenda → extract event-URLs → per URL plain
 * fetch → parse `<script type="application/ld+json">` voor het Event-
 * blok → insert.
 *
 * Idempotency: event-id uit slug (laatste segment van URL).
 */

const VENUE_ID = 'concertgemaal';
const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const BASE = 'https://www.concertgemaal.nl';

type SchemaOrgEvent = {
  '@type': string;
  name: string;
  startDate: string;
  endDate?: string;
  description?: string;
  image?: string | { '@type': string; url: string };
  url?: string;
  location?: { name?: string; address?: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

async function discoverEventUrls(): Promise<string[]> {
  const html = await fetchHtml(`${BASE}/agenda`);
  if (!html) return [];
  const re = /href="(https?:\/\/(?:www\.)?concertgemaal\.nl\/event-details-registration\/[a-z0-9-]+)"/gi;
  const urls = new Set<string>();
  for (const m of html.matchAll(re)) urls.add(m[1]);
  return Array.from(urls);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(parseInt(c, 10)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

function extractEventJsonLd(html: string): SchemaOrgEvent | null {
  const re = /<script[^>]*application\/ld\+json[^>]*>([\s\S]+?)<\/script>/g;
  for (const m of html.matchAll(re)) {
    try {
      const d = JSON.parse(m[1].trim());
      if (Array.isArray(d)) {
        for (const item of d) {
          if (item && typeof item === 'object' && /Event/i.test(String(item['@type']))) return item;
        }
      } else if (d && typeof d === 'object' && /Event/i.test(String(d['@type']))) {
        return d;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function pickImageUrl(image: SchemaOrgEvent['image']): string | null {
  if (!image) return null;
  if (typeof image === 'string') return image;
  if (typeof image === 'object' && 'url' in image && typeof image.url === 'string') return image.url;
  return null;
}

async function mirrorImage(sourceUrl: string, slug: string): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 8 * 1024 * 1024) return null;
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    return await uploadToBunny(`media/events/cg-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[concertgemaal] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type ConcertgemaalResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeConcertgemaal(options?: {
  venueIds?: string[];
}): Promise<ConcertgemaalResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: ConcertgemaalResult = {
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

  const urls = await discoverEventUrls();
  result.fetched = urls.length;
  if (urls.length === 0) {
    result.errors.push('geen event-URLs gevonden op /agenda');
    return [result];
  }

  const venueCategory = venue.categories?.[0] ?? 'Muziek';

  for (const url of urls) {
    try {
      const slug = url.split('/').filter(Boolean).pop() ?? url;
      const eventId = `evt-cg-${VENUE_ID}-${slug}`;
      const occurrenceId = `occ-cg-${VENUE_ID}-${slug}`;

      // Existing-check
      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      // Detail-page sowieso fetchen voor startsAt
      const html = await fetchHtml(url);
      if (!html) { result.skipped++; continue; }
      const ev = extractEventJsonLd(html);
      if (!ev?.startDate) { result.skipped++; continue; }

      const startsAt = new Date(ev.startDate);
      const endsAt = ev.endDate ? new Date(ev.endDate) : null;
      if (isNaN(startsAt.getTime())) { result.skipped++; continue; }
      // Skip events die al meer dan 6u voorbij zijn — Concertgemaal
      // laat oude events op /agenda staan (archief).
      const cutoff = Date.now() - 6 * 60 * 60 * 1000;
      const refTime = (endsAt ?? startsAt).getTime();
      if (refTime < cutoff) { result.skipped++; continue; }

      if (existing) {
        await db
          .insert(schema.occurrences)
          .values({
            id: occurrenceId,
            eventId,
            startsAt,
            endsAt,
            priceCents: null,
            priceNote: null,
            ticketUrl: url,
            room: null,
            lineup: null,
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: { startsAt, endsAt, ticketUrl: url },
          });
        result.occurrencesUpserted++;
        continue;
      }

      // Nieuw event — Claude enrich + image-mirror.
      const description = ev.description ? decodeEntities(ev.description) : null;
      const enriched = await enrichEvent({
        title: ev.name,
        description,
        venueName: venue.name,
        venueCategory,
      });

      let imageUrl: string | null = null;
      const sourceImg = pickImageUrl(ev.image);
      if (sourceImg) {
        imageUrl = (await mirrorImage(sourceImg, slug)) ?? sourceImg;
      }

      const refinedKind = refineKindByDuration(enriched.kind, startsAt, endsAt);

      await db.transaction(async (tx) => {
        await tx.insert(schema.events).values({
          id: eventId,
          venueId: venue.id,
          title: ev.name,
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
            startsAt,
            endsAt,
            priceCents: null,
            priceNote: enriched.priceNote,
            ticketUrl: url,
            room: enriched.room,
            lineup: enriched.lineup,
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: {
              startsAt,
              endsAt,
              priceNote: enriched.priceNote,
              ticketUrl: url,
              room: enriched.room,
              lineup: enriched.lineup,
            },
          });
        result.occurrencesUpserted++;
      });
    } catch (e) {
      result.errors.push(`event ${url}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
