import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Patronaat (Haarlem) scraper. WordPress zonder publieke WP REST API,
 * dus alles via HTML-parsing. Strategie:
 *   1. Programma-overzicht (/programma/) bevat álle 100+ events in één
 *      response in `.event-program` cards. Per card: titel, datum (`do
 *      14 Mei 2026`), subtitle, image, genres, event-URL.
 *   2. Per event de detail-pagina fetchen voor aanvangstijd
 *      (`Aanvang … 19:30`) + ticket-URL (linkt direct naar
 *      `ticketmaster.nl/event/...?brand=nl_patronaat`).
 *
 * Idempotency: event-id = `evt-patronaat-{slug}` (slug uit detail-URL,
 * bv. `sean-rowe-14-05-26` — bevat datum dus uniek per show).
 */

const VENUE_ID = 'patronaat';
const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const BASE = 'https://patronaat.nl';
const PROGRAMMA_URL = `${BASE}/programma/`;

const NL_MONTHS: Record<string, number> = {
  jan: 0, januari: 0,
  feb: 1, februari: 1,
  mrt: 2, maart: 2,
  apr: 3, april: 3,
  mei: 4,
  jun: 5, juni: 5,
  jul: 6, juli: 6,
  aug: 7, augustus: 7,
  sep: 8, september: 8,
  okt: 9, oktober: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

type CardRaw = {
  url: string;
  slug: string;
  title: string;
  subtitle: string | null;
  date: Date | null;
  imageUrl: string | null;
  genres: string[];
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
    .replace(/&#8217;/g, '’')
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

function parseCardDate(text: string): Date | null {
  // "do 14 Mei 2026" — voorgesteld dag-abrev + dag + maand + jaar.
  const m = text.match(/(\d{1,2})\s+([A-Za-zé]+)\s+(\d{4})/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = NL_MONTHS[m[2].toLowerCase()];
  const year = parseInt(m[3], 10);
  if (month === undefined) return null;
  // Tijdelijk om 20:00, wordt later vervangen door detail-page tijd.
  return shiftToLocalTime(year, month, day, 20, 0);
}

function extractCards(html: string): CardRaw[] {
  const cards: CardRaw[] = [];
  // Match elke `<div class="event-program">…</div>` tot het volgende
  // `</div>` op `overview__list-item` niveau. We pakken een ruime
  // window en zoeken binnen daarmee per veld.
  const blockRe =
    /<div class="event-program">([\s\S]*?)(?=<div class="overview__list-item|<\/section|$)/g;
  for (const m of html.matchAll(blockRe)) {
    const block = m[1];

    // URL + slug
    const urlMatch = block.match(
      /<a href="(https:\/\/patronaat\.nl\/event\/([^"\/]+)\/?)"/
    );
    if (!urlMatch) continue;
    const url = urlMatch[1];
    const slug = urlMatch[2];

    // Title — eerste <h3 class="event-program__name">…<a…>TITLE</a></h3>
    const titleMatch = block.match(
      /<h3 class="event-program__name">[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/
    );
    if (!titleMatch) continue;
    const title = decode(stripTags(titleMatch[1]));
    if (!title) continue;

    // Date string in `.event-program__date`
    const dateMatch = block.match(
      /<div class="event-program__date">[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/
    );
    const date = dateMatch ? parseCardDate(stripTags(dateMatch[1])) : null;

    // Subtitle
    const subMatch = block.match(
      /<div class="event-program__subtitle">\s*([\s\S]*?)<\/div>/
    );
    const subtitle = subMatch ? decode(stripTags(subMatch[1])) || null : null;

    // Image
    const imgMatch = block.match(
      /<img\s[^>]*src="([^"]+)"[^>]*alt="Evenementafbeelding/
    );
    const imageUrl = imgMatch ? imgMatch[1] : null;

    // Genres
    const genres: string[] = [];
    const gRe =
      /class="event__tags-item event__tags-item--genre"[^>]*>\s*([^<]+)\s*</g;
    for (const gm of block.matchAll(gRe)) {
      const g = decode(gm[1]).toLowerCase();
      if (g && !genres.includes(g)) genres.push(g);
    }

    cards.push({ url, slug, title, subtitle, date, imageUrl, genres });
  }
  return cards;
}

type DetailInfo = {
  startsAt: Date | null;
  ticketUrl: string | null;
  description: string | null;
  imageUrl: string | null;
};

function extractDetail(html: string, fallbackDate: Date | null): DetailInfo {
  // Aanvangstijd: zoek in een "Aanvang"-context om random HH:MM
  // (telefoonnummers, footer-tijden) te vermijden.
  const timeMatch =
    html.match(/Aanvang(?:\s+show)?[\s\S]{0,200}?(\d{1,2})[:.](\d{2})/i) ??
    html.match(/Deuren\s+open[\s\S]{0,200}?(\d{1,2})[:.](\d{2})/i);
  const hour = timeMatch ? parseInt(timeMatch[1], 10) : 20;
  const minute = timeMatch ? parseInt(timeMatch[2], 10) : 0;

  // Combineer card-datum (in Amsterdam-tijd) met aanvangstijd uit detail.
  let startsAt = fallbackDate;
  if (startsAt) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Amsterdam',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    }).formatToParts(startsAt);
    const get = (t: string) =>
      parseInt(parts.find((p) => p.type === t)!.value, 10);
    startsAt = shiftToLocalTime(get('year'), get('month') - 1, get('day'), hour, minute);
  }

  // Ticket-URL: zoek expliciete Ticketmaster-link (Patronaat linkt
  // altijd naar ticketmaster.nl).
  const tmMatch = html.match(
    /href="(https:\/\/www\.ticketmaster\.nl\/event\/[^"]+)"/
  );
  const ticketUrl = tmMatch ? tmMatch[1] : null;

  // Description: pak de eerste alinea van het event-detail blok.
  const descMatch = html.match(
    /<div class="event-info-block--general">([\s\S]*?)<\/div>/
  );
  let description: string | null = null;
  if (descMatch) {
    const body = stripTags(decode(descMatch[1]));
    if (body.length > 50) description = body.slice(0, 2000);
  }
  // Fallback: og:description.
  if (!description) {
    const og = html.match(
      /<meta property="og:description" content="([^"]+)"/
    );
    if (og) description = decode(og[1]);
  }

  // Higher-res image van de detail-pagina (og:image is meestal grotere
  // variant dan de card thumbnail).
  const ogImg = html.match(/<meta property="og:image" content="([^"]+)"/);
  const imageUrl = ogImg ? ogImg[1] : null;

  return { startsAt, ticketUrl, description, imageUrl };
}

