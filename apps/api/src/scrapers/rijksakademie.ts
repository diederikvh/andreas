import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Rijksakademie publieksprogramma — pure-HTTP scraper.
 *
 * Bron: `https://rijksakademie.nl/nl/publieksprogramma` (listing-page).
 * Elke event-URL volgt het patroon:
 *   `/nl/publieksprogramma/{YYYY-MM-DD}-{slug}`
 * → datum direct uit URL te halen, geen detail-fetch nodig daarvoor.
 *
 * Voor description + image fetchen we wel de detail-pagina (og:meta).
 * Voor de tijd: meestal in og:description als "Tuesday DD Month, HH.MM";
 * default 19:00 als parser faalt.
 *
 * Idempotent: `evt-rijks-{slug-zonder-datum}`, `occ-rijks-{...}`.
 *
 * TODO(lezing-gate): venueCategory default = 'Literatuur' tot de
 * nieuwe native build live is; daarna terug naar 'Lezing'.
 */

const VENUE_ID = 'rijksakademie';
const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const LISTING_URL = 'https://rijksakademie.nl/nl/publieksprogramma';

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

/** "<TZD>HH.MM" of "HH:MM" uit een string halen. */
function parseTime(s: string): { hour: number; minute: number } | null {
  const m = s.match(/(\d{1,2})[.:](\d{2})/);
  if (!m) return null;
  const hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

type EventCandidate = {
  slug: string;          // bv. "2026-05-26-a-conversation-with-wendelien-van-oldenborgh"
  shortSlug: string;     // bv. "a-conversation-with-wendelien-van-oldenborgh"
  url: string;
  year: number;
  month: number;
  day: number;
};

function parseListing(html: string): EventCandidate[] {
  const seen = new Set<string>();
  const out: EventCandidate[] = [];
  const re =
    /href="(\/nl\/publieksprogramma\/(\d{4})-(\d{2})-(\d{2})-([a-z0-9-]+))"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({
      slug: m[1].replace('/nl/publieksprogramma/', ''),
      shortSlug: m[5],
      url: `https://rijksakademie.nl${m[1]}`,
      year: parseInt(m[2], 10),
      month: parseInt(m[3], 10) - 1,
      day: parseInt(m[4], 10),
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
    return await uploadToBunny(`media/events/rijks-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[rijks] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type RijksakademieResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeRijksakademie(options?: {
  venueIds?: string[];
}): Promise<RijksakademieResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: RijksakademieResult = {
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

  const listingHtml = await fetchHtml(LISTING_URL);
  if (!listingHtml) {
    result.errors.push('listing-page niet bereikbaar');
    return [result];
  }
  const candidates = parseListing(listingHtml);
  result.fetched = candidates.length;

  // TODO(lezing-gate): naar 'Lezing' wanneer de oude TestFlight bundle
  // verdrongen is door de Lezing-aware native build.
  const venueCategory = venue.categories?.[0] ?? 'Literatuur';
  const now = new Date();
  const pastCutoff = now.getTime() - 24 * 60 * 60_000;

  for (const c of candidates) {
    try {
      // Filter past direct op URL-datum (zonder detail-fetch).
      const provisionalStart = shiftToLocalTime(
        c.year, c.month, c.day, DEFAULT_HOUR, DEFAULT_MINUTE
      );
      if (provisionalStart.getTime() < pastCutoff) {
        result.skipped++;
        continue;
      }

      const detailHtml = await fetchHtml(c.url);
      if (!detailHtml) {
        result.skipped++;
        result.errors.push(`${c.shortSlug}: detail niet bereikbaar`);
        continue;
      }

      // og:title als display title
      const ogTitleMatch = detailHtml.match(
        /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/
      );
      const title = ogTitleMatch ? decode(ogTitleMatch[1]).trim() : null;
      if (!title) {
        result.skipped++;
        continue;
      }

      // og:description als basis-omschrijving (eerste regel = datum+tijd+locatie,
      // rest = eigenlijke beschrijving)
      const ogDescMatch = detailHtml.match(
        /<meta[^>]+property="og:description"[^>]+content="([^"]+)"/
      );
      const ogDesc = ogDescMatch ? decode(ogDescMatch[1]).trim() : '';

      // Tijd uit og:description (eerste regel met HH.MM of HH:MM)
      const time = parseTime(ogDesc) ?? { hour: DEFAULT_HOUR, minute: DEFAULT_MINUTE };
      const startsAt = shiftToLocalTime(
        c.year, c.month, c.day, time.hour, time.minute
      );

      // Description: alles na de eerste alinea (= eigenlijke beschrijving).
      // Eerste alinea is meestal "Tuesday DD Month, HH.MM\nLocation\nEntrance..."
      // Pak alles na het 2e of 3e regel.
      let description: string | null = null;
      if (ogDesc) {
        const lines = ogDesc.split(/\r?\n+/).map((l) => l.trim()).filter(Boolean);
        // Skip max 3 meta-regels (datum, locatie, prijs), pak rest.
        const body = lines.slice(3).join(' ') || lines.slice(1).join(' ');
        description = body.slice(0, 800) || null;
      }

      // og:image
      const ogImageMatch = detailHtml.match(
        /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/
      );
      const sourceImage = ogImageMatch ? decode(ogImageMatch[1]) : null;

      const eventId = `evt-rijks-${c.shortSlug}`;
      const occurrenceId = `occ-rijks-${c.shortSlug}`;
      const ticketUrl = c.url;

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
        title,
        description: description || null,
        venueName: venue.name,
        venueCategory,
      });

      let imageUrl: string | null = null;
      if (sourceImage) {
        imageUrl = (await mirrorImage(sourceImage, c.shortSlug)) ?? sourceImage;
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
      result.errors.push(`${c.shortSlug}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
