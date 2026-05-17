import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * De Ceuvel — pure-HTTP scraper op `/nl/events/`.
 *
 * Server-rendered tile-listing, gegroepeerd onder month-headers:
 *
 *   <h3 class="month-title">mei</h3>
 *   <div class="row event-preview event-normal indent-N">
 *     ...DOW + day in <h3>zo 17</h3>...
 *     ...event-meta: 11:00 - 12:30...
 *     ...Locatie: De Ceuvel...
 *     ...Toegang: Free...
 *     <a href="/nl/event/{slug}/">
 *       <h3>{Title}</h3>
 *     </a>
 *     <div>{korte beschrijving}</div>
 *   </div>
 *
 * Year inferentie: huidig jaar tenzij maand < huidige maand → +1.
 *
 * Idempotent: `evt-ceuvel-{slug}`, `occ-ceuvel-{slug}`.
 *
 * TODO(lezing-gate): venueCategory = 'Literatuur' tot Lezing-aware build live.
 */

const VENUE_ID = 'aa-de-ceuvel';
const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const LISTING_URL = 'https://deceuvel.nl/nl/events/';

const NL_MONTHS: Record<string, number> = {
  januari: 0, februari: 1, maart: 2, april: 3, mei: 4, juni: 5,
  juli: 6, augustus: 7, september: 8, oktober: 9, november: 10, december: 11,
  // ook abbreviated
  jan: 0, feb: 1, mrt: 2, maa: 2, apr: 3, jun: 5, jul: 6, aug: 7,
  sep: 8, sept: 8, okt: 9, nov: 10, dec: 11,
};

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
  description: string | null;
  day: number;
  month: number;
  startHour: number;
  startMinute: number;
  endHour: number | null;
  endMinute: number | null;
  room: string | null;
  priceNote: string | null;
};

/** Strip recurring-suffix om dezelfde wekelijkse/maandelijkse show
 *  te groeperen. Patronen: `-DD-MM`, `-N` (volgnummer). */
function canonicalKey(slug: string): string {
  return slug
    .replace(/-\d{1,2}-\d{1,2}$/, '')
    .replace(/-\d+$/, '');
}

function parseTiles(html: string): Tile[] {
  const out: Tile[] = [];

  // Walk markers: maand-headers + tile-blokken in document-volgorde.
  // We splitsen op `<h3 class="month-title">` en per chunk parsen we
  // de tiles binnen die maand.
  const monthHeaderRe = /<h3[^>]*class="month-title"[^>]*>([\s\S]*?)<\/h3>/g;
  const headers: Array<{ index: number; month: number }> = [];
  let mh: RegExpExecArray | null;
  while ((mh = monthHeaderRe.exec(html)) !== null) {
    const monthName = stripTags(mh[1]).toLowerCase();
    const m = NL_MONTHS[monthName] ?? NL_MONTHS[monthName.slice(0, 3)];
    if (m === undefined) continue;
    headers.push({ index: mh.index, month: m });
  }
  if (headers.length === 0) return out;

  // Voor elke maand: pak chunk tot volgende maand-header
  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].index;
    const end = i + 1 < headers.length ? headers[i + 1].index : html.length;
    const chunk = html.slice(start, end);
    const month = headers[i].month;

    // Per tile: `<div class="row event-preview …">…tile content…</div>`
    // Tile loopt tot volgende `<div class="row event-preview` of einde chunk.
    const tileRe =
      /<div class="row event-preview[^"]*"[^>]*>([\s\S]*?)(?=<div class="row event-preview|<h3[^>]*class="month-title"|<footer|<\/body)/g;
    let tm: RegExpExecArray | null;
    while ((tm = tileRe.exec(chunk)) !== null) {
      const block = tm[1];
      const tile = parseTileBlock(block, month);
      if (tile) out.push(tile);
    }
  }
  return out;
}

function parseTileBlock(block: string, month: number): Tile | null {
  // Slug + URL
  const linkMatch = block.match(/href="(https?:\/\/deceuvel\.nl\/nl\/event\/([^"\/]+)\/?)"/);
  if (!linkMatch) return null;
  const url = linkMatch[1];
  const slug = linkMatch[2];

  // Dag uit de event-date H3 (DOW dd)
  const dayMatch = block.match(/<h3[^>]*>\s*[a-z]{2}\s+(\d{1,2})\s*<\/h3>/i);
  if (!dayMatch) return null;
  const day = parseInt(dayMatch[1], 10);

  // Tijd-range "HH:MM - HH:MM"
  const timeMatch = block.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
  const startHour = timeMatch ? parseInt(timeMatch[1], 10) : DEFAULT_HOUR;
  const startMinute = timeMatch ? parseInt(timeMatch[2], 10) : DEFAULT_MINUTE;
  const endHour = timeMatch ? parseInt(timeMatch[3], 10) : null;
  const endMinute = timeMatch ? parseInt(timeMatch[4], 10) : null;

  // Locatie + Toegang (in event-meta)
  const roomMatch = block.match(/Locatie:[\s\S]{0,30}?>([^<]+)</);
  const room = roomMatch ? decode(roomMatch[1]).trim() || null : null;
  const priceMatch = block.match(/Toegang:[\s\S]{0,30}?>([^<]+)</);
  const priceNote = priceMatch ? decode(priceMatch[1]).trim() || null : null;

  // Title: tweede h3 binnen tile (eerste is DOW+dag)
  const titleMatches = [...block.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)];
  if (titleMatches.length < 2) return null;
  const title = decode(stripTags(titleMatches[1][1]));
  if (!title) return null;

  // Description: tekst-blok dat niet meta is
  // Pak de plain text uit de event-details kolom.
  const detailsMatch = block.match(/class="[^"]*event-details[^"]*"[^>]*>([\s\S]*?)(?=<\/div>\s*<\/div>|$)/);
  let description: string | null = null;
  if (detailsMatch) {
    const txt = decode(stripTags(detailsMatch[1]));
    description = txt.length > 30 ? txt.slice(0, 800) : null;
  }

  return {
    slug, url, title, description,
    day, month,
    startHour, startMinute, endHour, endMinute,
    room, priceNote,
  };
}

