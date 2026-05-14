import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Rijksmuseum (rijksmuseum.nl) scraper.
 *
 * /en/whats-on toont een handvol grote thematische tentoonstellingen
 * als `<a class="block-link" href="/en/(whats-on|stories)/exhibitions/SLUG">`.
 * De listing zelf bevat geen datums — alleen "On view"-labels — dus voor
 * de tijdsspan halen we elke detail-page op.
 *
 * Detail-pages tonen de datum als platte tekst binnen de eerste echte
 * `.markdown`-paragraaf, in twee varianten:
 *   - "6 February till 25 May 2026"      (start zonder jaar, end met jaar)
 *   - "27 March 2026 to 21 March 2027"   (beide met jaar, "to" separator)
 *   - "–" / "—" / "-" als alternatieve separator komen ook voor.
 *
 * Permanente installaties (Operation Night Watch) en niet-event blokken
 * (Rijksmuseum app, guided tours, Visit) hebben geen date-range en
 * worden geskipt — Andreas toont alleen tentoonstellingen met een
 * concrete tijdspan.
 *
 * Alle Rijksmuseum-events zijn multi-day exhibitions; kind = 'exhibition'
 * met startsAt 11:00 (museum-opening) en endsAt 18:00 op de einddatum.
 */

const VENUE_ID = 'rijksmuseum';
const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const LISTING_URL = 'https://www.rijksmuseum.nl/en/whats-on';
const BASE = 'https://www.rijksmuseum.nl';

const MONTHS: Record<string, number> = {
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sep: 8, sept: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
};

type CardRaw = {
  url: string;
  slug: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  imageUrl: string | null;
  description: string | null;
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

function stripHtml(s: string): string {
  return decode(s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
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
 * Parse een Rijksmuseum date-range naar { start, end }. Accepteert
 * "6 February till 25 May 2026" en "27 March 2026 to 21 March 2027",
 * plus varianten met `–` / `—` / `-` als separator.
 */
function parseDateRange(text: string): { start: Date; end: Date } | null {
  const re =
    /(\d{1,2})\s+([A-Za-z]+)(?:\s+(\d{4}))?\s+(?:till|to|until|through|–|—|-)\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i;
  const m = text.match(re);
  if (!m) return null;
  const startDay = parseInt(m[1], 10);
  const startMonth = MONTHS[m[2].toLowerCase()];
  if (startMonth === undefined) return null;
  const endDay = parseInt(m[4], 10);
  const endMonth = MONTHS[m[5].toLowerCase()];
  if (endMonth === undefined) return null;
  const endYear = parseInt(m[6], 10);
  let startYear = m[3] ? parseInt(m[3], 10) : endYear;
  // Start-jaar impliciet en start-maand > end-maand → range overlapt
  // jaargrens, dus start hoort bij het voorgaande jaar.
  if (!m[3] && startMonth > endMonth) startYear -= 1;
  return {
    start: shiftToLocalTime(startYear, startMonth, startDay, 11, 0),
    end: shiftToLocalTime(endYear, endMonth, endDay, 18, 0),
  };
}

/**
 * Extraheer relevante slug-paden uit de listing. We pakken alleen
 * exhibitions (zowel /whats-on/exhibitions/ als /stories/exhibitions/);
 * guided-tours, /visit, /app en /exhibitions/past (archief-link) skippen
 * we expliciet.
 */
function extractListingUrls(html: string): Array<{ url: string; slug: string }> {
  const out: Array<{ url: string; slug: string }> = [];
  const re =
    /<a\s+href="(\/en\/(?:whats-on|stories)\/exhibitions\/([a-z0-9-]+))"\s+class="block-link"/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const slug = m[2];
    if (slug === 'past' || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ url: `${BASE}${m[1]}`, slug });
  }
  return out;
}

/**
 * Parse de detail-page: titel, date-range, og:image en eerste
 * substantiële paragraaf voor de description.
 */
function parseDetail(html: string): {
  title: string | null;
  range: { start: Date; end: Date } | null;
  imageUrl: string | null;
  description: string | null;
} {
  const h1 = html.match(/<h1[^>]*class="heading-1[^"]*"[^>]*>([\s\S]*?)<\/h1>/);
  const title = h1 ? stripHtml(h1[1]) : null;

  // Date-range zit in een `<div class="markdown"><p>...</p>` blok.
  // Eerste `.markdown` is meestal de cookie-notice — daarom over ALLE
  // .markdown-blokken loopen tot we een date-match vinden.
  let range: { start: Date; end: Date } | null = null;
  const blocks = [
    ...html.matchAll(/<div class="markdown"[^>]*>([\s\S]*?)<\/div>/g),
  ];
  for (const b of blocks) {
    const text = stripHtml(b[1]);
    const r = parseDateRange(text);
    if (r) {
      range = r;
      break;
    }
  }

  const og = html.match(/property="og:image"\s+content="([^"]+)"/);
  let imageUrl = og ? decode(og[1]) : null;
  // Rijksmuseum's og:image bevat cache-busting query params. We laten
  // ze staan zodat de variant exact match maakt met wat Google ziet.
  if (imageUrl && !imageUrl.startsWith('http')) imageUrl = null;

  // Description: eerste markdown-paragraaf die geen cookie-notice en
  // geen date-regel is. Pak max ~280 tekens zodat we onder de
  // description-limit blijven.
  let description: string | null = null;
  for (const b of blocks) {
    const text = stripHtml(b[1]);
    if (!text || text.length < 40) continue;
    if (/cookie/i.test(text) && /policy/i.test(text)) continue;
    if (parseDateRange(text)) continue;
    description = text.slice(0, 500);
    break;
  }

  return { title, range, imageUrl, description };
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
      `media/events/rijksmuseum-${slug}.${ext}`,
      buf,
      mime
    );
  } catch (e) {
    console.warn(`[rijksmuseum] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type RijksmuseumResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeRijksmuseum(options?: {
  venueIds?: string[];
}): Promise<RijksmuseumResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: RijksmuseumResult = {
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

  const html = await fetchHtml(LISTING_URL);
  if (!html) {
    result.errors.push('/en/whats-on niet bereikbaar');
    return [result];
  }

  const listingUrls = extractListingUrls(html);
  const now = Date.now();
  const cards: CardRaw[] = [];

  for (const item of listingUrls) {
    const detailHtml = await fetchHtml(item.url);
    if (!detailHtml) {
      result.skipped++;
      continue;
    }
    const parsed = parseDetail(detailHtml);
    if (!parsed.title || !parsed.range) {
      // Permanente installaties zonder date-range (Operation Night
      // Watch e.d.) skippen we — geen valide event op andreas.
      result.skipped++;
      continue;
    }
    // Skip events waarvan het einde >24u in het verleden ligt.
    if (parsed.range.end.getTime() < now - 24 * 60 * 60_000) {
      result.skipped++;
      continue;
    }
    cards.push({
      url: item.url,
      slug: item.slug,
      title: parsed.title,
      startsAt: parsed.range.start,
      endsAt: parsed.range.end,
      imageUrl: parsed.imageUrl,
      description: parsed.description,
    });
  }
  result.fetched = cards.length;

  const venueCategory = venue.categories?.[0] ?? 'Kunst';

  for (const card of cards) {
    try {
      const eventId = `evt-rijksmuseum-${card.slug}`;
      const occurrenceId = `occ-rijksmuseum-${card.slug}`;

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
        imageUrl = (await mirrorImage(card.imageUrl, card.slug)) ?? card.imageUrl;
      }

      const refinedKind = refineKindByDuration(
        'exhibition',
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
