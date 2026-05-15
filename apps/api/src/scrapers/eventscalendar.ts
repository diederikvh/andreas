import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Generieke scraper voor sites op **The Events Calendar (Pro)** —
 * een populaire WordPress-plugin. Per-venue config:
 *   `scraperConfig.eventscalendar = { apiBase: 'https://venue.nl/wp-json/tribe/events/v1' }`
 *
 * De plugin exposeert een publieke REST API:
 *   GET {apiBase}/events?per_page=50&start_date=YYYY-MM-DD
 *
 * Response shape: `{ events: [...], total, total_pages }` met per event
 * id/title/description/start_date/end_date/url/image/cost/etc.
 *
 * Gebruikt nu door Panama. Hergebruikbaar voor elk Wordpress-venue
 * met TEC plugin aan.
 *
 * Idempotency:
 *  - eventId      = `evt-{venueId}-{slug}` (of `-{id}` als slug ontbreekt)
 *  - occurrenceId = `occ-{venueId}-{slug}`
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36';

type TecEvent = {
  id: number;
  slug?: string;
  url: string;
  title: string;
  description?: string | null;
  excerpt?: string | null;
  start_date: string; // "YYYY-MM-DD HH:mm:ss" (venue-local)
  end_date: string;
  utc_start_date?: string;
  utc_end_date?: string;
  timezone?: string;
  all_day?: boolean;
  image?: { url?: string; mime_type?: string } | null;
  cost?: string;
  status?: string;
};

function stripHtml(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .replace(/<[^>]+>/g, '')
    // Numerieke entities (decimal én hex) — bv. &#8211; = en-dash,
    // &#8217; = right-single-quote, &#x27; = apostrofe. WordPress
    // koppelt deze er rijkelijk in.
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(parseInt(c, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, c) =>
      String.fromCodePoint(parseInt(c, 16))
    )
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parse "YYYY-MM-DD HH:mm:ss" met de TZ uit het event. Sites zijn
 *  meestal Europe/Amsterdam → +02:00 in CEST. We gebruiken utc_start_date
 *  als die er is, anders local + CEST-anchor. */
function buildDate(localStr: string, utcStr?: string): Date | null {
  if (utcStr) {
    const d = new Date(utcStr.replace(' ', 'T') + 'Z');
    if (!isNaN(d.getTime())) return d;
  }
  const m = localStr.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}+02:00`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

async function fetchAllEvents(apiBase: string): Promise<TecEvent[]> {
  const out: TecEvent[] = [];
  const today = new Date().toISOString().slice(0, 10);
  let page = 1;
  while (page < 10) {
    const url = `${apiBase}/events?per_page=50&start_date=${today}&page=${page}`;
    const r = await fetch(url, { headers: { 'user-agent': UA } });
    if (!r.ok) break;
    const json = (await r.json()) as { events?: TecEvent[]; total_pages?: number };
    const list = json.events ?? [];
    out.push(...list);
    if (list.length < 50) break;
    page++;
  }
  return out;
}

async function mirrorImage(
  sourceUrl: string,
  venueId: string,
  slug: string,
): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength < 1024 || buf.byteLength > 16 * 1024 * 1024) return null;
    const ext = mime.includes('png')
      ? 'png'
      : mime.includes('webp')
        ? 'webp'
        : 'jpg';
    return await uploadToBunny(
      `media/events/${venueId}-${slug}.${ext}`,
      buf,
      mime,
    );
  } catch (e) {
    console.warn(
      `[eventscalendar] mirror ${venueId}-${slug}: ${(e as Error).message}`,
    );
    return null;
  }
}

export type EventsCalendarVenueResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeEventsCalendar(options?: {
  venueIds?: string[];
}): Promise<EventsCalendarVenueResult[]> {
  const allVenues = await db.select().from(schema.venues);
  const targets = allVenues.filter((v) => {
    if (options?.venueIds && !options.venueIds.includes(v.id)) return false;
    return Boolean(v.scraperConfig?.eventscalendar?.apiBase);
  });

  const results: EventsCalendarVenueResult[] = [];

  for (const venue of targets) {
    const cfg = venue.scraperConfig!.eventscalendar!;
    const result: EventsCalendarVenueResult = {
      venueId: venue.id,
      fetched: 0,
      inserted: 0,
      occurrencesUpserted: 0,
      skipped: 0,
      errors: [],
    };

    let events: TecEvent[];
    try {
      events = await fetchAllEvents(cfg.apiBase);
    } catch (e) {
      result.errors.push(`fetch: ${(e as Error).message}`);
      results.push(result);
      continue;
    }
    result.fetched = events.length;

    const venueCategory = venue.categories?.[0] ?? 'Muziek';
    const cutoff = Date.now() - 6 * 60 * 60 * 1000;

    for (const e of events) {
      try {
        const slug = e.slug ?? String(e.id);
        const startsAt = buildDate(e.start_date, e.utc_start_date);
        if (!startsAt || startsAt.getTime() < cutoff) {
          result.skipped++;
          continue;
        }
        const endsAt =
          buildDate(e.end_date, e.utc_end_date) ??
          new Date(startsAt.getTime() + 4 * 60 * 60 * 1000);

        const title = stripHtml(e.title);
        if (!title) {
          result.skipped++;
          continue;
        }

        const eventId = `evt-${venue.id}-${slug}`;
        const occurrenceId = `occ-${venue.id}-${slug}`;

        const [existing] = await db
          .select({ id: schema.events.id })
          .from(schema.events)
          .where(eq(schema.events.id, eventId))
          .limit(1);

        let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;
        let imageUrl: string | null = null;

        if (!existing) {
          const cleanDesc = stripHtml(e.description ?? e.excerpt ?? null);
          try {
            enriched = await enrichEvent({
              title,
              description: cleanDesc || null,
              venueName: venue.name,
              venueCategory,
            });
          } catch (err) {
            result.errors.push(`enrich ${title}: ${(err as Error).message}`);
          }

          const src = e.image?.url ?? null;
          if (src) imageUrl = await mirrorImage(src, venue.id, slug);

          const eventKind = refineKindByDuration(
            enriched?.kind ?? 'show',
            startsAt,
            endsAt,
          );

          try {
            await db.insert(schema.events).values({
              id: eventId,
              venueId: venue.id,
              title,
              description: enriched?.cleanedDescription ?? cleanDesc ?? null,
              kind: eventKind,
              imageUrl,
              category: enriched?.category ?? venueCategory,
              featured: false,
              genres: enriched?.genres ?? [],
              published: true,
            });
            result.inserted++;
          } catch (err) {
            result.errors.push(`insert ${eventId}: ${(err as Error).message}`);
            continue;
          }
        }

        try {
          await db
            .insert(schema.occurrences)
            .values({
              id: occurrenceId,
              eventId,
              startsAt,
              endsAt,
              priceCents: null,
              priceNote: existing ? null : (enriched?.priceNote ?? e.cost ?? null),
              ticketUrl: e.url,
              room: null,
              lineup: existing ? null : (enriched?.lineup ?? null),
              status: 'scheduled',
            })
            .onConflictDoUpdate({
              target: schema.occurrences.id,
              set: {
                startsAt,
                endsAt,
                ticketUrl: e.url,
                status: 'scheduled',
              },
            });
          result.occurrencesUpserted++;
        } catch (err) {
          result.errors.push(`occurrence ${slug}: ${(err as Error).message}`);
          result.skipped++;
        }
      } catch (err) {
        result.errors.push(`event ${e.id}: ${(err as Error).message}`);
        result.skipped++;
      }
    }

    results.push(result);
  }

  return results;
}