async function fetchDetailImage(url: string): Promise<string | null> {
  const html = await fetchHtml(url);
  if (!html) return null;
  const m = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/);
  if (!m) return null;
  return decode(m[1]);
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
    return await uploadToBunny(`media/events/ceuvel-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[ceuvel] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type DeCeuvelResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeDeCeuvel(options?: {
  venueIds?: string[];
}): Promise<DeCeuvelResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: DeCeuvelResult = {
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

  // TODO(lezing-gate)
  const venueCategory = venue.categories?.[0] ?? 'Literatuur';
  const now = new Date();
  const nowYear = now.getFullYear();
  const nowMonth = now.getMonth();
  const pastCutoff = now.getTime() - 24 * 60 * 60_000;

  // Groepeer tiles per canonical-key zodat recurring events 1 event-row
  // + N occurrence-rows krijgen (yoga-with-kasha-05-05/-11-05/-11-06 →
  // canonical `yoga-with-kasha`).
  const groups = new Map<string, Tile[]>();
  for (const tile of tiles) {
    const key = canonicalKey(tile.slug);
    const arr = groups.get(key) ?? [];
    arr.push(tile);
    groups.set(key, arr);
  }

  for (const [canonical, items] of groups) {
    // Bouw alle valid occurrences (filter past).
    const occurrences: Array<{
      tile: Tile;
      startsAt: Date;
      endsAt: Date | null;
    }> = [];
    for (const tile of items) {
      const year = tile.month < nowMonth ? nowYear + 1 : nowYear;
      const startsAt = shiftToLocalTime(
        year, tile.month, tile.day,
        tile.startHour, tile.startMinute
      );
      if (startsAt.getTime() < pastCutoff) continue;
      const endsAt = tile.endHour !== null && tile.endMinute !== null
        ? shiftToLocalTime(year, tile.month, tile.day, tile.endHour, tile.endMinute)
        : null;
      occurrences.push({ tile, startsAt, endsAt });
    }
    if (occurrences.length === 0) {
      result.skipped += items.length;
      continue;
    }

    // Meta-bron: gebruik de earliest occurrence (komt eerst, meeste recent
    // gedocumenteerde versie van title/description).
    const meta = occurrences.reduce((a, b) =>
      a.startsAt < b.startsAt ? a : b
    );

    const eventId = `evt-ceuvel-${canonical}`;
    const [existing] = await db
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(eq(schema.events.id, eventId))
      .limit(1);

    try {
      if (!existing) {
        const enriched = await enrichEvent({
          title: meta.tile.title,
          description: meta.tile.description || null,
          venueName: venue.name,
          venueCategory,
        });

        const sourceImage = await fetchDetailImage(meta.tile.url);
        let imageUrl: string | null = null;
        if (sourceImage) {
          imageUrl = (await mirrorImage(sourceImage, canonical)) ?? sourceImage;
        }

        const refinedKind = refineKindByDuration('show', meta.startsAt, meta.endsAt);

        await db.insert(schema.events).values({
          id: eventId, venueId: venue.id, title: meta.tile.title,
          description: enriched.cleanedDescription ?? meta.tile.description ?? null,
          kind: refinedKind, imageUrl,
          category: enriched.category ?? venueCategory,
          featured: false, genres: enriched.genres, published: true,
        });
        result.inserted++;

        for (const occ of occurrences) {
          const isoDate = occ.startsAt.toISOString().slice(0, 10);
          const occurrenceId = `occ-ceuvel-${canonical}-${isoDate}`;
          await db
            .insert(schema.occurrences)
            .values({
              id: occurrenceId, eventId,
              startsAt: occ.startsAt, endsAt: occ.endsAt,
              priceCents: null,
              priceNote: occ.tile.priceNote ?? enriched.priceNote,
              ticketUrl: occ.tile.url,
              room: occ.tile.room ?? enriched.room,
              lineup: enriched.lineup, status: 'scheduled',
            })
            .onConflictDoUpdate({
              target: schema.occurrences.id,
              set: {
                startsAt: occ.startsAt, endsAt: occ.endsAt,
                ticketUrl: occ.tile.url,
                priceNote: occ.tile.priceNote, room: occ.tile.room,
              },
            });
          result.occurrencesUpserted++;
        }
      } else {
        // Event bestaat al: upsert alleen occurrences
        for (const occ of occurrences) {
          const isoDate = occ.startsAt.toISOString().slice(0, 10);
          const occurrenceId = `occ-ceuvel-${canonical}-${isoDate}`;
          await db
            .insert(schema.occurrences)
            .values({
              id: occurrenceId, eventId,
              startsAt: occ.startsAt, endsAt: occ.endsAt,
              priceCents: null, priceNote: occ.tile.priceNote,
              ticketUrl: occ.tile.url,
              room: occ.tile.room, lineup: null, status: 'scheduled',
            })
            .onConflictDoUpdate({
              target: schema.occurrences.id,
              set: {
                startsAt: occ.startsAt, endsAt: occ.endsAt,
                ticketUrl: occ.tile.url,
                priceNote: occ.tile.priceNote, room: occ.tile.room,
              },
            });
          result.occurrencesUpserted++;
        }
      }
    } catch (e) {
      result.errors.push(`${canonical}: ${(e as Error).message}`);
      result.skipped += occurrences.length;
    }
  }

  return [result];
}
