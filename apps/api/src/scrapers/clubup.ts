import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';
import { loadVenueTitleMap, resolveEventId } from './_title-dedup.js';

/**
 * ClubUp (Leidseplein) — Squarespace site, events-collection bereik-
 * baar als JSON via `?format=json-pretty`. Geen API-key nodig.
 *
 *   GET https://www.clubup.nl/program?format=json-pretty
 *
 * Items in `upcoming[]` met velden:
 *   id, urlId, title, body (HTML), excerpt, startDate (ms epoch),
 *   endDate, fullUrl ("/program/{urlId}"), assetUrl (image).
 *
 * Idempotency: `evt-cu-{urlId}`, `occ-cu-{urlId}`.
 */

const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const FEED_URL = 'https://www.clubup.nl/program?format=json-pretty';
const SITE_BASE = 'https://www.clubup.nl';
const VENUE_ID = 'clubup';

type ClubUpEvent = {
  id: string;
  urlId: string;
  title: string;
  body?: string | null;
  excerpt?: string | null;
  startDate: number;
  endDate?: number | null;
  fullUrl: string;
  assetUrl?: string | null;
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(parseInt(c, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, c) => String.fromCodePoint(parseInt(c, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, ' ');
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function fetchEvents(): Promise<ClubUpEvent[]> {
  try {
    const r = await fetch(FEED_URL, {
      headers: { 'user-agent': UA, accept: 'application/json' },
    });
    if (!r.ok) return [];
    const d = (await r.json()) as { upcoming?: ClubUpEvent[] };
    return d.upcoming ?? [];
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
    return await uploadToBunny(`media/events/cu-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[clubup] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type ClubUpResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeClubUp(_options?: {
  venueIds?: string[];
}): Promise<ClubUpResult[]> {
  const result: ClubUpResult = {
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

  const byTitle = await loadVenueTitleMap(VENUE_ID, 'evt-cu-');

  for (const ev of items) {
    try {
      if (!ev.urlId || !ev.title || !ev.startDate) {
        result.skipped++;
        continue;
      }
      const startsAt = new Date(ev.startDate);
      const endsAt = ev.endDate ? new Date(ev.endDate) : null;
      if (Number.isNaN(startsAt.getTime()) || startsAt.getTime() < cutoff) {
        result.skipped++;
        continue;
      }

      const title = decodeEntities(ev.title).trim();
      // body/excerpt zitten in dezelfde feed-respons, dus inline als
      // signaal — puur string-werk, geen extra request.
      const { eventId } = resolveEventId(byTitle, title, `evt-cu-${ev.urlId}`, {
        startsAt,
        description: ev.body
          ? decodeEntities(stripTags(ev.body)).slice(0, 800)
          : ev.excerpt
            ? decodeEntities(stripTags(ev.excerpt)).slice(0, 800)
            : null,
      });
      const occurrenceId = `occ-cu-${ev.urlId}`;

      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;

      if (!existing) {
        let imageUrl: string | null = null;
        if (ev.assetUrl) {
          imageUrl = (await mirrorImage(ev.assetUrl, ev.urlId)) ?? ev.assetUrl;
        }
        const description = ev.body
          ? decodeEntities(stripTags(ev.body)).slice(0, 800)
          : ev.excerpt
            ? decodeEntities(stripTags(ev.excerpt)).slice(0, 800)
            : null;

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
          enriched?.kind ?? 'show', startsAt, endsAt,
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
        const ticketUrl = `${SITE_BASE}${ev.fullUrl}`;
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
            // eventId meenemen: occurrences die nog aan een los event
            // hingen verhuizen zo zelf mee.
            set: { eventId, startsAt, endsAt, ticketUrl },
          });
        result.occurrencesUpserted++;
      } catch (e) {
        result.errors.push(`occurrence ${ev.urlId}: ${(e as Error).message}`);
        result.skipped++;
      }
    } catch (e) {
      result.errors.push(`event ${ev.id}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
