import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Eventbrite — generieke scraper voor venues die hun events op Eventbrite
 * hosten. Per venue: `scraperConfig.eventbrite = { organizerId }`.
 *
 * Workflow:
 *   1. Fetch organizer-page `/o/{organizerId}` (plain HTML, geen auth)
 *   2. Parse event-links: `/e/{slug}-tickets-{eventId}` patroon
 *   3. Per event: fetch detail-page → parse `<script type="application/ld+json">`
 *      Event-schema (startDate, endDate, name, description, image, location)
 *   4. Filter future + idempotent insert
 *
 * Idempotent: `evt-eb-{eventId}`, `occ-eb-{eventId}`.
 *
 * TODO(lezing-gate): venueCategory default = 'Literatuur' / venue-default.
 */

const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const EB_BASE = 'https://www.eventbrite.com';

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(parseInt(c, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, c) => String.fromCodePoint(parseInt(c, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function parseOrganizerEvents(html: string): Array<{ slug: string; eventId: string }> {
  const seen = new Set<string>();
  const out: Array<{ slug: string; eventId: string }> = [];
  // Pattern: eventbrite.{tld}/e/{slug}-tickets-{event_id} — venues kunnen op
  // .com, .nl, .co.uk etc. zitten; we matchen elke 2-3 letter TLD.
  const re = /eventbrite\.(?:com|nl|[a-z]{2,5})\/e\/([a-z0-9-]+)-tickets-(\d{10,})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (seen.has(m[2])) continue;
    seen.add(m[2]);
    out.push({ slug: m[1], eventId: m[2] });
  }
  return out;
}

type EbEvent = {
  name: string;
  description: string | null;
  startsAt: Date;
  endsAt: Date | null;
  imageUrl: string | null;
  locationName: string | null;
};

function parseDetailJsonLd(html: string): EbEvent | null {
  const blocks = [
    ...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g),
  ];
  for (const m of blocks) {
    try {
      const data = JSON.parse(m[1].trim());
      const items: unknown[] = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const obj = item as Record<string, unknown>;
        const type = obj['@type'];
        if (type !== 'Event' && !('startDate' in obj)) continue;
        const name = typeof obj.name === 'string' ? decode(obj.name) : '';
        if (!name) continue;
        const startStr = obj.startDate;
        if (typeof startStr !== 'string') continue;
        const startsAt = new Date(startStr);
        if (Number.isNaN(startsAt.getTime())) continue;
        let endsAt: Date | null = null;
        if (typeof obj.endDate === 'string') {
          const e = new Date(obj.endDate);
          if (!Number.isNaN(e.getTime())) endsAt = e;
        }
        const description = typeof obj.description === 'string'
          ? decode(obj.description).slice(0, 800)
          : null;
        const imageUrl = typeof obj.image === 'string'
          ? obj.image
          : Array.isArray(obj.image) && typeof obj.image[0] === 'string'
            ? obj.image[0]
            : null;
        const loc = obj.location;
        let locationName: string | null = null;
        if (loc && typeof loc === 'object') {
          const ln = (loc as Record<string, unknown>).name;
          if (typeof ln === 'string') locationName = ln;
        }
        return { name, description, startsAt, endsAt, imageUrl, locationName };
      }
    } catch {
      // skip invalid JSON
    }
  }
  return null;
}

