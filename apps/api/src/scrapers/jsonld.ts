import { createHash } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent } from './enrich.js';
import { extractJsonLdEvents } from './_jsonld-parser.js';

/**
 * JSON-LD (Schema.org) scraper. Voor venues die hun agenda renderen met
 * `<script type="application/ld+json">`-blocks (filmtheaters via
 * tickets-platforms, kunstinstellingen met SEO-georiënteerde theming).
 *
 * Config in `venues.scraperConfig.jsonld`:
 *   { url: "https://kriterion.nl/programma-vandaag" }
 *
 * Idempotency: deterministisch event-id op sha256(uid). Image alleen
 * gemirrord bij eerste keer; occurrence-velden upserten zodat
 * datum/ticket/status-changes doorkomen.
 */

const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const MAX_BYTES = 8 * 1024 * 1024;

type JsonLdConfig = { url: string };

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

async function mirrorImageToBunny(
  sourceUrl: string,
  venueId: string,
  uidHash: string
): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return null;
    const ext = mime.includes('png')
      ? 'png'
      : mime.includes('webp')
        ? 'webp'
        : mime.includes('gif')
          ? 'gif'
          : mime.includes('avif')
            ? 'avif'
            : 'jpg';
    const path = `media/events/jsonld-${venueId}-${uidHash}.${ext}`;
    return await uploadToBunny(path, buf, mime);
  } catch (e) {
    console.warn(
      `[jsonld] mirror image ${sourceUrl} failed: ${(e as Error).message}`
    );
    return null;
  }
}

export type JsonLdVenueResult = {
  venueId: string;
  venueName: string;
  url: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

/** Heuristiek: een schema.org-image die clearly de venue-logo of favicon
 *  is, willen we niet mirroren — dan toon je hetzelfde plaatje bij elk
 *  event. Skip URLs die `logo`, `favicon` of `icon` bevatten. */
function looksLikeLogo(url: string): boolean {
  const u = url.toLowerCase();
  return /\b(logo|favicon|icon)\b/.test(u);
}

async function scrapeOneVenue(
  venue: typeof schema.venues.$inferSelect,
  cfg: JsonLdConfig
): Promise<JsonLdVenueResult> {
  const result: JsonLdVenueResult = {
    venueId: venue.id,
    venueName: venue.name,
    url: cfg.url,
    fetched: 0,
    inserted: 0,
    occurrencesUpserted: 0,
    skipped: 0,
    errors: [],
  };

  let html: string;
  try {
    const r = await fetch(cfg.url, { headers: { 'user-agent': UA } });
    if (!r.ok) {
      result.errors.push(`fetch: HTTP ${r.status}`);
      return result;
    }
    html = await r.text();
  } catch (e) {
    result.errors.push(`fetch: ${(e as Error).message}`);
    return result;
  }

  const events = extractJsonLdEvents(html);
  result.fetched = events.length;

  // Filter voorbij events weg — cutoff = nu - 6u zodat avond-events die
  // tot 03:00 doorgaan op hun avond nog binnenkomen.
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  const upcoming = events.filter(
    (e) => (e.endsAt ?? e.startsAt).getTime() > cutoff
  );

  const venueCategory = venue.categories?.[0] ?? 'Muziek';

  for (const ev of upcoming) {
    try {
      const uidHash = shortHash(ev.uid);
      const eventId = `evt-jld-${venue.id}-${uidHash}`;
      const occurrenceId = `occ-jld-${venue.id}-${uidHash}`;

      const enriched = await enrichEvent({
        title: ev.name,
        description: ev.description,
        venueName: venue.name,
        venueCategory,
      });

      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      let imageUrl: string | null = null;
      if (!existing && ev.imageUrl && !looksLikeLogo(ev.imageUrl)) {
        imageUrl =
          (await mirrorImageToBunny(ev.imageUrl, venue.id, uidHash)) ??
          ev.imageUrl;
      }

      const status: 'scheduled' | 'cancelled' | 'sold_out' = 'scheduled';

      await db.transaction(async (tx) => {
        if (!existing) {
          await tx.insert(schema.events).values({
            id: eventId,
            venueId: venue.id,
            title: ev.name,
            description: enriched.cleanedDescription ?? ev.description,
            kind: enriched.kind,
            imageUrl,
            category: enriched.category ?? venueCategory,
            featured: false,
            genres: enriched.genres,
            published: true,
          });
          result.inserted++;
        }

        await tx
          .insert(schema.occurrences)
          .values({
            id: occurrenceId,
            eventId,
            startsAt: ev.startsAt,
            endsAt: ev.endsAt,
            priceCents: null,
            priceNote: enriched.priceNote,
            ticketUrl: ev.ticketUrl,
            room: enriched.room,
            lineup: enriched.lineup,
            status,
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: {
              startsAt: ev.startsAt,
              endsAt: ev.endsAt,
              priceNote: enriched.priceNote,
              ticketUrl: ev.ticketUrl,
              room: enriched.room,
              lineup: enriched.lineup,
              status,
            },
          });
        result.occurrencesUpserted++;
      });
    } catch (e) {
      result.errors.push(`event ${ev.uid}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return result;
}

export async function scrapeJsonLd(options?: {
  venueIds?: string[];
}): Promise<JsonLdVenueResult[]> {
  const all = await db.select().from(schema.venues);
  const targets = all.filter((v) => {
    const cfg = v.scraperConfig?.jsonld;
    if (!cfg?.url) return false;
    if (options?.venueIds && !options.venueIds.includes(v.id)) return false;
    return true;
  });

  const results: JsonLdVenueResult[] = [];
  for (const v of targets) {
    const cfg = v.scraperConfig!.jsonld!;
    results.push(await scrapeOneVenue(v, cfg));
  }
  return results;
}
