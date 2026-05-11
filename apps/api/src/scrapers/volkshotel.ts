import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Scraper voor Volkshotel-agenda's (Canvas / Doka / Werkplaats / etc.).
 * Per venue config:
 *   `scraperConfig.volkshotel = { roomPath: 'canvas' }`
 * → fetches `https://www.volkshotel.nl/en/agenda/{roomPath}/` (Listing-
 *   page) en per tile een detail-page voor de beschrijving.
 *
 * Geen JSON-LD; alles via DOM. Datum komt zonder jaar
 * ("Fri, 15 May"); jaar wordt afgeleid uit de eerstvolgende kalender-
 * dag die matcht.
 *
 * Idempotency:
 *  - eventId      = `evt-{venueId}-{slug}` (slug uit detail-URL)
 *  - occurrenceId = `occ-{venueId}-{slug}`
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36';
const BASE = 'https://www.volkshotel.nl';

type RawTile = {
  url: string;
  slug: string;
  title: string;
  imageUrl: string | null;
  dateText: string | null; // "Fri, 15 May"
  timeText: string | null; // "20:00 - end" / "23:59 - 06:00"
  priceText: string | null; // "Free" / "€10" / ""
};

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/** Parse "Fri, 15 May" → next future occurrence of (day, month). Geen
 *  jaar in de listing-data; inferred door eerstkomende match te pakken. */
function buildStartDate(
  dateText: string,
  timeText: string | null,
  now = new Date(),
): Date | null {
  const m = dateText.match(/(\d{1,2})\s+([A-Za-z]+)/);
  if (!m) return null;
  const day = Number(m[1]);
  const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (mon === undefined) return null;

  // Pak de eerste startTime; default 20:00 als geen time.
  let hh = 20;
  let mm = 0;
  if (timeText) {
    const tm = timeText.match(/(\d{1,2}):(\d{2})/);
    if (tm) {
      hh = Number(tm[1]);
      mm = Number(tm[2]);
    }
  }

  // Probeer huidige jaar; als de date al gepasseerd is meer dan 7 dagen
  // geleden, +1 jaar.
  let year = now.getUTCFullYear();
  // Bouw als Amsterdam-lokaal (+02:00 CEST) → UTC.
  const tryBuild = (y: number) =>
    new Date(
      `${y}-${String(mon + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+02:00`,
    );
  let d = tryBuild(year);
  if (
    !isNaN(d.getTime()) &&
    d.getTime() < now.getTime() - 7 * 24 * 60 * 60 * 1000
  ) {
    d = tryBuild(year + 1);
  }
  return isNaN(d.getTime()) ? null : d;
}

