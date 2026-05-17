import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * LIMA (Living Media Art) — pure-HTTP scraper.
 *
 * Gatsby-static site. Per event-type heeft LIMA een listing-page:
 *   /events/talk · /events/exhibition · /events/screening
 *   /events/symposium · /events/workshop
 *
 * Per tile: `<a href="/article/{slug}">` met daarbinnen een `<div>` met
 * `DD-MM-YYYY` + een titel-div. Voor description + image fetchen we
 * `/article/{slug}` voor og:description + og:image.
 *
 * Geen tijd in de bron — default 19:00.
 *
 * Idempotent: `evt-lima-{slug}`, `occ-lima-{slug}`.
 *
 * TODO(lezing-gate): venueCategory default = 'Kunst' (media-art symposia
 * etc passen onder Kunst — geen Lezing/Literatuur). Wanneer Lezing
 * actief wordt zou een mix kunnen — laat enrich beslissen.
 */

const VENUE_ID = 'aa-lima';
const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const TYPES = ['talk', 'exhibition', 'screening', 'symposium', 'workshop'];

const DEFAULT_HOUR = 19;
const DEFAULT_MINUTE = 0;

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

type Tile = {
  slug: string;
  url: string;
  title: string;
  day: number;
  month: number;
  year: number;
};

/** Parseert een listing-page: voor elke `<a href="/article/{slug}">…</a>`
 *  zoek het DD-MM-YYYY-blok en de title-div ernaast. */
function parseListing(html: string): Tile[] {
  const out: Tile[] = [];
  const seen = new Set<string>();

  // Per article-link: pak het hele blok tot de afsluitende </a>
  const linkRe = /<a\s+href="(\/article\/([^"]+))"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const slug = m[2];
    if (seen.has(slug)) continue;

    const inner = m[3];
    // DD-MM-YYYY ergens in de tile
    const dateMatch = inner.match(/(\d{2})-(\d{2})-(\d{4})/);
    if (!dateMatch) continue;
    const day = parseInt(dateMatch[1], 10);
    const month = parseInt(dateMatch[2], 10) - 1;
    const year = parseInt(dateMatch[3], 10);

    // Title: pak de eerste niet-lege div-text die geen DD-MM-YYYY pattern is.
    // Strategy: alle textContent-bits → eerste die alfabetische chars heeft
    // en NIET de datum-string is.
    const texts = [...inner.matchAll(/>([^<]+)</g)]
      .map((t) => decode(t[1]).trim())
      .filter((t) => t && !/^\d{2}-\d{2}-\d{4}$/.test(t) && t.length > 3);
    const title = texts.find((t) => /[a-z]/i.test(t)) ?? '';
    if (!title) continue;

    seen.add(slug);
    out.push({
      slug,
      url: `https://li-ma.nl${m[1]}`,
      title,
      day, month, year,
    });
  }
  return out;
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
    return await uploadToBunny(`media/events/lima-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[lima] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type LimaResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeLima(options?: {
  venueIds?: string[];
}): Promise<LimaResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: LimaResult = {
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

  // Verzamel tiles over alle 5 type-pages, dedupe op slug.
  const tilesBySlug = new Map<string, Tile>();
  for (const type of TYPES) {
    const url = `https://li-ma.nl/events/${type}`;
    const html = await fetchHtml(url);
    if (!html) {
      result.errors.push(`${type}: listing niet bereikbaar`);
      continue;
    }
    for (const t of parseListing(html)) {
      if (!tilesBySlug.has(t.slug)) tilesBySlug.set(t.slug, t);
    }
  }
  result.fetched = tilesBySlug.size;

  const venueCategory = venue.categories?.[0] ?? 'Kunst';
  const now = new Date();
  const pastCutoff = now.getTime() - 24 * 60 * 60_000;

  for (const tile of tilesBySlug.values()) {
    try {
      const startsAt = shiftToLocalTime(
        tile.year, tile.month, tile.day, DEFAULT_HOUR, DEFAULT_MINUTE
      );
      if (startsAt.getTime() < pastCutoff) {
        result.skipped++;
        continue;
      }

      const eventId = `evt-lima-${tile.slug}`;
      const occurrenceId = `occ-lima-${tile.slug}`;
      const ticketUrl = tile.url;

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

      // Detail-page voor description + image
      const detailHtml = await fetchHtml(tile.url);
      let description: string | null = null;
      let sourceImage: string | null = null;
      if (detailHtml) {
        const descMatch = detailHtml.match(
          /<meta[^>]+(?:property|name)="og:description"[^>]+content="([^"]+)"/
        );
        if (descMatch) description = decode(descMatch[1]).slice(0, 800);
        const imgMatch = detailHtml.match(
          /<meta[^>]+(?:property|name)="og:image"[^>]+content="([^"]+)"/
        );
        if (imgMatch) sourceImage = decode(imgMatch[1]);
      }

      const enriched = await enrichEvent({
        title: tile.title,
        description: description || null,
        venueName: venue.name,
        venueCategory,
      });

      let imageUrl: string | null = null;
      if (sourceImage) {
        imageUrl = (await mirrorImage(sourceImage, tile.slug)) ?? sourceImage;
      }

      const refinedKind = refineKindByDuration('show', startsAt, null);

      await db.transaction(async (tx) => {
        await tx.insert(schema.events).values({
          id: eventId, venueId: venue.id, title: tile.title,
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
      result.errors.push(`${tile.slug}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