async function mirrorImage(
  sourceUrl: string, eventId: string
): Promise<string | null> {
  try {
    const referer = new URL(sourceUrl).origin + '/';
    const r = await fetch(sourceUrl, {
      headers: { 'user-agent': UA, accept: 'image/*,*/*;q=0.8', referer },
    });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 8 * 1024 * 1024) return null;
    const ext = mime.includes('png') ? 'png'
      : mime.includes('webp') ? 'webp' : 'jpg';
    return await uploadToBunny(`media/events/eb-${eventId}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[eventbrite] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type EventbriteResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeEventbrite(options?: {
  venueIds?: string[];
}): Promise<EventbriteResult[]> {
  const venues = await db.select().from(schema.venues);
  const targets = venues.filter((v) => {
    const cfg = v.scraperConfig?.eventbrite;
    if (!cfg?.organizerId) return false;
    if (options?.venueIds && !options.venueIds.includes(v.id)) return false;
    return true;
  });

  const results: EventbriteResult[] = [];
  const now = new Date();
  const pastCutoff = now.getTime() - 24 * 60 * 60_000;

  for (const venue of targets) {
    const cfg = venue.scraperConfig!.eventbrite!;
    const result: EventbriteResult = {
      venueId: venue.id, fetched: 0, inserted: 0,
      occurrencesUpserted: 0, skipped: 0, errors: [],
    };

    const orgHtml = await fetchHtml(`${EB_BASE}/o/${cfg.organizerId}`);
    if (!orgHtml) {
      result.errors.push('organizer page niet bereikbaar');
      results.push(result);
      continue;
    }
    const events = parseOrganizerEvents(orgHtml);
    result.fetched = events.length;

    const venueCategory = venue.categories?.[0] ?? 'Literatuur';

    for (const { slug, eventId } of events) {
      try {
        const detailUrl = `${EB_BASE}/e/${slug}-tickets-${eventId}`;
        const detailHtml = await fetchHtml(detailUrl);
        if (!detailHtml) {
          result.skipped++;
          result.errors.push(`${eventId}: detail unreachable`);
          continue;
        }
        const parsed = parseDetailJsonLd(detailHtml);
        if (!parsed) {
          result.skipped++;
          continue;
        }
        if (parsed.startsAt.getTime() < pastCutoff) {
          result.skipped++;
          continue;
        }

        const dbEventId = `evt-eb-${eventId}`;
        const occurrenceId = `occ-eb-${eventId}`;

        const [existing] = await db
          .select({ id: schema.events.id })
          .from(schema.events)
          .where(eq(schema.events.id, dbEventId))
          .limit(1);

        if (existing) {
          await db
            .insert(schema.occurrences)
            .values({
              id: occurrenceId, eventId: dbEventId,
              startsAt: parsed.startsAt, endsAt: parsed.endsAt,
              priceCents: null, priceNote: null, ticketUrl: detailUrl,
              room: parsed.locationName, lineup: null, status: 'scheduled',
            })
            .onConflictDoUpdate({
              target: schema.occurrences.id,
              set: {
                startsAt: parsed.startsAt, endsAt: parsed.endsAt,
                ticketUrl: detailUrl, room: parsed.locationName,
              },
            });
          result.occurrencesUpserted++;
          continue;
        }

        const enriched = await enrichEvent({
          title: parsed.name,
          description: parsed.description,
          venueName: venue.name,
          venueCategory,
        });

        let imageUrl: string | null = null;
        if (parsed.imageUrl) {
          imageUrl = (await mirrorImage(parsed.imageUrl, eventId)) ?? parsed.imageUrl;
        }

        const refinedKind = refineKindByDuration('show', parsed.startsAt, parsed.endsAt);

        await db.transaction(async (tx) => {
          await tx.insert(schema.events).values({
            id: dbEventId, venueId: venue.id, title: parsed.name,
            description: enriched.cleanedDescription ?? parsed.description,
            kind: refinedKind, imageUrl,
            category: enriched.category ?? venueCategory,
            featured: false, genres: enriched.genres, published: true,
          });
          result.inserted++;

          await tx
            .insert(schema.occurrences)
            .values({
              id: occurrenceId, eventId: dbEventId,
              startsAt: parsed.startsAt, endsAt: parsed.endsAt,
              priceCents: null, priceNote: enriched.priceNote,
              ticketUrl: detailUrl,
              room: parsed.locationName ?? enriched.room,
              lineup: enriched.lineup, status: 'scheduled',
            })
            .onConflictDoUpdate({
              target: schema.occurrences.id,
              set: {
                startsAt: parsed.startsAt, endsAt: parsed.endsAt,
                ticketUrl: detailUrl, room: parsed.locationName,
              },
            });
          result.occurrencesUpserted++;
        });
      } catch (e) {
        result.errors.push(`${eventId}: ${(e as Error).message}`);
        result.skipped++;
      }
    }
    results.push(result);
  }

  return results;
}
