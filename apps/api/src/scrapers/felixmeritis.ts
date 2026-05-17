import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Felix Meritis — WordPress + custom post type `vo-event`.
 *
 * REST: `/wp-json/wp/v2/vo-event?per_page=100&_embed=wp:featuredmedia`
 *
 * Datum + tijd staan NIET in de REST-response. Op de detail-pagina
 * staat:
 *   <div class="event__date">vr 19 jun</div>     ← DOW + dag + Dutch
 *                                                  maand-abbrev, geen jaar
 *   <div class="event__label">Tijd</div>
 *   <div class="event__info">20.00</div>         ← starttijd
 *
 * Jaar-inferentie via `post.date_gmt`: een post gepubliceerd in
 * 2026 met "19 jun" hoort bij 2026 (tenzij maand < publicatie-maand,
 * dan +1 jaar).
 *
 * Default tijd: 20:00 als event__info parse-bar faalt.
 *
 * Idempotent: `evt-felix-{slug}`, `occ-felix-{slug}`.
 *
 * TODO(lezing-gate): venueCategory default = 'Literatuur' tot de
 * nieuwe native build live is; daarna terug naar 'Lezing'.
 */

const VENUE_ID = 'felix-meritis';
const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const REST_BASE =
  'https://felixmeritis.nl/wp-json/wp/v2/vo-event?per_page=100&_embed=wp:featuredmedia';

const NL_MONTHS_ABBREV: Record<string, number> = {
  jan: 0, feb: 1, mrt: 2, maa: 2, apr: 3, mei: 4,
  jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, okt: 9, nov: 10, dec: 11,
};

const DEFAULT_HOUR = 20;
const DEFAULT_MINUTE = 0;

type WpEvent = {
  id: number;
  slug: string;
  link: string;
  date_gmt: string;
  title: { rendered: string };
  content?: { rendered: string };
  _embedded?: {
    'wp:featuredmedia'?: Array<{ source_url?: string }>;
  };
};

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

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
    .replace(/&#8211;/g, '–').replace(/&#8212;/g, '—')
    .replace(/&#8216;/g, '‘').replace(/&#8217;/g, '’').replace(/&nbsp;/g, ' ');
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function shiftToLocalTime(
  y: number, mo: number, d: number, h: number, mi: number
): Date {
  const tentative = new Date(Date.UTC(y, mo, d, h, mi, 0));
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Amsterdam',
    timeZoneName: 'longOffset',
  });
  const off = dtf.formatToParts(tentative).find((p) => p.type === 'timeZoneName')?.value;
  const m = off?.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  const sign = m && m[1] === '+' ? 1 : -1;
  const oh = m ? parseInt(m[2], 10) : 0;
  const om = m ? parseInt(m[3] ?? '0', 10) : 0;
  return new Date(tentative.getTime() - sign * (oh * 60 + om) * 60_000);
}

/** Parse "vr 19 jun" → { day: 19, month: 5 }. DOW-prefix mag elke 2-3
 *  letter NL-abbreviatie zijn (ma, di, wo, do, vr, za, zo). */
