import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';
import { loadVenueTitleMap, resolveEventId } from './_title-dedup.js';

/**
 * Celebratix is een ticket-platform met een publieke API per "channel".
 * Geen API key nodig — alleen het channel-ID dat de venue zelf
 * publiceert in hun ticketwidget. Eerste gebruiker is BRET (channel
 * `fuef7`); andere clubs kunnen op dezelfde scraper via DB-config.
 *
 *   GET https://api.celebratix.io/v2/consumers/Events?channel={channel}&pageSize=100
 *
 * Response: `{ data: { rowCount, list: [{ sqid, name, location,
 *   image: { path }, startDateWithTimezone, endDateWithTimezone }, ...] } }`.
 *
 * Images via `https://img.celebratix.io/files/{uuid}?width=1200`.
 *
 * Idempotency: `eventId = evt-cel-{venueId}-{sqid}`,
 *              `occurrenceId = occ-cel-{venueId}-{sqid}`.
 */

const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const API_BASE = 'https://api.celebratix.io/v2/consumers/Events';
// Image-path uit API bevat al `files/{uuid}` prefix, dus base zonder /files.
const IMG_BASE = 'https://img.celebratix.io';
const SHOP_BASE = 'https://shop.celebratix.io/event';

type ApiEvent = {
  sqid: string;
  name: string;
  location?: string | null;
  city?: string | null;
  shortDescription?: string | null;
  image?: { path?: string } | null;
  startDateWithTimezone?: { dateTime: string; timezone?: string };
  endDateWithTimezone?: { dateTime: string; timezone?: string } | null;
};

async function fetchEvents(channel: string): Promise<ApiEvent[]> {
  try {
    const u = `${API_BASE}?channel=${encodeURIComponent(channel)}&pageSize=100`;
    const r = await fetch(u, {
      headers: { 'user-agent': UA, accept: 'application/json' },
    });
    if (!r.ok) return [];
    const d = (await r.json()) as { data?: { list?: ApiEvent[] } };
    return d.data?.list ?? [];
  } catch {
    return [];
  }
}

async function mirrorImage(sourceUrl: string, slug: string): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength < 1024 || buf.byteLength > 16 * 1024 * 1024) return null;
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : mime.includes('avif') ? 'avif' : 'jpg';
    return await uploadToBunny(`media/events/cel-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[celebratix] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type CelebratixVenueResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeCelebratix(options?: {
  venueIds?: string[];
}): Promise<CelebratixVenueResult[]> {
  const allVenues = await db.select().from(schema.venues);
  const targets = allVenues.filter((v) => {
    if (options?.venueIds && !options.venueIds.includes(v.id)) return false;
    return Boolean(v.scraperConfig?.celebratix?.channel);
  });

  const results: CelebratixVenueResult[] = [];

  for (const venue of targets) {
    const cfg = venue.scraperConfig!.celebratix!;
    const result: CelebratixVenueResult = {
      venueId: venue.id,
      fetched: 0,
      inserted: 0,
      occurrencesUpserted: 0,
      skipped: 0,
      errors: [],
    };
    const venueCategory = venue.categories?.[0] ?? 'Muziek';
    // Celebratix geeft per avond een eigen sqid, dus een wekelijkse
    // clubavond werd 14 losse events ("Dynasty | 21+" bij Chin Chin).
    // Titel binnen de venue is de identiteit; zie _title-dedup.ts.
    const byTitle = await loadVenueTitleMap(venue.id, `evt-cel-${venue.id}-`);

    const events = await fetchEvents(cfg.channel);
    result.fetched = events.length;
    if (events.length === 0) {
      result.errors.push(`geen events voor channel ${cfg.channel}`);
      results.push(result);
      continue;
    }

    const cutoff = Date.now() - 6 * 60 * 60 * 1000;

    for (const ev of events) {
      try {
        if (!ev.sqid || !ev.name || !ev.startDateWithTimezone?.dateTime) {
          result.skipped++;
          continue;
        }
        const startsAt = new Date(ev.startDateWithTimezone.dateTime);
        if (isNaN(startsAt.getTime()) || startsAt.getTime() < cutoff) {
          result.skipped++;
          continue;
        }
        const endsAt = ev.endDateWithTimezone?.dateTime ? new Date(ev.endDateWithTimezone.dateTime) : null;

        const { eventId } = resolveEventId(
          byTitle,
          ev.name,
          `evt-cel-${venue.id}-${ev.sqid}`,
          { startsAt, description: ev.shortDescription?.trim() || null }
        );
        const [existing] = await db
          .select({ id: schema.events.id })
          .from(schema.events)
          .where(eq(schema.events.id, eventId))
          .limit(1);

        let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;

        if (!existing) {
          const description = ev.shortDescription?.trim() || null;
          const sourceImg = ev.image?.path ? `${IMG_BASE}/${ev.image.path}?width=1200` : null;
          let imageUrl: string | null = null;
          if (sourceImg) {
            imageUrl = (await mirrorImage(sourceImg, `${venue.id}-${ev.sqid}`)) ?? sourceImg;
          }

          try {
            enriched = await enrichEvent({
              title: ev.name,
              description,
              venueName: venue.name,
              venueCategory,
            });
          } catch (e) {
            result.errors.push(`enrich ${ev.name}: ${(e as Error).message}`);
          }

          const eventKind = refineKindByDuration(enriched?.kind ?? 'show', startsAt, endsAt);

          try {
            await db.insert(schema.events).values({
              id: eventId,
              venueId: venue.id,
              title: ev.name,
              description: enriched?.cleanedDescription ?? description,
              kind: eventKind,
              imageUrl,
              category: enriched?.category ?? venueCategory,
              featured: false,
              genres: enriched?.genres ?? [],
              published: true,
            });
            result.inserted++;
          } catch (e) {
            result.errors.push(`insert event ${eventId}: ${(e as Error).message}`);
            continue;
          }
        }

        try {
          const occurrenceId = `occ-cel-${venue.id}-${ev.sqid}`;
          // Venue-specifieke widget-URL als geconfigureerd (zoals
          // BRET's filesusr.com host), anders generic Celebratix-shop.
          const ticketUrl = cfg.ticketUrlBase
            ? `${cfg.ticketUrlBase}${cfg.ticketUrlBase.includes('?') ? '&' : '?'}eventId=${ev.sqid}`
            : `${SHOP_BASE}/${ev.sqid}`;
          await db
            .insert(schema.occurrences)
            .values({
              id: occurrenceId,
              eventId,
              startsAt,
              endsAt,
              priceCents: null,
              priceNote: existing ? null : (enriched?.priceNote ?? null),
              ticketUrl,
              room: null,
              lineup: existing ? null : (enriched?.lineup ?? null),
              status: 'scheduled',
            })
            .onConflictDoUpdate({
              target: schema.occurrences.id,
              // eventId meenemen: bestaande occurrences die nog aan een
              // per-avond-event hingen verhuizen zo zelf naar het
              // canonieke event. Zonder dit blijft de historie dubbel.
              set: { eventId, startsAt, endsAt, ticketUrl },
            });
          result.occurrencesUpserted++;
        } catch (e) {
          result.errors.push(`occurrence ${ev.sqid}: ${(e as Error).message}`);
          result.skipped++;
        }
      } catch (e) {
        result.errors.push(`event ${ev.sqid}: ${(e as Error).message}`);
        result.skipped++;
      }
    }
    results.push(result);
  }

  return results;
}
