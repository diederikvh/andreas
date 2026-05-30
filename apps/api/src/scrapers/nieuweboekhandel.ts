import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * De Nieuwe Boekhandel (Bos en Lommer) — pure-HTTP scraper.
 *
 * Bron: `https://denieuweboekhandel.nl/evenementen`. Server-rendered
 * `<article class="event-card">`-blokken met:
 *   - `<img src="…/storage/events/…">`
 *   - `<div class="event-card__badge-day">17</div>`
 *   - `<div class="event-card__badge-month">mei</div>`
 *   - `<h3 class="event-card__title">…</h3>`
 *   - `<p class="event-card__excerpt">…</p>`
 *   - `<a href="…/evenementen/{id}">` met "Meer info"
 *
 * Geen jaar in URL of badge — year inferentie via huidige maand.
 * Geen tijd in card — default 20:00.
 *
 * Idempotent: `evt-dnbh-{id}`, `occ-dnbh-{id}`.
 *
 * TODO(lezing-gate): venueCategory default = 'Literatuur'.
 */

const VENUE_ID = 'denieuweboekhandel';
const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const LISTING_URL = 'https://denieuweboekhandel.nl/evenementen';

const NL_MONTHS: Record<string, number> = {
  januari: 0, februari: 1, maart: 2, april: 3, mei: 4, juni: 5,
  juli: 6, augustus: 7, september: 8, oktober: 9, november: 10, december: 11,
  jan: 0, feb: 1, mrt: 2, maa: 2, apr: 3, jun: 5, jul: 6, aug: 7,
  sep: 8, sept: 8, okt: 9, nov: 10, dec: 11,
};

const DEFAULT_HOUR = 20;
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
  id: string;
  url: string;
  title: string;
  excerpt: string | null;
  day: number;
  month: number;
  imageSourceUrl: string | null;
};

function parseTiles(html: string): Tile[] {
  const out: Tile[] = [];
  const tileRe = /<article\s+class="event-card[\s\S]*?<\/article>/g;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = tileRe.exec(html)) !== null) {
    const block = m[0];
    const linkMatch = block.match(/href="https?:\/\/denieuweboekhandel\.nl\/evenementen\/([^"]+)"/);
    if (!linkMatch) continue;
    const id = linkMatch[1];
    if (seen.has(id)) continue;
    seen.add(id);

    const dayMatch = block.match(/class="event-card__badge-day"[^>]*>(\d{1,2})</);
    if (!dayMatch) continue;
    const day = parseInt(dayMatch[1], 10);

    const monthMatch = block.match(/class="event-card__badge-month"[^>]*>([a-zé]+)</i);
    if (!monthMatch) continue;
    const month = NL_MONTHS[monthMatch[1].toLowerCase()];
    if (month === undefined) continue;

    const titleMatch = block.match(/class="event-card__title"[^>]*>([\s\S]*?)<\/h3>/);
    if (!titleMatch) continue;
    const title = decode(stripTags(titleMatch[1]));
    if (!title) continue;

    const excerptMatch = block.match(/class="event-card__excerpt"[^>]*>([\s\S]*?)<\/p>/);
    const excerpt = excerptMatch ? decode(stripTags(excerptMatch[1])) || null : null;

    const imgMatch = block.match(/<img[^>]+src="(https?:\/\/denieuweboekhandel\.nl\/storage\/events\/[^"]+)"/);
    const imageSourceUrl = imgMatch ? imgMatch[1] : null;

    out.push({
      id,
      url: `https://denieuweboekhandel.nl/evenementen/${id}`,
      title, excerpt, day, month, imageSourceUrl,
    });
  }
  return out;
}

async function mirrorImage(
  sourceUrl: string, id: string
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
    return await uploadToBunny(`media/events/dnbh-${id}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[nieuweboekhandel] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type NieuweBoekhandelResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeNieuweBoekhandel(options?: {
  venueIds?: string[];
}): Promise<NieuweBoekhandelResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: NieuweBoekhandelResult = {
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

  const html = await fetchHtml(LISTING_URL);
  if (!html) {
    result.errors.push('listing-page niet bereikbaar');
    return [result];
  }
  const tiles = parseTiles(html);
  result.fetched = tiles.length;

  const venueCategory = venue.categories?.[0] ?? 'Literatuur';
  const now = new Date();
  const nowYear = now.getFullYear();
  const nowMonth = now.getMonth();
  const pastCutoff = now.getTime() - 24 * 60 * 60_000;

  for (const tile of tiles) {
    try {
      const year = tile.month < nowMonth ? nowYear + 1 : nowYear;
      // Detail-page heeft "Hoe laat? → HH:MM - HH:MM". Listing geeft
      // alleen datum; default 20:00 was fout voor middag-events (15:00).
      const detailHtml = await fetchHtml(tile.url);
      let hour = DEFAULT_HOUR;
      let minute = DEFAULT_MINUTE;
      if (detailHtml) {
        const tm = detailHtml.match(
          /Hoe\s+laat\?[\s\S]{0,200}?(\d{1,2})[:.](\d{2})/,
        );
        if (tm) {
          hour = parseInt(tm[1], 10);
          minute = parseInt(tm[2], 10);
        }
      }
      const startsAt = shiftToLocalTime(
        year, tile.month, tile.day, hour, minute,
      );
      if (startsAt.getTime() < pastCutoff) {
        result.skipped++;
        continue;
      }

      const eventId = `evt-dnbh-${tile.id}`;
      const occurrenceId = `occ-dnbh-${tile.id}`;
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

      const enriched = await enrichEvent({
        title: tile.title,
        description: tile.excerpt,
        venueName: venue.name,
        venueCategory,
      });

      let imageUrl: string | null = null;
      if (tile.imageSourceUrl) {
        imageUrl = (await mirrorImage(tile.imageSourceUrl, tile.id)) ?? tile.imageSourceUrl;
      }

      const refinedKind = refineKindByDuration('show', startsAt, null);

      await db.transaction(async (tx) => {
        await tx.insert(schema.events).values({
          id: eventId, venueId: venue.id, title: tile.title,
          description: enriched.cleanedDescription ?? tile.excerpt,
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
      result.errors.push(`${tile.id}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