async function mirrorImage(
  sourceUrl: string,
  slug: string
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
      `media/events/patronaat-${slug}.${ext}`,
      buf,
      mime
    );
  } catch (e) {
    console.warn(`[patronaat] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type PatronaatResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapePatronaat(options?: {
  venueIds?: string[];
}): Promise<PatronaatResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: PatronaatResult = {
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

  const overviewHtml = await fetchHtml(PROGRAMMA_URL);
  if (!overviewHtml) {
    result.errors.push('/programma/ niet bereikbaar');
    return [result];
  }

  const cards = extractCards(overviewHtml);
  result.fetched = cards.length;

  const venueCategory = venue.categories?.[0] ?? 'Muziek';

  for (const card of cards) {
    try {
      if (!card.date) {
        result.skipped++;
        continue;
      }

      const eventId = `evt-patronaat-${card.slug}`;
      const occurrenceId = `occ-patronaat-${card.slug}`;

      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      // Detail-page nodig voor aanvangstijd + ticket-URL.
      const detailHtml = await fetchHtml(card.url);
      if (!detailHtml) {
        result.skipped++;
        continue;
      }
      const detail = extractDetail(detailHtml, card.date);
      const startsAt = detail.startsAt ?? card.date;

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
            ticketUrl: detail.ticketUrl ?? card.url,
            room: null,
            lineup: null,
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: { startsAt, ticketUrl: detail.ticketUrl ?? card.url },
          });
        result.occurrencesUpserted++;
        continue;
      }

      // Nieuw event — enrich + image-mirror.
      const finalDescription = detail.description ?? card.subtitle;

      const enriched = await enrichEvent({
        title: card.title,
        description: finalDescription,
        venueName: venue.name,
        venueCategory,
      });

      const sourceImage = detail.imageUrl ?? card.imageUrl;
      let imageUrl: string | null = null;
      if (sourceImage) {
        imageUrl = (await mirrorImage(sourceImage, card.slug)) ?? sourceImage;
      }

      const finalGenres =
        enriched.genres.length > 0 ? enriched.genres : card.genres.slice(0, 4);
      const refinedKind = refineKindByDuration(enriched.kind, startsAt, null);

      await db.transaction(async (tx) => {
        await tx.insert(schema.events).values({
          id: eventId,
          venueId: venue.id,
          title: card.title,
          description: enriched.cleanedDescription ?? finalDescription,
          kind: refinedKind,
          imageUrl,
          category: enriched.category ?? venueCategory,
          featured: false,
          genres: finalGenres,
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
            ticketUrl: detail.ticketUrl ?? card.url,
            room: enriched.room,
            lineup: enriched.lineup,
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: {
              startsAt,
              priceNote: enriched.priceNote,
              ticketUrl: detail.ticketUrl ?? card.url,
              room: enriched.room,
              lineup: enriched.lineup,
            },
          });
        result.occurrencesUpserted++;
      });
    } catch (e) {
      result.errors.push(`event ${card.slug}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
