import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Arti et Amicitiae (kunstenaarsvereniging op het Rokin) scraper.
 *
 * `/agenda` is een Livewire-rendered HTML-pagina met alle aankomende
 * events als `.event` cards. Per card:
 *   - URL: `https://arti.nl/agenda/DD-MM-YYYY/<slug>` (datum + slug)
 *   - `.date`: NL-weekdag-afk + dag + maand, optioneel een tweede dag
 *     na een ` - ` divider (range voor tentoonstellingen)
 *   - `.tags`: 1–2 tags (Tentoonstellingen / Sociëteit / ArtSpace / Zalen)
 *   - `<h3><a>…</a></h3>`: titel
 *   - `<p>…</p>`: beschrijving
 *   - `.image img srcset`: thumbnail @2x voor de hero
 *
 * Kind-heuristic: 'exhibition' bij tag Tentoonstellingen ÓF aanwezige
 * eind-datum, anders 'show'. Voor exhibitions clampen we tijden naar
 * 00:00–23:59 zodat ze als all-day worden weergegeven. Voor shows
 * (lezingen, leden-avonden) defaulten we op 20:00 — een redelijke
 * vereniging-avond-tijd; eventueel later via detail-page-fetch te
 * verfijnen.
 *
 * Idempotency: event-id = `evt-arti-{DD-MM-YYYY}-{slug}` — datum is
 * onderdeel van de URL, dus dezelfde slug volgend jaar krijgt een
 * eigen event-rij.
 */

const VENUE_ID = 'arti-et-amicitiae';
const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const AGENDA_URL = 'https://arti.nl/agenda';

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
  /** Datumdeel uit URL, format `DD-MM-YYYY` — voor event-id stable. */
  dateSlug: string;
  title: string;
  description: string | null;
  startsAt: Date;
  endsAt: Date | null;
  imageUrl: string | null;
  tags: string[];
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

/**
 * Pak (day, month) uit een tekst-fragment binnen `.date`, bv. "3 mei".
 * Returnt null als 't niet matcht.
 */
