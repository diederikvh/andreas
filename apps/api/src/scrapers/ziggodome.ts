import { createHash } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

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
  /** Stale signed URL — niet bruikbaar omdat de SAS verlopen is. */
  assetFileSas: string;
  /** Pad naar het bestand zonder signature, gebruik op publieke CDN. */
  assetFileName: string;
};

/** Bouw publieke CDN-URL uit assetFileName (Ziggo's Azure SAS-tokens
 *  zijn al verlopen wanneer hun API ze teruggeeft, maar dezelfde
 *  bestanden zijn ook publiek beschikbaar via cdn.ziggodome.nl). */
function ziggoCdnUrl(asset?: ZiggoAsset): string | null {
  if (!asset?.assetFileName) return null;
  // assetFileName begint typisch met `images/event/...`. Pad URL-encode.
  const encoded = encodeURI(asset.assetFileName);
  return `https://cdn.ziggodome.nl/assets/${encoded}`;
}

type ZiggoEvent = {
  id: string;
  eventId: string;
  showDate: string;
  showState: string;
  showTimeUnknown: number;
  /** 1 = tijd in `showDate` klopt, 0 = placeholder (vaak 18:00). Bij 0
      moet de echte tijd via Ticketmaster's JSON-LD opgehaald worden. */
  showShowTime?: number;
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

  // Groepeer recurring concerten op genormaliseerde titel zodat
  // "NE-YO & AKON — Nights Like This Tour 2026" op vr+za niet als
  // 2 losse events maar als 1 event met 2 occurrences worden opgeslagen.
  // Sleutel = lowercase performer + tour-titel (concat).
  const groups = new Map<string, ZiggoEvent[]>();
  for (const ev of upcoming) {
    const key = buildTitle(ev).toLowerCase().trim();
    const arr = groups.get(key) ?? [];
    arr.push(ev);
    groups.set(key, arr);
  }

  // Cache TM-page-lookups zodat een artist-page met 5 shows maar
  // één keer gefetched wordt (zelfde salesUrl bij groups).
  const tmStartCache = new Map<string, string | null>();

  for (const [groupKey, instances] of groups) {
    instances.sort(
      (a, b) =>
        new Date(a.showDate.replace(' ', 'T')).getTime() -
        new Date(b.showDate.replace(' ', 'T')).getTime()
    );
    const first = instances[0];

    try {
      const groupHash = shortHash(`zd|${groupKey}`);
      const eventId = `evt-zd-${VENUE_ID}-${groupHash}`;
      const title = buildTitle(first);

      // Vroege existing-check: skip Claude voor bestaande events.
      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      if (existing) {
        for (const inst of instances) {
          const startsAt = await resolveStartsAt(inst, tmStartCache);
          const occurrenceId = `occ-zd-${VENUE_ID}-${shortHash(`${groupKey}|${inst.showDate}`)}`;
          const status: 'scheduled' | 'cancelled' | 'sold_out' =
            inst.showState === 'SoldOut'
              ? 'sold_out'
              : inst.showState === 'Cancelled'
                ? 'cancelled'
                : 'scheduled';
          await db
            .insert(schema.occurrences)
            .values({
              id: occurrenceId,
              eventId,
              startsAt,
              endsAt: null,
              priceCents: null,
              priceNote: null,
              ticketUrl: inst.salesUrl,
              room: null,
              lineup: null,
              status,
            })
            .onConflictDoUpdate({
              target: schema.occurrences.id,
              set: { startsAt, ticketUrl: inst.salesUrl, status },
            });
          result.occurrencesUpserted++;
        }
        continue;
      }

      // Nieuw event — Claude enrich + image-mirror.
      const sourceDescription =
        first.description?.trim() ?? first.preview?.trim() ?? null;
      const rawDescription = sourceDescription
        ? htmlToText(sourceDescription)
        : null;

      const ziggoGenres = parseZiggoGenres(first.genres)
        .map((g) => g.name?.toLowerCase().trim())
        .filter((g): g is string => !!g && g.length > 0)
        .slice(0, 4);

      const enriched = await enrichEvent({
        title,
        description: rawDescription,
        venueName: venue.name,
        venueCategory,
      });

      let imageUrl: string | null = null;
      const sourceImg =
        ziggoCdnUrl(first.backgroundImage) ?? ziggoCdnUrl(first.artistImage);
      if (sourceImg) {
        imageUrl = (await mirrorImage(sourceImg, groupHash)) ?? null;
      }

      const finalGenres =
        enriched.genres.length > 0 ? enriched.genres : ziggoGenres;

      const refinedKind = refineKindByDuration(
        enriched.kind,
        parseLocalDateTime(first.showDate),
        null
      );

      await db.transaction(async (tx) => {
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

        for (const inst of instances) {
          const startsAt = await resolveStartsAt(inst, tmStartCache);
          const occurrenceId = `occ-zd-${VENUE_ID}-${shortHash(`${groupKey}|${inst.showDate}`)}`;
          const status: 'scheduled' | 'cancelled' | 'sold_out' =
            inst.showState === 'SoldOut'
              ? 'sold_out'
              : inst.showState === 'Cancelled'
                ? 'cancelled'
                : 'scheduled';

          await tx
            .insert(schema.occurrences)
            .values({
              id: occurrenceId,
              eventId,
              startsAt,
              endsAt: null,
              priceCents: null,
              priceNote: enriched.priceNote,
              ticketUrl: inst.salesUrl,
              room: enriched.room,
              lineup: enriched.lineup,
              status,
            })
            .onConflictDoUpdate({
              target: schema.occurrences.id,
              set: {
                startsAt,
                priceNote: enriched.priceNote,
                ticketUrl: inst.salesUrl,
                room: enriched.room,
                lineup: enriched.lineup,
                status,
              },
            });
          result.occurrencesUpserted++;
        }
      });
    } catch (e) {
      result.errors.push(`group ${groupKey}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}

/**
 * Ziggo Dome's API geeft voor 88% van de events een placeholder
 * `showDate` (vaak 18:00) met `showShowTime: 0` — "tijd nog niet
 * definitief". De echte showtime staat wel op de Ticketmaster-page
 * waar `salesUrl` naar wijst, in een JSON-LD `MusicEvent.startDate`.
 *
 * Cache wordt door de caller bijgehouden zodat we per salesUrl maar
 * één keer fetchen. TM throttle: ~500ms per call is genoeg.
 */
async function fetchTicketmasterStartTime(
  salesUrl: string,
  cache: Map<string, string | null>,
): Promise<string | null> {
  if (cache.has(salesUrl)) return cache.get(salesUrl) ?? null;
  try {
    const r = await fetch(salesUrl, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        accept: 'text/html',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      cache.set(salesUrl, null);
      return null;
    }
    const html = await r.text();
    // JSON-LD MusicEvent blok extract: zoekt `"startDate":"<ISO>"`.
    // Naive ISO (geen Z) want TM levert lokaal-tijd.
    const m = html.match(/"startDate"\s*:\s*"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})"/);
    const start = m?.[1] ?? null;
    cache.set(salesUrl, start);
    return start;
  } catch {
    cache.set(salesUrl, null);
    return null;
  }
}

/**
 * Bepaal het juiste startsAt voor een Ziggo-event. Default: `showDate`
 * uit hun eigen API. Maar als `showShowTime === 0` (88% van events)
 * is `showDate` een placeholder en moeten we via Ticketmaster's
 * JSON-LD de echte tijd halen.
 */
async function resolveStartsAt(
  inst: ZiggoEvent,
  tmCache: Map<string, string | null>,
): Promise<Date> {
  const fallback = parseLocalDateTime(inst.showDate);
  if (inst.showShowTime === 1 || !inst.salesUrl) return fallback;
  const tmStart = await fetchTicketmasterStartTime(inst.salesUrl, tmCache);
  if (!tmStart) return fallback;
  // TM levert naive ISO (geen Z, Amsterdam-local), bv. "2026-06-14T20:00:00".
  // parseLocalDateTime verwacht "YYYY-MM-DD HH:MM:SS" — converteer.
  const normalized = tmStart.replace('T', ' ');
  return parseLocalDateTime(normalized);
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
