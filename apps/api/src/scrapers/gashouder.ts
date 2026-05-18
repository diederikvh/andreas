import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Gashouder (Westerpark) — Nuxt-frontend, DatoCMS backend met publieke
 * Content Delivery API token (zit in `window.__NUXT__.config`).
 *
 *   POST https://graphql.datocms.com/
 *     { query: "{ allEvents(first:100) { ... dates { start end } ... } }" }
 *
 * EventRecord fields:
 *   id, title, slug, subtitle, eventType, eventStatus, shortDescription,
 *   ticketUrl, ticketPrice, heroImage { url }, dates [{ start, end }]
 *
 * Eén event kan meerdere `dates` hebben (multi-night). Idempotency:
 *   eventId = `evt-gh-{slug}`
 *   occurrenceId = `occ-gh-{slug}-{ISO-date}`
 */

const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const DATO_TOKEN = '3d80bddfea0c484c6bf1c1db87ba8c';
const VENUE_ID = 'gashouder';

type DateItem = { start: string; end?: string | null };
type DatoEvent = {
  id: string;
  title: string | null;
  slug: string | null;
  subtitle?: string | null;
  eventType?: string | null;
  eventStatus?: string | null;
  shortDescription?: string | null;
  ticketUrl?: string | null;
  ticketPrice?: string | null;
  heroImage?: { url?: string } | null;
  dates: DateItem[];
};

const QUERY = `{
  allEvents(first: 100) {
    id title slug subtitle eventType eventStatus shortDescription
    ticketUrl ticketPrice
    heroImage { url }
    dates { start end }
  }
}`;

async function fetchEvents(): Promise<DatoEvent[]> {
  try {
    const r = await fetch('https://graphql.datocms.com/', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${DATO_TOKEN}`,
        'content-type': 'application/json',
        'user-agent': UA,
      },
      body: JSON.stringify({ query: QUERY }),
    });
    if (!r.ok) return [];
    const d = (await r.json()) as { data?: { allEvents?: DatoEvent[] } };
    return d.data?.allEvents ?? [];
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
    const ext = mime.includes('png') ? 'png'
      : mime.includes('webp') ? 'webp'
      : mime.includes('avif') ? 'avif' : 'jpg';
    return await uploadToBunny(`media/events/gh-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[gashouder] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

type Category = 'Muziek' | 'Theater' | 'Literatuur' | 'Film' | 'Kunst' | 'Lezing';

function mapCategory(eventType: string | null | undefined): Category {
  const t = (eventType ?? '').toLowerCase();
  if (t.includes('film')) return 'Film';
  if (t.includes('expo') || t.includes('exhibition') || t.includes('takeover')) return 'Kunst';
  if (t.includes('talk') || t.includes('lezing')) return 'Lezing';
  // performance, concert, club, pre-opening → Muziek
  return 'Muziek';
}

export type GashouderResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeGashouder(_options?: {
  venueIds?: string[];
}): Promise<GashouderResult[]> {
  const result: GashouderResult = {
    venueId: VENUE_ID, fetched: 0, inserted: 0,
    occurrencesUpserted: 0, skipped: 0, errors: [],
  };

  const [venue] = await db
    .select()
    .from(schema.venues)
    .where(eq(schema.venues.id, VENUE_ID))
    .limit(1);
  if (!venue) {
    result.errors.push(`venue ${VENUE_ID} bestaat niet`);
    return [result];
  }

  const items = await fetchEvents();
  result.fetched = items.length;

  const cutoff = Date.now() - 6 * 60 * 60 * 1000;

  for (const ev of items) {
    try {
      if (!ev.slug || !ev.title) {
        result.skipped++;
        continue;
      }
      const futureDates = (ev.dates ?? []).filter((d) => {
        const t = new Date(d.start).getTime();
        return !Number.isNaN(t) && t > cutoff;
      });
      if (futureDates.length === 0) {
        result.skipped++;
        continue;
      }

      const eventId = `evt-gh-${ev.slug}`;
      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      const mappedCategory = mapCategory(ev.eventType);
      let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;

      if (!existing) {
        let imageUrl: string | null = null;
        if (ev.heroImage?.url) {
          imageUrl = (await mirrorImage(ev.heroImage.url, ev.slug)) ?? ev.heroImage.url;
        }
        const description = ev.shortDescription
          ?? (ev.subtitle ?? null);

        try {
          enriched = await enrichEvent({
            title: ev.title,
            description,
            venueName: venue.name,
            venueCategory: mappedCategory,
          });
        } catch (e) {
          result.errors.push(`enrich ${ev.title}: ${(e as Error).message}`);
        }

        const firstStart = new Date(futureDates[0].start);
        const firstEnd = futureDates[0].end ? new Date(futureDates[0].end) : null;
        const eventKind = refineKindByDuration(
          enriched?.kind ?? 'show', firstStart, firstEnd,
        );

        try {
          await db.insert(schema.events).values({
            id: eventId,
            venueId: VENUE_ID,
            title: ev.title,
            description: enriched?.cleanedDescription ?? description,
            kind: eventKind,
            imageUrl,
            category: enriched?.category ?? mappedCategory,
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

      for (const dt of futureDates) {
        try {
          const startsAt = new Date(dt.start);
          const endsAt = dt.end ? new Date(dt.end) : null;
          const isoDate = startsAt.toISOString().slice(0, 10);
          const occurrenceId = `occ-gh-${ev.slug}-${isoDate}`;
          const ticketUrl = ev.ticketUrl
            || `https://gashouder.nl/programma/${ev.slug}`;
          await db
            .insert(schema.occurrences)
            .values({
              id: occurrenceId,
              eventId,
              startsAt,
              endsAt,
              priceCents: null,
              priceNote: existing ? null : (enriched?.priceNote ?? ev.ticketPrice ?? null),
              ticketUrl,
              room: null,
              lineup: existing ? null : (enriched?.lineup ?? null),
              status: 'scheduled',
            })
            .onConflictDoUpdate({
              target: schema.occurrences.id,
              set: { startsAt, endsAt, ticketUrl },
            });
          result.occurrencesUpserted++;
        } catch (e) {
          result.errors.push(`occurrence ${ev.slug}: ${(e as Error).message}`);
          result.skipped++;
        }
      }
    } catch (e) {
      result.errors.push(`event ${ev.id}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
