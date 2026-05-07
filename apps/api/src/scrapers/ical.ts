import { createHash } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent } from './enrich.js';
import { parseVEvents } from './_ical-parser.js';

/**
 * iCal-scraper. Voor venues met een open `?ical=1` of `.ics`-feed
 * (WordPress-stijl). Eén VEVENT = één event + één occurrence in onze
 * datamodel — RRULE-expansie is voor v2.
 *
 * Config in `venues.scraperConfig.ical`:
 *   { url: "https://grond.community/events/?ical=1" }
 *
 * Idempotency: deterministisch event-id op sha256(UID); image alleen
 * gemirrord bij eerste insert; occurrence-velden upsert bij her-runs
 * zodat datum/tijd-verschuivingen doorkomen.
 */

const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const MAX_BYTES = 8 * 1024 * 1024;

type IcalConfig = { url: string };

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

async function mirrorImageToBunny(
  sourceUrl: string,
  venueId: string,
  uidHash: string
): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, {
      headers: { 'user-agent': UA },
    });
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
    const path = `media/events/ical-${venueId}-${uidHash}.${ext}`;
    return await uploadToBunny(path, buf, mime);
  } catch (e) {
    console.warn(
      `[ical] mirror image ${sourceUrl} failed: ${(e as Error).message}`
    );
    return null;
  }
}

export type IcalVenueResult = {
  venueId: string;
  venueName: string;
  url: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

async function scrapeOneVenue(
  venue: typeof schema.venues.$inferSelect,
  cfg: IcalConfig
): Promise<IcalVenueResult> {
  const result: IcalVenueResult = {
    venueId: venue.id,
    venueName: venue.name,
    url: cfg.url,
    fetched: 0,
    inserted: 0,
    occurrencesUpserted: 0,
    skipped: 0,
    errors: [],
  };

  let ics: string;
  try {
    const r = await fetch(cfg.url, { headers: { 'user-agent': UA } });
    if (!r.ok) {
      result.errors.push(`fetch: HTTP ${r.status}`);
      return result;
    }
    ics = await r.text();
  } catch (e) {
    result.errors.push(`fetch: ${(e as Error).message}`);
    return result;
  }

  const vevents = parseVEvents(ics);
  result.fetched = vevents.length;

  // Filter voorbij events weg — cutoff = nu - 6u zodat night-events die
  // tot 04:00 doorgaan op hun avond nog binnenkomen.
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  const upcoming = vevents.filter(
    (e) => (e.endsAt ?? e.startsAt).getTime() > cutoff
  );

  const venueCategory = venue.categories?.[0] ?? 'Muziek';

  for (const ev of upcoming) {
    try {
      const uidHash = shortHash(ev.uid);
      const eventId = `evt-ical-${venue.id}-${uidHash}`;
      const occurrenceId = `occ-ical-${venue.id}-${uidHash}`;
      const ticketUrl = ev.url;

      const enriched = await enrichEvent({
        title: ev.summary,
        description: ev.description,
        venueName: venue.name,
        venueCategory,
      });

      // Image alleen bij eerste keer event zien naar Bunny mirroren —
      // her-runs hergebruiken dezelfde CDN-URL.
      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      let imageUrl: string | null = null;
      if (!existing && ev.imageUrl) {
        imageUrl =
          (await mirrorImageToBunny(ev.imageUrl, venue.id, uidHash)) ??
          ev.imageUrl;
      }

      // Categories uit iCal als genres-fallback (lowercase). Claude
      // genres winnen als die zijn ingevuld.
      const fallbackGenres = ev.categories
        .map((c) => c.toLowerCase().trim())
        .filter((c) => c.length > 0 && c.length < 30)
        .slice(0, 4);
      const finalGenres =
        enriched.genres.length > 0 ? enriched.genres : fallbackGenres;

      const status: 'scheduled' | 'cancelled' | 'sold_out' = 'scheduled';

      await db.transaction(async (tx) => {
        if (!existing) {
          await tx.insert(schema.events).values({
            id: eventId,
            venueId: venue.id,
            title: ev.summary,
            description: enriched.cleanedDescription ?? ev.description,
            kind: enriched.kind,
            imageUrl,
            category: enriched.category ?? venueCategory,
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
            startsAt: ev.startsAt,
            endsAt: ev.endsAt,
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
              startsAt: ev.startsAt,
              endsAt: ev.endsAt,
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
      result.errors.push(`event ${ev.uid}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return result;
}

export async function scrapeIcal(options?: {
  venueIds?: string[];
}): Promise<IcalVenueResult[]> {
  const all = await db.select().from(schema.venues);
  const targets = all.filter((v) => {
    const cfg = v.scraperConfig?.ical;
    if (!cfg?.url) return false;
    if (options?.venueIds && !options.venueIds.includes(v.id)) return false;
    return true;
  });

  const results: IcalVenueResult[] = [];
  for (const v of targets) {
    const cfg = v.scraperConfig!.ical!;
    results.push(await scrapeOneVenue(v, cfg));
  }
  return results;
}
