import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';
import { loadVenueTitleMap, resolveEventId } from './_title-dedup.js';

/**
 * Pakhuis de Zwijger — pure-HTTP scraper.
 *
 * Custom site (frontend ≠ WordPress; admin.dezwijger.nl is wel een WP
 * achter auth — geen REST publiek). Alles wat nodig is staat
 * server-rendered op `/agenda?page=N`:
 *
 *   <div class="program teaser">
 *     <a href="/programma/{slug}">...</a>
 *     <picture>… srcset met images.intuitive.nl/.../admin.dezwijger.nl/wp-content/uploads/… …</picture>
 *     <div class="details">
 *       <div class="suptitle">…</div>
 *       <div class="title truncate">…</div>
 *       <div class="subtitle truncate">…</div>
 *       <div class="meta">
 *         <div class="date-time">Morgen, 19.30</div>  ← of "wo 20 mei, 08.30"
 *         <div class="location">Studio PDZ</div>
 *         <div class="entrance">gratis</div>
 *       </div>
 *     </div>
 *     <a class="button reservation-button" href="https://tickets.dezwijger.nl/…">Reserveer</a>
 *   </div>
 *
 * Pagineren tot tile-count 0. ~20 tiles per pagina.
 *
 * Idempotent: event-id = `evt-dz-{slug}`, occurrence-id = `occ-dz-{slug}`.
 */

const VENUE_ID = 'pakhuis-de-zwijger';
const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const BASE = 'https://dezwijger.nl';

