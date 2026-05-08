import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Ziggo Dome scraper. Hun /agenda is een Next.js SPA achter Cloudflare,
 * maar /api/agenda/aankomend is een publieke JSON-API zonder block.
 * Dus geen browser nodig — gewoon REST.
 *
 * API: https://www.ziggodome.nl/api/agenda/aankomend?limit=20&offset=N
 *   { data: Event[], pagination: ... }
 *
 * Per event:
 *   id (UUID), showDate, performerName, event.title (tour-naam),
 *   description (HTML), genres[], artistImage.assetFileSas (signed URL),
 *   salesUrl (Ticketmaster).
 *
 * Idempotency: event-id = `evt-zd-{venueId}-{stableId}` waarbij
 * stableId = id (UUID, stabiel). Image-URLs zijn time-limited (SAS),
 * dus altijd mirroren naar Bunny.
 */

const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const VENUE_ID = 'ziggo-dome';
const API_BASE = 'https://www.ziggodome.nl/api/agenda/aankomend';

type ZiggoAsset = {
  assetId: string;
  assetFileSas: string;
};

type ZiggoEvent = {
  id: string;
  eventId: string;
  showDate: string;
  showState: string;
  showTimeUnknown: number;
  performerName: string;
  event: { title?: string };
  description: string | null;
  description_en: string | null;
  preview?: string;
  salesUrl: string | null;
  artistImage?: ZiggoAsset;
  backgroundImage?: ZiggoAsset;
  /** Ziggo geeft dit als JSON-string terug, niet als array. */
  genres?: string | { name: string; name_en?: string }[];
  visible: number;
};

function parseZiggoGenres(
  raw: ZiggoEvent['genres']
): { name: string }[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function fetchPage(offset: number, limit = 20): Promise<ZiggoEvent[]> {
  const r = await fetch(`${API_BASE}?limit=${limit}&offset=${offset}`, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    redirect: 'follow',
  });
  if (!r.ok) throw new Error(`Ziggo API HTTP ${r.status}`);
  const j = (await r.json()) as { data: ZiggoEvent[] };
  return j.data;
}

async function fetchAll(): Promise<ZiggoEvent[]> {
  const all: ZiggoEvent[] = [];
  let offset = 0;
  const PAGE = 20;
  while (true) {
    const page = await fetchPage(offset, PAGE);
    all.push(...page);
    if (page.length < PAGE) break;
    offset += PAGE;
    if (offset > 500) break; // safety
  }
  return all;
}