/** End-time uit "20:00 - 02:00" of "20:00 - end" (→ start +6h fallback). */
function buildEndDate(start: Date, timeText: string | null): Date {
  if (!timeText) return new Date(start.getTime() + 4 * 60 * 60 * 1000);
  const m = timeText.match(/-\s*(\d{1,2}):(\d{2})/);
  if (!m) return new Date(start.getTime() + 6 * 60 * 60 * 1000);
  const eh = Number(m[1]);
  const em = Number(m[2]);
  const end = new Date(start);
  end.setUTCHours(end.getUTCHours()); // no-op anchor
  // Bouw als Amsterdam-lokaal van dezelfde of volgende dag.
  const endLocal = new Date(start.getTime());
  // Trekken we uit de start een Amsterdam-tijd? makkelijker: +02:00 ISO.
  const startLocalY = start.getUTCFullYear();
  const startLocalM = start.getUTCMonth() + 1;
  const startLocalD = start.getUTCDate();
  // Bouw end als dezelfde dag; if eh < startHour → next day.
  const startHour = start.getUTCHours();
  let dayOffset = 0;
  if (eh + 2 < startHour) dayOffset = 1; // crude rollover
  const target = new Date(
    `${startLocalY}-${String(startLocalM).padStart(2, '0')}-${String(startLocalD + dayOffset).padStart(2, '0')}T${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}:00+02:00`,
  );
  if (isNaN(target.getTime()) || target.getTime() <= start.getTime()) {
    return new Date(start.getTime() + 6 * 60 * 60 * 1000);
  }
  return target;
  void endLocal;
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchListing(roomPath: string): Promise<RawTile[]> {
  const url = `${BASE}/en/agenda/${roomPath}/`;
  const r = await fetch(url, { headers: { 'user-agent': UA } });
  if (!r.ok) return [];
  const html = await r.text();
  const tiles: RawTile[] = [];

  // Match elke kaart-link en z'n inhoud tot </a>.
  const cardRe =
    /<a class="card agenda  buzz-hover" href="(?<href>[^"]+)"(?<inner>[\s\S]*?)<\/a>/g;
  for (const m of html.matchAll(cardRe)) {
    const href = m.groups!.href;
    const inner = m.groups!.inner;
    const slugMatch = href.match(/\/agenda\/[^/]+\/([^/?#]+)\/?$/);
    if (!slugMatch) continue;
    const slug = slugMatch[1];

    const title = (() => {
      const tm = inner.match(/<h2 class="buzz">([\s\S]*?)<\/h2>/);
      return tm ? stripHtml(tm[1]) : '';
    })();
    if (!title) continue;

    const imageUrl = (() => {
      const im = inner.match(
        /<div class="bg" style="background-image:\s*url\(([^)]+)\)/,
      );
      if (!im) return null;
      // Strip size-suffix `-300x225` zodat we de originele krijgen.
      return im[1].replace(/-\d+x\d+(?=\.[a-zA-Z]+$)/, '');
    })();

    const dateText = (() => {
      const dm = inner.match(/class="event-date"[\s\S]*?<span>([\s\S]*?)<\/strong>/);
      if (!dm) return null;
      return stripHtml(dm[1]);
    })();

    const timeText = (() => {
      const tm = inner.match(
        /class="event-time">([^<]+)<\/span>/,
      );
      return tm ? tm[1].trim() : null;
    })();

    const priceText = (() => {
      const pm = inner.match(
        /class="event-price-wrapper">[\s\S]*?<strong>([\s\S]*?)<\/strong>/,
      );
      return pm ? stripHtml(pm[1]) : null;
    })();

    tiles.push({ url: href, slug, title, imageUrl, dateText, timeText, priceText });
  }
  return tiles;
}

async function fetchDescription(detailUrl: string): Promise<string | null> {
  try {
    const r = await fetch(detailUrl, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const html = await r.text();
    const m = html.match(
      /<meta property="og:description" content="([^"]+)"/,
    );
    if (m) return stripHtml(m[1]);
    return null;
  } catch {
    return null;
  }
}

async function mirrorImage(
  sourceUrl: string,
  venueId: string,
  slug: string,
): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength < 1024 || buf.byteLength > 16 * 1024 * 1024) return null;
    const ext = mime.includes('png')
      ? 'png'
      : mime.includes('webp')
        ? 'webp'
        : 'jpg';
    return await uploadToBunny(
      `media/events/${venueId}-${slug}.${ext}`,
      buf,
      mime,
    );
  } catch (e) {
    console.warn(
      `[volkshotel] mirror ${venueId}-${slug}: ${(e as Error).message}`,
    );
    return null;
  }
}

function priceToCents(p: string | null): number | null {
  if (!p) return null;
  if (/^free$/i.test(p) || p === '0' || p === '€0' || p === '€ 0') return 0;
  const m = p.match(/€\s*(\d+)(?:[,.](\d{1,2}))?/);
  if (!m) return null;
  const euros = Number(m[1]);
  const cents = Number((m[2] ?? '00').padEnd(2, '0').slice(0, 2));
  return euros * 100 + cents;
}

