import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Het Veronica Schip — clubboot op Levantkade. Custom PHP-API levert
 * een platte JSON-lijst:
 *
 *   GET https://hetveronicaschip.nl/api/events
 *
 * Response: `[{ id, title, description, short_description, event_date
 *   (YYYY-MM-DDTHH:MM), location, image ("/uploads/..."), price,
 *   booking_url, is_featured, created_at }, ...]`
 *
 * Idempotency: `evt-vs-{id}`, `occ-vs-{id}`.
 */

const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const BASE = 'https://hetveronicaschip.nl';
const VENUE_ID = 'veronica-schip';

type VeronicaEvent = {
  id: number;
  title: string;
  description?: string | null;
  short_description?: string | null;
  event_date: string;
  location?: string | null;
  image?: string | null;
  price?: string | number | null;
  booking_url?: string | null;
  is_featured?: boolean;
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(parseInt(c, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, c) => String.fromCodePoint(parseInt(c, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, ' ');
}

async function fetchEvents(): Promise<VeronicaEvent[]> {
  try {
    const r = await fetch(`${BASE}/api/events`, {
      headers: { 'user-agent': UA, accept: 'application/json' },
    });
    if (!r.ok) return [];
    return (await r.json()) as VeronicaEvent[];
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
    return await uploadToBunny(`media/events/vs-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[veronica] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type VeronicaResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeVeronica(_options?: {
  venueIds?: string[];
}): Promise<VeronicaResult[]> {
  const result: VeronicaResult = {
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
      if (!ev.id || !ev.title || !ev.event_date) {
        result.skipped++;
        continue;
      }
      // event_date = "2026-10-21T16:00" — geen tz-marker; interpreteer
      // als Amsterdam-lokaal. DST grof: mar-oct = +02, anders +01.
      const m = parseInt(ev.event_date.slice(5, 7), 10);
      const dst = m >= 3 && m <= 10;
      const off = dst ? '+02:00' : '+01:00';
      const startsAt = new Date(`${ev.event_date}:00${off}`);
      if (Number.isNaN(startsAt.getTime()) || startsAt.getTime() < cutoff) {
        result.skipped++;
        continue;
      }

      const title = decodeEntities(ev.title).trim();
      const eventId = `evt-vs-${ev.id}`;
      const occurrenceId = `occ-vs-${ev.id}`;

      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;

      if (!existing) {
        let imageUrl: string | null = null;
        if (ev.image) {
          // image-paden zijn relative ("/uploads/..."); maak absolute
          const sourceImg = ev.image.startsWith('http') ? ev.image : `${BASE}${ev.image}`;
          imageUrl = (await mirrorImage(sourceImg, String(ev.id))) ?? sourceImg;
        }
        const description = ev.description
          ? decodeEntities(ev.description).slice(0, 800)
          : ev.short_description ? decodeEntities(ev.short_description).slice(0, 800) : null;

        try {
          enriched = await enrichEvent({
            title,
            description,
            venueName: venue.name,
            venueCategory: 'Muziek',
          });
        } catch (e) {
          result.errors.push(`enrich ${title}: ${(e as Error).message}`);
        }

        const eventKind = refineKindByDuration(
          enriched?.kind ?? 'show', startsAt, null,
        );

        try {
          await db.insert(schema.events).values({
            id: eventId,
            venueId: VENUE_ID,
            title,
            description: enriched?.cleanedDescription ?? description,
            kind: eventKind,
            imageUrl,
            category: enriched?.category ?? 'Muziek',
            featured: Boolean(ev.is_featured),
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
        const ticketUrl = ev.booking_url || `${BASE}/events.html#event-${ev.id}`;
        await db
          .insert(schema.occurrences)
          .values({
            id: occurrenceId,
            eventId,
            startsAt,
            endsAt: null,
            priceCents: null,
            priceNote: existing ? null : (enriched?.priceNote ?? null),
            ticketUrl,
            room: ev.location ?? null,
            lineup: existing ? null : (enriched?.lineup ?? null),
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: { startsAt, ticketUrl },
          });
        result.occurrencesUpserted++;
      } catch (e) {
        result.errors.push(`occurrence ${ev.id}: ${(e as Error).message}`);
        result.skipped++;
      }
    } catch (e) {
      result.errors.push(`event ${ev.id}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