async function mirrorImage(
  sourceUrl: string,
  stableId: string
): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 8 * 1024 * 1024) return null;
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    const path = `media/events/zd-${stableId}.${ext}`;
    return await uploadToBunny(path, buf, mime);
  } catch (e) {
    console.warn(`[ziggodome] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

/** Strip HTML naar plain text + decoder voor &nbsp; etc. */
function htmlToText(html: string): string {
  return html
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Combineer artist + tour-titel: "The Neighbourhood — The Wourld Tour" */
function buildTitle(ev: ZiggoEvent): string {
  const performer = ev.performerName?.trim() ?? '';
  const tour = ev.event?.title?.trim() ?? '';
  if (performer && tour && tour !== performer) return `${performer} — ${tour}`;
  return performer || tour || 'Untitled';
}

export type ZiggodomeResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeZiggodome(options?: {
  venueIds?: string[];
}): Promise<ZiggodomeResult[]> {
  // Gate: alleen runnen als ziggo-dome in scope
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) {
    return [];
  }

  const result: ZiggodomeResult = {
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
    result.errors.push('venue ziggo-dome niet in DB');
    return [result];
  }

  let events: ZiggoEvent[];
  try {
    events = await fetchAll();
  } catch (e) {
    result.errors.push(`fetch: ${(e as Error).message}`);
    return [result];
  }
  result.fetched = events.length;

  // Cutoff: nu - 6u (zelfde pattern als andere scrapers)
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  const upcoming = events.filter((e) => {
    if (!e.visible) return false;
    const t = new Date(e.showDate.replace(' ', 'T')).getTime();
    return t > cutoff;
  });

  const venueCategory = venue.categories?.[0] ?? 'Muziek';

  for (const ev of upcoming) {
    try {
      const eventId = `evt-zd-${VENUE_ID}-${ev.id}`;
      const occurrenceId = `occ-zd-${VENUE_ID}-${ev.id}`;
      const title = buildTitle(ev);
      const sourceDescription =
        ev.description?.trim() ?? ev.preview?.trim() ?? null;
      const rawDescription = sourceDescription ? htmlToText(sourceDescription) : null;

      // Genres uit Ziggo's eigen tags (lowercase)
      const ziggoGenres = parseZiggoGenres(ev.genres)
        .map((g) => g.name?.toLowerCase().trim())
        .filter((g): g is string => !!g && g.length > 0)
        .slice(0, 4);

      const enriched = await enrichEvent({
        title,
        description: rawDescription,
        venueName: venue.name,
        venueCategory,
      });

      // ShowDate is in lokale tijd ("2026-05-08 18:00:00") — geen Z, geen offset.
      // Behandel als Europe/Amsterdam: parse en corrigeer naar UTC.
      const startsAt = parseLocalDateTime(ev.showDate);

      const status: 'scheduled' | 'cancelled' | 'sold_out' =
        ev.showState === 'SoldOut'
          ? 'sold_out'
          : ev.showState === 'Cancelled'
            ? 'cancelled'
            : 'scheduled';

      // Image-mirror altijd (SAS-tokens verlopen)
      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      let imageUrl: string | null = null;
      if (!existing) {
        const sourceImg =
          ev.backgroundImage?.assetFileSas ?? ev.artistImage?.assetFileSas;
        if (sourceImg) {
          imageUrl = (await mirrorImage(sourceImg, ev.id)) ?? null;
        }
      }

      const finalGenres =
        enriched.genres.length > 0 ? enriched.genres : ziggoGenres;

      const refinedKind = refineKindByDuration(enriched.kind, startsAt, null);

      await db.transaction(async (tx) => {
        if (!existing) {
          await tx.insert(schema.events).values({
            id: eventId,
            venueId: venue.id,
            title,
            description: enriched.cleanedDescription ?? rawDescription,
            kind: refinedKind,
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
            startsAt,
            endsAt: null,
            priceCents: null,
            priceNote: enriched.priceNote,
            ticketUrl: ev.salesUrl,
            room: enriched.room,
            lineup: enriched.lineup,
            status,
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: {
              startsAt,
              priceNote: enriched.priceNote,
              ticketUrl: ev.salesUrl,
              room: enriched.room,
              lineup: enriched.lineup,
              status,
            },
          });
        result.occurrencesUpserted++;
      });
    } catch (e) {
      result.errors.push(`event ${ev.id}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}

/** Parse "2026-05-08 18:00:00" (Europe/Amsterdam, geen offset) naar UTC Date. */
function parseLocalDateTime(local: string): Date {
  const [d, t] = local.split(' ');
  const [y, mo, da] = d.split('-').map(Number);
  const [hh, mi, ss] = (t ?? '20:00:00').split(':').map(Number);
  // Bouw tentative UTC en corrigeer met offset
  const tentative = new Date(Date.UTC(y, mo - 1, da, hh, mi, ss ?? 0));
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Amsterdam',
    timeZoneName: 'longOffset',
  });
  const off = dtf
    .formatToParts(tentative)
    .find((p) => p.type === 'timeZoneName')?.value;
  const m = off?.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  const sign = m && m[1] === '+' ? 1 : -1;
  const h = m ? parseInt(m[2], 10) : 0;
  const mins = m ? parseInt(m[3] ?? '0', 10) : 0;
  return new Date(tentative.getTime() - sign * (h * 60 + mins) * 60_000);
}