export type VolkshotelVenueResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeVolkshotel(options?: {
  venueIds?: string[];
}): Promise<VolkshotelVenueResult[]> {
  const allVenues = await db.select().from(schema.venues);
  const targets = allVenues.filter((v) => {
    if (options?.venueIds && !options.venueIds.includes(v.id)) return false;
    return Boolean(v.scraperConfig?.volkshotel?.roomPath);
  });

  const results: VolkshotelVenueResult[] = [];

  for (const venue of targets) {
    const cfg = venue.scraperConfig!.volkshotel!;
    const result: VolkshotelVenueResult = {
      venueId: venue.id,
      fetched: 0,
      inserted: 0,
      occurrencesUpserted: 0,
      skipped: 0,
      errors: [],
    };

    let tiles: RawTile[];
    try {
      tiles = await fetchListing(cfg.roomPath);
    } catch (e) {
      result.errors.push(`fetch: ${(e as Error).message}`);
      results.push(result);
      continue;
    }
    result.fetched = tiles.length;

    const cutoff = Date.now() - 6 * 60 * 60 * 1000;
    const venueCategory = venue.categories?.[0] ?? 'Muziek';

    for (const tile of tiles) {
      try {
        if (!tile.dateText) {
          result.skipped++;
          continue;
        }
        const startsAt = buildStartDate(tile.dateText, tile.timeText);
        if (!startsAt || startsAt.getTime() < cutoff) {
          result.skipped++;
          continue;
        }
        const endsAt = buildEndDate(startsAt, tile.timeText);

        const eventId = `evt-${venue.id}-${tile.slug}`;
        const occurrenceId = `occ-${venue.id}-${tile.slug}`;

        const [existing] = await db
          .select({ id: schema.events.id })
          .from(schema.events)
          .where(eq(schema.events.id, eventId))
          .limit(1);

        let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;
        let imageUrl: string | null = null;
        let description: string | null = null;

        if (!existing) {
          description = await fetchDescription(tile.url);
          try {
            enriched = await enrichEvent({
              title: tile.title,
              description,
              venueName: venue.name,
              venueCategory,
            });
          } catch (e) {
            result.errors.push(
              `enrich ${tile.title}: ${(e as Error).message}`,
            );
          }
          if (tile.imageUrl) {
            imageUrl = await mirrorImage(tile.imageUrl, venue.id, tile.slug);
          }

          const eventKind = refineKindByDuration(
            enriched?.kind ?? 'show',
            startsAt,
            endsAt,
          );

          try {
            await db.insert(schema.events).values({
              id: eventId,
              venueId: venue.id,
              title: tile.title,
              description: enriched?.cleanedDescription ?? description ?? null,
              kind: eventKind,
              imageUrl,
              category: enriched?.category ?? venueCategory,
              featured: false,
              genres: enriched?.genres ?? [],
              published: true,
            });
            result.inserted++;
          } catch (e) {
            result.errors.push(`insert ${eventId}: ${(e as Error).message}`);
            continue;
          }
        }

        try {
          const priceCents = priceToCents(tile.priceText);
          await db
            .insert(schema.occurrences)
            .values({
              id: occurrenceId,
              eventId,
              startsAt,
              endsAt,
              priceCents,
              priceNote: existing ? null : (enriched?.priceNote ?? null),
              ticketUrl: tile.url,
              room: null,
              lineup: existing ? null : (enriched?.lineup ?? null),
              status: 'scheduled',
            })
            .onConflictDoUpdate({
              target: schema.occurrences.id,
              set: { startsAt, endsAt, priceCents, ticketUrl: tile.url },
            });
          result.occurrencesUpserted++;
        } catch (e) {
          result.errors.push(
            `occurrence ${tile.slug}: ${(e as Error).message}`,
          );
          result.skipped++;
        }
      } catch (e) {
        result.errors.push(`tile ${tile.slug}: ${(e as Error).message}`);
        result.skipped++;
      }
    }

    results.push(result);
  }

  return results;
}