const NL_MONTHS: Record<string, number> = {
  jan: 0, januari: 0,
  feb: 1, februari: 1,
  mrt: 2, maart: 2,
  apr: 3, april: 3,
  mei: 4,
  jun: 5, juni: 5,
  jul: 6, juli: 6,
  aug: 7, augustus: 7,
  sep: 8, sept: 8, september: 8,
  okt: 9, oktober: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

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

/** Parse "Morgen, 19.30" / "Vandaag, 20.00" / "wo 20 mei, 08.30" / "do 5 juni 2027, 20.00". */
function parseDateTime(s: string, now: Date): Date | null {
  const cleaned = s.trim().toLowerCase();
  const timeMatch = cleaned.match(/(\d{1,2})[.:](\d{2})/);
  if (!timeMatch) return null;
  const hour = parseInt(timeMatch[1], 10);
  const minute = parseInt(timeMatch[2], 10);

  let target: Date;
  if (/^vandaag/.test(cleaned)) {
    target = new Date(now);
  } else if (/^morgen/.test(cleaned)) {
    target = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  } else {
    // "wo 20 mei, 08.30" of "do 5 juni 2027, 20.00"
    const m = cleaned.match(/^[a-z]{2,3}\s+(\d{1,2})\s+([a-zé]+)(?:\s+(\d{4}))?/);
    if (!m) return null;
    const day = parseInt(m[1], 10);
    const month = NL_MONTHS[m[2]];
    if (month === undefined) return null;
    const explicitYear = m[3] ? parseInt(m[3], 10) : null;
    const nowYear = now.getFullYear();
    const nowMonth = now.getMonth();
    const year = explicitYear ?? (month < nowMonth ? nowYear + 1 : nowYear);
    return shiftToLocalTime(year, month, day, hour, minute);
  }
  return shiftToLocalTime(
    target.getFullYear(),
    target.getMonth(),
    target.getDate(),
    hour,
    minute
  );
}

type TileData = {
  slug: string;
  url: string;
  suptitle: string | null;
  title: string;
  subtitle: string | null;
  dateTimeRaw: string;
  startsAt: Date;
  room: string | null;
  priceNote: string | null;
  ticketUrl: string | null;
  imageSourceUrl: string | null;
};

function parseTiles(html: string, now: Date): TileData[] {
  const out: TileData[] = [];
  // Een tile loopt van `<div class="program teaser">` tot de volgende
  // tile of het einde van de listing. We pakken een ruim blok.
  const tileRe =
    /<div class="program teaser">([\s\S]*?)(?=<div class="program teaser">|<\/main>|<\/section>)/g;
  let m: RegExpExecArray | null;
  while ((m = tileRe.exec(html)) !== null) {
    const block = m[1];
    const slugMatch = block.match(/<a href="\/programma\/([^"]+)"/);
    if (!slugMatch) continue;
    const slug = slugMatch[1].replace(/\/$/, '');

    const titleMatch = block.match(/<div class="title truncate">([\s\S]*?)<\/div>/);
    if (!titleMatch) continue;
    const title = decode(stripTags(titleMatch[1]));
    if (!title) continue;

    const dtMatch = block.match(/<div class="date-time">([\s\S]*?)<\/div>/);
    if (!dtMatch) continue;
    const dateTimeRaw = decode(stripTags(dtMatch[1]));
    const startsAt = parseDateTime(dateTimeRaw, now);
    if (!startsAt) continue;

    const suptitleMatch = block.match(/<div class="suptitle"[^>]*>([\s\S]*?)<\/div>/);
    const suptitle = suptitleMatch ? decode(stripTags(suptitleMatch[1])) || null : null;

    const subtitleMatch = block.match(
      /<div[^>]*class="subtitle truncate">([\s\S]*?)<\/div>/
    );
    const subtitle = subtitleMatch ? decode(stripTags(subtitleMatch[1])) || null : null;

    const locMatch = block.match(/<div class="location">([\s\S]*?)<\/div>/);
    const room = locMatch ? decode(stripTags(locMatch[1])) || null : null;

    const entranceMatch = block.match(/<div class="entrance">([\s\S]*?)<\/div>/);
    const priceNote = entranceMatch
      ? decode(stripTags(entranceMatch[1])) || null
      : null;

    const ticketMatch = block.match(
      /<a[^>]+href="([^"]+)"[^>]*class="[^"]*reservation-button[^"]*"/
    );
    const ticketUrl = ticketMatch ? decode(ticketMatch[1]) : null;

    // Gebruik de intuitive.nl-resizer voor een redelijk-grote variant
    // van de poster (~1200×630). De originele admin.dezwijger.nl PNG
    // kan 14MB+ zijn, ruim over onze 8MB-mirror-limiet; resized PNG is
    // ~1.5MB. We pakken alleen het admin-pad en bouwen onze eigen
    // resize-URL zodat we niet afhankelijk zijn van welke srcset-variant
    // toevallig eerst in de HTML staat.
    const adminMatch = block.match(
      /https:\/\/admin\.dezwijger\.nl\/wp-content\/uploads\/[^"\s]+/
    );
    const imageSourceUrl = adminMatch
      ? `https://images.intuitive.nl/unsafe/1200x630/smart/${adminMatch[0]}`
      : null;

    out.push({
      slug,
      url: `${BASE}/programma/${slug}`,
      suptitle,
      title,
      subtitle,
      dateTimeRaw,
      startsAt,
      room,
      priceNote,
      ticketUrl,
      imageSourceUrl,
    });
  }
  return out;
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
      `media/events/dz-${slug}.${ext}`,
      buf,
      mime
    );
  } catch (e) {
    console.warn(`[dezwijger] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type DeZwijgerResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeDeZwijger(options?: {
  venueIds?: string[];
}): Promise<DeZwijgerResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: DeZwijgerResult = {
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

  const now = new Date();
  const pastCutoff = now.getTime() - 24 * 60 * 60_000;
  const venueCategory = venue.categories?.[0] ?? 'Lezing';

  // Paginate /agenda?page=1..N tot empty.
  const allTiles: TileData[] = [];
  for (let page = 1; page <= 50; page++) {
    const url = page === 1 ? `${BASE}/agenda` : `${BASE}/agenda?page=${page}`;
    const html = await fetchHtml(url);
    if (!html) {
      result.errors.push(`page ${page}: niet bereikbaar`);
      break;
    }
    const tiles = parseTiles(html, now);
    if (tiles.length === 0) break;
    allTiles.push(...tiles);
  }
  result.fetched = allTiles.length;

  // Dedup op slug (mocht een event op twee pages staan)
  const seen = new Set<string>();
  const byTitle = await loadVenueTitleMap(VENUE_ID, 'evt-dz-');

  for (const tile of allTiles) {
    if (seen.has(tile.slug)) continue;
    seen.add(tile.slug);

    if (tile.startsAt.getTime() < pastCutoff) {
      result.skipped++;
      continue;
    }

    // tile heeft titel, datum en subtitle (= description) al binnen.
    const { eventId } = resolveEventId(byTitle, tile.title, `evt-dz-${tile.slug}`, {
      startsAt: tile.startsAt,
      description: tile.subtitle ?? null,
    });
    const occurrenceId = `occ-dz-${tile.slug}`;

    const [existing] = await db
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(eq(schema.events.id, eventId))
      .limit(1);

    try {
      if (existing) {
        await db
          .insert(schema.occurrences)
          .values({
            id: occurrenceId,
            eventId,
            startsAt: tile.startsAt,
            endsAt: null,
            priceCents: null,
            priceNote: tile.priceNote,
            ticketUrl: tile.ticketUrl,
            room: tile.room,
            lineup: null,
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: {
              // eventId meenemen: occurrences die nog aan een los event
              // hingen verhuizen zo zelf naar het canonieke event.
              eventId,
              startsAt: tile.startsAt,
              ticketUrl: tile.ticketUrl,
              priceNote: tile.priceNote,
              room: tile.room,
            },
          });
        result.occurrencesUpserted++;
        continue;
      }

      const description = tile.subtitle ?? null;

      const enriched = await enrichEvent({
        title: tile.title,
        description,
        venueName: venue.name,
        venueCategory,
      });

      let imageUrl: string | null = null;
      if (tile.imageSourceUrl) {
        imageUrl = (await mirrorImage(tile.imageSourceUrl, tile.slug)) ?? null;
      }

      const refinedKind = refineKindByDuration('show', tile.startsAt, null);

      await db.transaction(async (tx) => {
        await tx.insert(schema.events).values({
          id: eventId,
          venueId: venue.id,
          title: tile.title,
          description: enriched.cleanedDescription ?? description,
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
            startsAt: tile.startsAt,
            endsAt: null,
            priceCents: null,
            priceNote: tile.priceNote ?? enriched.priceNote,
            ticketUrl: tile.ticketUrl,
            room: tile.room ?? enriched.room,
            lineup: enriched.lineup,
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: {
              // eventId meenemen: occurrences die nog aan een los event
              // hingen verhuizen zo zelf naar het canonieke event.
              eventId,
              startsAt: tile.startsAt,
              ticketUrl: tile.ticketUrl,
              priceNote: tile.priceNote,
              room: tile.room,
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
