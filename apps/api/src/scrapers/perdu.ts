import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Perdu — WordPress + custom post type `events`.
 *
 * REST: `/wp-json/wp/v2/events?per_page=100&_embed=wp:featuredmedia`.
 * Site is meertalig (NL + EN). NL- en EN-versies hebben dezelfde slug
 * maar verschillende `link` URLs (`/agenda/` vs `/en/agenda/`).
 * Filter op de NL-versie.
 *
 * Datum + tijd staan NIET in REST. Op detail-page:
 *   "16 mei om 14:00 | Zaal open: 13.30 | Entree: gratis"
 *
 * Year inferentie via post.date_gmt.
 *
 * Idempotent: `evt-perdu-{slug}`, `occ-perdu-{slug}`.
 *
 * TODO(lezing-gate): venueCategory default = 'Literatuur' (Perdu's
 * traditionele bucket). Lezing past niet — Perdu is literair, niet
 * debat-podium.
 */

const VENUE_ID = 'perdu';
const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const REST_BASE =
  'https://perdu.nl/wp-json/wp/v2/events?per_page=100&_embed=wp:featuredmedia';

const NL_MONTHS: Record<string, number> = {
  januari: 0, februari: 1, maart: 2, april: 3, mei: 4, juni: 5,
  juli: 6, augustus: 7, september: 8, oktober: 9, november: 10, december: 11,
  jan: 0, feb: 1, mrt: 2, maa: 2, apr: 3, jun: 5, jul: 6, aug: 7,
  sep: 8, sept: 8, okt: 9, nov: 10, dec: 11,
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

/** Parse uit detail-text: "16 mei om 14:00" of "vrijdag 16 mei 2026 om 20.00". */
function parseDateTime(
  text: string
): { day: number; month: number; hour: number; minute: number } | null {
  // Pattern: optional DOW + dd + maand + optional year + "om" + HH:MM
  const m = text.match(
    /(?:[a-z]{2,9}\s+)?(\d{1,2})\s+([a-zé]+)(?:\s+(\d{4}))?\s+om\s+(\d{1,2})[.:](\d{2})/i
  );
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = NL_MONTHS[m[2].toLowerCase()];
  if (month === undefined) return null;
  const hour = parseInt(m[4], 10);
  const minute = parseInt(m[5], 10);
  return { day, month, hour, minute };
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
    return await uploadToBunny(`media/events/perdu-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[perdu] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type PerduResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapePerdu(options?: {
  venueIds?: string[];
}): Promise<PerduResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: PerduResult = {
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

  // Pagineren — Perdu heeft 646 events (NL + EN gecombineerd).
  const posts: WpEvent[] = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await fetchJson<WpEvent[]>(`${REST_BASE}&page=${page}`);
    if (!batch || batch.length === 0) break;
    posts.push(...batch);
    if (batch.length < 100) break;
  }
  if (posts.length === 0) {
    result.errors.push('WP REST API leverde geen posts');
    return [result];
  }

  // Filter NL-versies (link bevat `/agenda/` zonder `/en/`).
  const nlPosts = posts.filter((p) => p.link.includes('/agenda/') && !p.link.includes('/en/'));
  result.fetched = nlPosts.length;

  const venueCategory = venue.categories?.[0] ?? 'Literatuur';
  const now = new Date();
  const pastCutoff = now.getTime() - 24 * 60 * 60_000;
  const seen = new Set<string>();

  for (const p of nlPosts) {
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
      // Strip scripts/styles + tags
      const cleanText = stripTags(detailHtml.replace(/<(?:script|style)[^>]*>[\s\S]*?<\/(?:script|style)>/g, ''));
      const dt = parseDateTime(cleanText);
      if (!dt) {
        result.skipped++;
        continue;
      }

      // Year-anchor op publish-date
      const pub = new Date(p.date_gmt + 'Z');
      const pubYear = pub.getUTCFullYear();
      const pubMonth = pub.getUTCMonth();
      const year = dt.month < pubMonth ? pubYear + 1 : pubYear;
      const startsAt = shiftToLocalTime(year, dt.month, dt.day, dt.hour, dt.minute);
      if (startsAt.getTime() < pastCutoff) {
        result.skipped++;
        continue;
      }

      const eventId = `evt-perdu-${p.slug}`;
      const occurrenceId = `occ-perdu-${p.slug}`;
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
