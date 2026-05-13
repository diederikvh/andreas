import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Bourbon Street (live-jazz/blues-club Leidseplein) scraper.
 *
 * `/shows/` is een platte HTML-listing. Per `.agenda-item`:
 *   - `<a href="/shows/SLUG.html">` (URL + slug)
 *   - `.day` (Wed) — niet nodig
 *   - `.date-number` (13)
 *   - `.month` (May, English short)
 *   - `.agenda-image img src` (volledige URL)
 *   - `.agenda-title` (titel, vaak UPPERCASE)
 *   - `.agenda-description` (1 zin)
 *   - `.agenda-time` ("23:00 - 03:00")
 *
 * Geen jaar in de HTML; we leiden 't af van de huidige maand
 * (rolt naar volgend jaar zodra de geparste maand < huidige maand).
 * Tijden zijn altijd avond/nacht — 23:00 → 03:00 volgende dag, dus
 * endsAt krijgt +1 dag t.o.v. startsAt als endHour < startHour.
 *
 * Event-id is gebaseerd op datum + slug zodat dezelfde slug volgende
 * week niet over de huidige rij heen schrijft.
 */

const VENUE_ID = 'bourbon-street';
const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const SHOWS_URL = 'https://www.bourbonstreet.nl/shows/';

const EN_MONTHS_SHORT: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

type CardRaw = {
  url: string;
  slug: string;
  title: string;
  description: string | null;
  startsAt: Date;
  endsAt: Date | null;
  imageUrl: string | null;
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
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
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

function extractCards(html: string): CardRaw[] {
  const cards: CardRaw[] = [];
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();

  const segments = html.split(/<div class="agenda-item">/);
  for (const block of segments.slice(1)) {
    const urlMatch = block.match(
      /<a\s+href=['"](https:\/\/www\.bourbonstreet\.nl\/shows\/([^'"\/]+))\.html['"]/
    );
    if (!urlMatch) continue;
    const url = `${urlMatch[1]}.html`;
    const slug = urlMatch[2];

    const dnMatch = block.match(/<div class="date-number">(\d{1,2})<\/div>/);
    const mMatch = block.match(/<div class="month">(\w+)<\/div>/);
    if (!dnMatch || !mMatch) continue;
    const day = parseInt(dnMatch[1], 10);
    const month = EN_MONTHS_SHORT[mMatch[1]];
    if (month === undefined) continue;
    // Jaar-inferentie: huidige jaar tenzij de geparste maand al voorbij
    // is voor dit jaar (dan rolt 't door naar volgend jaar).
    const year = month < currentMonth ? currentYear + 1 : currentYear;

    const timeMatch = block.match(
      /<div class="agenda-time">\s*(\d{1,2}):(\d{2})(?:\s*[-–]\s*(\d{1,2}):(\d{2}))?\s*<\/div>/
    );
    const startHour = timeMatch ? parseInt(timeMatch[1], 10) : 21;
    const startMin = timeMatch ? parseInt(timeMatch[2], 10) : 0;
    const startsAt = shiftToLocalTime(year, month, day, startHour, startMin);

    let endsAt: Date | null = null;
    if (timeMatch && timeMatch[3]) {
      const endHour = parseInt(timeMatch[3], 10);
      const endMin = parseInt(timeMatch[4]!, 10);
      // End < start (bv. 23:00 → 03:00) betekent volgende dag.
      const endDay = endHour < startHour ? day + 1 : day;
      endsAt = shiftToLocalTime(year, month, endDay, endHour, endMin);
    }

    const titleMatch = block.match(
      /<h3 class="agenda-title[^"]*">([^<]+)<\/h3>/
    );
    if (!titleMatch) continue;
    const title = decode(titleMatch[1]);
    if (!title) continue;

    const descMatch = block.match(
      /<p class="agenda-description">([^<]+)<\/p>/
    );
    const description = descMatch ? decode(stripTags(descMatch[1])) : null;

    const imgMatch = block.match(/<img\s+src="([^"]+)"/);
    const imageUrl = imgMatch ? imgMatch[1] : null;

    cards.push({ url, slug, title, description, startsAt, endsAt, imageUrl });
  }
  return cards;
}

async function mirrorImage(
  sourceUrl: string,
  idSlug: string
): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, { headers: { 'user-agent': UA } });
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
      `media/events/bourbonstreet-${idSlug}.${ext}`,
      buf,
      mime
    );
  } catch (e) {
    console.warn(
      `[bourbonstreet] mirror image failed: ${(e as Error).message}`
    );
    return null;
  }
}

export type BourbonStreetResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeBourbonStreet(options?: {
  venueIds?: string[];
}): Promise<BourbonStreetResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: BourbonStreetResult = {
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

  const html = await fetchHtml(SHOWS_URL);
  if (!html) {
    result.errors.push('/shows/ niet bereikbaar');
    return [result];
  }

  const cards = extractCards(html);
  result.fetched = cards.length;

  const venueCategory = venue.categories?.[0] ?? 'Muziek';

  for (const card of cards) {
    try {
      // Date-prefixed event-id zodat dezelfde slug volgende week niet
      // over de huidige rij heen schrijft. Slug-collision binnen
      // dezelfde dag is onwaarschijnlijk maar dan deduppen we sowieso.
      const yyyy = card.startsAt.toISOString().slice(0, 10).replace(/-/g, '');
      const idSlug = `${yyyy}-${card.slug}`;
      const eventId = `evt-bourbonstreet-${idSlug}`;
      const occurrenceId = `occ-bourbonstreet-${idSlug}`;

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
            startsAt: card.startsAt,
            endsAt: card.endsAt,
            priceCents: null,
            priceNote: null,
            ticketUrl: card.url,
            room: null,
            lineup: null,
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: {
              startsAt: card.startsAt,
              endsAt: card.endsAt,
              ticketUrl: card.url,
            },
          });
        result.occurrencesUpserted++;
        continue;
      }

      const enriched = await enrichEvent({
        title: card.title,
        description: card.description,
        venueName: venue.name,
        venueCategory,
      });

      let imageUrl: string | null = null;
      if (card.imageUrl) {
        imageUrl =
          (await mirrorImage(card.imageUrl, idSlug)) ?? card.imageUrl;
      }

      const refinedKind = refineKindByDuration(
        'show',
        card.startsAt,
        card.endsAt
      );

      await db.transaction(async (tx) => {
        await tx.insert(schema.events).values({
          id: eventId,
          venueId: venue.id,
          title: card.title,
          description: enriched.cleanedDescription ?? card.description,
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
            startsAt: card.startsAt,
            endsAt: card.endsAt,
            priceCents: null,
            priceNote: enriched.priceNote,
            ticketUrl: card.url,
            room: enriched.room,
            lineup: enriched.lineup,
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: {
              startsAt: card.startsAt,
              endsAt: card.endsAt,
              priceNote: enriched.priceNote,
              ticketUrl: card.url,
              room: enriched.room,
              lineup: enriched.lineup,
            },
          });
        result.occurrencesUpserted++;
      });
    } catch (e) {
      result.errors.push(`${card.slug}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