function parseDayMonth(text: string): { day: number; month: number } | null {
  const m = text.match(/(\d{1,2})\s+([A-Za-zé]+)/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = NL_MONTHS[m[2].toLowerCase()];
  if (month === undefined) return null;
  return { day, month };
}

function extractCards(html: string): CardRaw[] {
  const cards: CardRaw[] = [];
  // Splits op `<div class="event"`-marker. Het eerste segment (alles
  // vóór de eerste event) gooien we weg. Elk volgend segment loopt
  // tot net vóór de volgende `<div class="event"` of het einde van
  // de pagina — bevat dus alles wat we per kaart nodig hebben.
  const segments = html.split(/<div class="event"[^>]*>/);
  for (const block of segments.slice(1)) {

    // URL + datum + slug uit href: /agenda/DD-MM-YYYY/<slug>
    const urlMatch = block.match(
      /<a href="(https:\/\/arti\.nl\/agenda\/(\d{2})-(\d{2})-(\d{4})\/([^"\/]+))"/
    );
    if (!urlMatch) continue;
    const url = urlMatch[1];
    const startDay = parseInt(urlMatch[2], 10);
    const startMonth = parseInt(urlMatch[3], 10) - 1;
    const startYear = parseInt(urlMatch[4], 10);
    const slug = urlMatch[5];
    const dateSlug = `${urlMatch[2]}-${urlMatch[3]}-${urlMatch[4]}`;

    // Titel — eerste <h3><a>TITLE</a></h3>
    const titleMatch = block.match(
      /<h3>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/
    );
    if (!titleMatch) continue;
    const title = decode(stripTags(titleMatch[1]));
    if (!title) continue;

    // Beschrijving — <p>…</p> binnen .text
    const descMatch = block.match(/<p>([\s\S]*?)<\/p>/);
    const description = descMatch ? decode(stripTags(descMatch[1])) || null : null;

    // Image — prefer @2x uit srcset, anders src
    let imageUrl: string | null = null;
    const srcsetMatch = block.match(
      /<img[^>]*srcset="([^"]+)"/
    );
    if (srcsetMatch) {
      const candidates = srcsetMatch[1]
        .split(',')
        .map((c) => c.trim())
        .map((c) => {
          const parts = c.split(/\s+/);
          return { url: parts[0], density: parts[1] ?? '1x' };
        });
      const at2x = candidates.find((c) => c.density === '2x');
      imageUrl = at2x?.url ?? candidates[0]?.url ?? null;
    }
    if (!imageUrl) {
      const srcMatch = block.match(/<img[^>]*src="([^"]+)"/);
      if (srcMatch) imageUrl = srcMatch[1];
    }

    // Tags — vrije classificatie van Arti zelf
    const tags: string[] = [];
    const tagRe = /<div class="tag">([^<]+)<\/div>/g;
    for (const tm of block.matchAll(tagRe)) {
      const t = decode(tm[1]).trim();
      if (t && !tags.includes(t)) tags.push(t);
    }

    // Eind-datum uit `.date`: na ` - ` divider staat een tweede
    // <sup>day-abbrev</sup> + "D maand". `.date` bevat een
    // genest `<div class="ta-center">` voor de divider, dus de
    // outer closing-tag pakken we via een anchor naar de eerstvolgende
    // sibling (`<div class="image">`).
    const dateBlockMatch = block.match(
      /<div class="date">([\s\S]*?)<div class="image">/
    );
    let endsAtDate: Date | null = null;
    if (dateBlockMatch) {
      const dateInner = dateBlockMatch[1];
      // Split op " - "-divider; alles na de divider is het eind-deel.
      const dividerIdx = dateInner.search(/<div class="ta-center">\s*-\s*<\/div>/);
      if (dividerIdx !== -1) {
        const endPart = dateInner.slice(dividerIdx);
        const endText = stripTags(endPart);
        const dm = parseDayMonth(endText);
        if (dm) {
          // Eind-jaar: zelfde als start, tenzij eind-maand < start-maand
          // (dan loopt 'ie over de jaarwisseling).
          const endYear =
            dm.month < startMonth ? startYear + 1 : startYear;
          // Eind van de dag (23:59) — wordt door de API ook normalised
          // naar 23:59:59 voor exhibitions.
          endsAtDate = shiftToLocalTime(endYear, dm.month, dm.day, 23, 59);
        }
      }
    }

    // Start-tijd: voor exhibitions/multi-day → 00:00, voor shows → 20:00.
    // Detectie of 't een exhibition is gebeurt op tags + range.
    const isExhibition =
      tags.includes('Tentoonstellingen') || endsAtDate !== null;
    const startHour = isExhibition ? 0 : 20;
    const startsAt = shiftToLocalTime(
      startYear,
      startMonth,
      startDay,
      startHour,
      0
    );

    cards.push({
      url,
      slug,
      dateSlug,
      title,
      description,
      startsAt,
      endsAt: endsAtDate,
      imageUrl,
      tags,
    });
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
      `media/events/arti-${idSlug}.${ext}`,
      buf,
      mime
    );
  } catch (e) {
    console.warn(`[arti] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type ArtiResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeArti(options?: {
  venueIds?: string[];
}): Promise<ArtiResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: ArtiResult = {
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

  const html = await fetchHtml(AGENDA_URL);
  if (!html) {
    result.errors.push('/agenda niet bereikbaar');
    return [result];
  }

  const cards = extractCards(html);
  result.fetched = cards.length;

  const venueCategory = venue.categories?.[0] ?? 'Kunst';

  for (const card of cards) {
    try {
      const idSlug = `${card.dateSlug}-${card.slug}`;
      const eventId = `evt-arti-${idSlug}`;
      const occurrenceId = `occ-arti-${idSlug}`;

      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      if (existing) {
        // Alleen occurrence refreshen — tijden kunnen wijzigen bij
        // multi-day exhibitions waarvan de eind-datum bijgesteld wordt.
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

      // Kind: exhibition als tag of range zegt zo; anders show. Verfijn
      // daarna op duration (helpt bij ambigue gevallen).
      const initialKind: 'show' | 'exhibition' =
        card.tags.includes('Tentoonstellingen') || card.endsAt !== null
          ? 'exhibition'
          : 'show';
      const refinedKind = refineKindByDuration(
        initialKind,
        card.startsAt,
        card.endsAt
      );

      const enriched = await enrichEvent({
        title: card.title,
        description: card.description,
        venueName: venue.name,
        venueCategory,
      });

      let imageUrl: string | null = null;
      if (card.imageUrl) {
        imageUrl = (await mirrorImage(card.imageUrl, idSlug)) ?? card.imageUrl;
      }

      const finalGenres =
        enriched.genres.length > 0
          ? enriched.genres
          : card.tags.map((t) => t.toLowerCase()).slice(0, 4);

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
          genres: finalGenres,
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
      result.errors.push(`event ${card.slug}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
