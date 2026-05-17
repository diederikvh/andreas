import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * De Balie — pure WP REST scraper.
 *
 * Bron: `https://debalie.nl/wp-json/wp/v2/vo-programme?per_page=100`.
 *
 * Datum staat in de URL-permalink: `/programma/{slug}-DD-MM-YYYY/`.
 * Tijd komt niet door de REST API; default 20:00 (typische De Balie
 * avond — een enkel film/talkshow wijkt af, dat is admin-fixable).
 *
 * Per event:
 *  - `title.rendered` (HTML-decoded)
 *  - `link` → datum-parser
 *  - `content.rendered` als description (stripped + 800 chars cap)
 *  - `_embedded.wp:featuredmedia[0].source_url` als image → Bunny
 *  - `link` als ticketUrl
 *
 * Idempotent:
 *  - eventId      = `evt-balie-{slug}`
 *  - occurrenceId = `occ-balie-{slug}`
 *
 * Geen recurring-dedup nodig: de URL bevat de datum dus elke
 * voorstellings-instantie is z'n eigen slug. Wel dedupe op slug binnen
 * de fetch zelf (defensief).
 */

const VENUE_ID = 'de-balie';
const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const REST_URL =
  'https://debalie.nl/wp-json/wp/v2/vo-programme?per_page=100&_embed=wp:featuredmedia';

const DEFAULT_HOUR = 20;
const DEFAULT_MINUTE = 0;

type WpProgramme = {
  id: number;
  slug: string;
  link: string;
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

function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(parseInt(c, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, c) => String.fromCodePoint(parseInt(c, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&#8216;/g, '‘')
    .replace(/&#8217;/g, '’')
    .replace(/&nbsp;/g, ' ');
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function shiftToLocalTime(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number
): Date {
  const tentative = new Date(Date.UTC(y, mo, d, h, mi, 0));
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Amsterdam',
    timeZoneName: 'longOffset',
  });
  const off = dtf
    .formatToParts(tentative)
    .find((p) => p.type === 'timeZoneName')?.value;
  const m = off?.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  const sign = m && m[1] === '+' ? 1 : -1;
  const oh = m ? parseInt(m[2], 10) : 0;
  const om = m ? parseInt(m[3] ?? '0', 10) : 0;
  return new Date(tentative.getTime() - sign * (oh * 60 + om) * 60_000);
}

/** Parse `/programma/{slug}-DD-MM-YYYY/` → Date in Europe/Amsterdam at 20:00. */
function parseDateFromLink(link: string): Date | null {
  const m = link.match(/-(\d{1,2})-(\d{1,2})-(\d{4})\/?$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10) - 1;
  const year = parseInt(m[3], 10);
  if (Number.isNaN(day) || Number.isNaN(month) || Number.isNaN(year)) return null;
  return shiftToLocalTime(year, month, day, DEFAULT_HOUR, DEFAULT_MINUTE);
}

async function mirrorImage(
  sourceUrl: string,
  slug: string
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
    const ext = mime.includes('png')
      ? 'png'
      : mime.includes('webp')
        ? 'webp'
        : 'jpg';
    return await uploadToBunny(
      `media/events/balie-${slug}.${ext}`,
      buf,
      mime
    );
  } catch (e) {
    console.warn(`[debalie] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type DeBalieResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeDeBalie(options?: {
  venueIds?: string[];
}): Promise<DeBalieResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: DeBalieResult = {
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
    result.errors.push('venue niet in DB');
    return [result];
  }

  const posts = await fetchJson<WpProgramme[]>(REST_URL);
  if (!posts) {
    result.errors.push('WP REST API niet bereikbaar');
    return [result];
  }
  result.fetched = posts.length;

  const venueCategory = venue.categories?.[0] ?? 'Lezing';
  const now = new Date();
  const pastCutoff = now.getTime() - 24 * 60 * 60_000;

  const seen = new Set<string>();

  for (const p of posts) {
    try {
      const slug = p.slug;
      if (seen.has(slug)) continue;
      seen.add(slug);

      const title = decode(stripTags(p.title.rendered));
      if (!title) {
        result.skipped++;
        continue;
      }

      const startsAt = parseDateFromLink(p.link);
      if (!startsAt) {
        result.skipped++;
        result.errors.push(`${slug}: kon datum niet uit URL parsen`);
        continue;
      }
      if (startsAt.getTime() < pastCutoff) {
        result.skipped++;
        continue;
      }

      const eventId = `evt-balie-${slug}`;
      const occurrenceId = `occ-balie-${slug}`;
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
            id: occurrenceId,
            eventId,
            startsAt,
            endsAt: null,
            priceCents: null,
            priceNote: null,
            ticketUrl,
            room: null,
            lineup: null,
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: { startsAt, ticketUrl },
          });
        result.occurrencesUpserted++;
        continue;
      }

      let description = decode(stripTags(p.content?.rendered ?? ''))
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 800);
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
        imageUrl = (await mirrorImage(sourceImage, slug)) ?? sourceImage;
      }

      const refinedKind = refineKindByDuration('show', startsAt, null);

      await db.transaction(async (tx) => {
        await tx.insert(schema.events).values({
          id: eventId,
          venueId: venue.id,
          title,
          description: enriched.cleanedDescription ?? description ?? null,
          kind: refinedKind,
          imageUrl,
          category: enriched.category ?? venueCategory,
          featured: false,
          genres: enriched.genres,
          published: true,
        });
        result.inserted++;

        await tx
          .insert(schema.occurrences)
          .values({
            id: occurrenceId,
            eventId,
            startsAt,
            endsAt: null,
            priceCents: null,
            priceNote: enriched.priceNote,
            ticketUrl,
            room: enriched.room,
            lineup: enriched.lineup,
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: {
              startsAt,
              ticketUrl,
              priceNote: enriched.priceNote,
              room: enriched.room,
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