function parseDateMarker(s: string): { day: number; month: number } | null {
  const m = s.toLowerCase().trim().match(/^[a-z]{2,3}\s+(\d{1,2})\s+([a-zé]+)/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const monthKey = m[2].slice(0, 4); // 'jun', 'sept' etc.
  // probeer 4-, 3-, 2-letter keys
  for (const key of [monthKey, monthKey.slice(0, 3), monthKey.slice(0, 2)]) {
    if (key in NL_MONTHS_ABBREV) {
      return { day, month: NL_MONTHS_ABBREV[key] };
    }
  }
  return null;
}

function extractDateAndTime(
  html: string
): { day: number; month: number; hour: number; minute: number } | null {
  const dateMatch = html.match(/class="event__date"[^>]*>([\s\S]*?)</);
  if (!dateMatch) return null;
  const parsed = parseDateMarker(decode(stripTags(dateMatch[1])));
  if (!parsed) return null;

  // Tijd: zoek <div class="event__label">Tijd</div> ... <div class="event__info">20.00</div>
  let hour = DEFAULT_HOUR;
  let minute = DEFAULT_MINUTE;
  const timeMatch = html.match(
    /class="event__label"[^>]*>\s*Tijd\s*<\/div>[\s\S]{0,200}?class="event__info"[^>]*>([\s\S]*?)</
  );
  if (timeMatch) {
    const t = stripTags(timeMatch[1]).match(/(\d{1,2})[.:](\d{2})/);
    if (t) {
      hour = parseInt(t[1], 10);
      minute = parseInt(t[2], 10);
    }
  }
  return { day: parsed.day, month: parsed.month, hour, minute };
}

async function mirrorImage(
  sourceUrl: string, slug: string
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
    return await uploadToBunny(`media/events/felix-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[felix] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type FelixMeritisResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeFelixMeritis(options?: {
  venueIds?: string[];
}): Promise<FelixMeritisResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: FelixMeritisResult = {
    venueId: VENUE_ID, fetched: 0, inserted: 0,
    occurrencesUpserted: 0, skipped: 0, errors: [],
  };

  const [venue] = await db
    .select().from(schema.venues)
    .where(eq(schema.venues.id, VENUE_ID));
  if (!venue) {
    result.errors.push('venue niet in DB');
    return [result];
  }

  // Pagineren: WP REST `vo-event` heeft 324+ entries; default per_page=100.
  const posts: WpEvent[] = [];
  for (let page = 1; page <= 10; page++) {
    const url = `${REST_BASE}&page=${page}`;
    const batch = await fetchJson<WpEvent[]>(url);
    if (!batch || batch.length === 0) break;
    posts.push(...batch);
    if (batch.length < 100) break;
  }
  if (posts.length === 0) {
    result.errors.push('WP REST API leverde geen posts');
    return [result];
  }
  result.fetched = posts.length;

  // TODO(lezing-gate): naar 'Lezing' wanneer de oude TestFlight bundle
  // verdrongen is door de Lezing-aware native build.
  const venueCategory = venue.categories?.[0] ?? 'Literatuur';
  const now = new Date();
  const pastCutoff = now.getTime() - 24 * 60 * 60_000;
  const seen = new Set<string>();

  for (const p of posts) {
    try {
      if (seen.has(p.slug)) continue;
      seen.add(p.slug);

      const title = decode(stripTags(p.title.rendered));
      if (!title) {
        result.skipped++;
        continue;
      }

      const detailHtml = await fetchHtml(p.link);
      if (!detailHtml) {
        result.skipped++;
        result.errors.push(`${p.slug}: detail niet bereikbaar`);
        continue;
      }
      const dt = extractDateAndTime(detailHtml);
      if (!dt) {
        result.skipped++;
        continue;
      }

      const pub = new Date(p.date_gmt + 'Z');
      const pubYear = pub.getUTCFullYear();
      const pubMonth = pub.getUTCMonth();
      const year = dt.month < pubMonth ? pubYear + 1 : pubYear;
      const startsAt = shiftToLocalTime(year, dt.month, dt.day, dt.hour, dt.minute);
      if (startsAt.getTime() < pastCutoff) {
        result.skipped++;
        continue;
      }

      const eventId = `evt-felix-${p.slug}`;
      const occurrenceId = `occ-felix-${p.slug}`;
      const ticketUrl = p.link;

      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      if (existing) {
        await db
          .insert(schema.occurrences)
          .values({
            id: occurrenceId, eventId, startsAt, endsAt: null,
            priceCents: null, priceNote: null, ticketUrl,
            room: null, lineup: null, status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: { startsAt, ticketUrl },
          });
        result.occurrencesUpserted++;
        continue;
      }

      let description = decode(stripTags(p.content?.rendered ?? ''))
        .replace(/\s+/g, ' ').trim().slice(0, 800);
      if (!description) description = null as unknown as string;

      const enriched = await enrichEvent({
        title,
        description: description || null,
        venueName: venue.name,
        venueCategory,
      });

      const sourceImage =
        p._embedded?.['wp:featuredmedia']?.[0]?.source_url ?? null;
      let imageUrl: string | null = null;
      if (sourceImage) {
        imageUrl = (await mirrorImage(sourceImage, p.slug)) ?? sourceImage;
      }

      const refinedKind = refineKindByDuration('show', startsAt, null);

      await db.transaction(async (tx) => {
        await tx.insert(schema.events).values({
          id: eventId, venueId: venue.id, title,
          description: enriched.cleanedDescription ?? description ?? null,
          kind: refinedKind, imageUrl,
          category: enriched.category ?? venueCategory,
          featured: false, genres: enriched.genres, published: true,
        });
        result.inserted++;

        await tx
          .insert(schema.occurrences)
          .values({
            id: occurrenceId, eventId, startsAt, endsAt: null,
            priceCents: null, priceNote: enriched.priceNote,
            ticketUrl, room: enriched.room, lineup: enriched.lineup,
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: {
              startsAt, ticketUrl,
              priceNote: enriched.priceNote, room: enriched.room,
              lineup: enriched.lineup,
            },
          });
        result.occurrencesUpserted++;
      });
    } catch (e) {
      result.errors.push(`${p.slug}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
