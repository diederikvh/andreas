import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';
import { loadVenueTitleMap, resolveEventId } from './_title-dedup.js';

/**
 * Theater Mascini (kleinkunst op de Zeedijk, voorheen Casablanca
 * Variété) scraper.
 *
 * Homepage `/` is meteen de agenda. Per voorstellings-datum een
 * `<a class="itembox" href="/theater/{N}-{slug}?datum=YYYYMMDD">`:
 *   - URL: bevat de show-id (numeriek) + slug + datum-querystring
 *   - h1: titel
 *   - h2: subtitel (artiest/begeleiding)
 *   - .evenement-tijd h4: "20:30 uur" of "20:30 uur - Uitverkocht"
 *   - srcset met dubbel/heel/half/thumb resoluties
 *
 * Dezelfde productie wordt vaak op meerdere data geprogrammeerd
 * (`879-mirjam-klerks?datum=20260514`, `879-mirjam-klerks?datum=20260612`).
 * We groeperen op show-slug (`{N}-{slug}`) → één event-rij + N
 * occurrences. Sold-out → occurrence.status = 'sold_out'.
 */

const VENUE_ID = 'theater-mascini';
const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const BASE = 'https://www.theatermascini.nl';
const AGENDA_URL = `${BASE}/`;

type RawItem = {
  showSlug: string; // `{N}-{slug}` zonder querystring
  url: string; // volledige URL met datum-querystring
  title: string;
  subtitle: string | null;
  startsAt: Date;
  soldOut: boolean;
  imageUrl: string | null;
};

type Production = {
  showSlug: string;
  title: string;
  subtitle: string | null;
  imageUrl: string | null;
  occurrences: { startsAt: Date; url: string; soldOut: boolean }[];
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

function extractItems(html: string): RawItem[] {
  const items: RawItem[] = [];
  const segments = html.split(/<a href="(?=https:\/\/www\.theatermascini\.nl\/theater\/)/);
  for (const block of segments.slice(1)) {
    // URL + show-slug + datum
    const urlMatch = block.match(
      /^(https:\/\/www\.theatermascini\.nl\/theater\/([^"?]+)\?datum=(\d{8}))"/
    );
    if (!urlMatch) continue;
    const url = urlMatch[1];
    const showSlug = urlMatch[2];
    const dateStr = urlMatch[3];
    const y = parseInt(dateStr.slice(0, 4), 10);
    const mo = parseInt(dateStr.slice(4, 6), 10) - 1;
    const d = parseInt(dateStr.slice(6, 8), 10);

    // Tijd: <h4>20:30 uur ...</h4>
    const timeMatch = block.match(
      /<div class="evenement-tijd">\s*<h4>(\d{1,2}):(\d{2})/
    );
    const startHour = timeMatch ? parseInt(timeMatch[1], 10) : 20;
    const startMin = timeMatch ? parseInt(timeMatch[2], 10) : 30;
    const startsAt = shiftToLocalTime(y, mo, d, startHour, startMin);

    // Sold out detectie
    const soldOut = /class="alert">Uitverkocht/i.test(block);

    // Title — eerste h1 binnen .itemtext
    const titleMatch = block.match(/<h1(?:\s[^>]*)?>([\s\S]*?)<\/h1>/);
    if (!titleMatch) continue;
    const title = decode(stripTags(titleMatch[1]));
    if (!title) continue;

    // Subtitle — h2 direct daarna
    const subMatch = block.match(/<h2(?:\s[^>]*)?>([\s\S]*?)<\/h2>/);
    const subtitle = subMatch ? decode(stripTags(subMatch[1])) || null : null;

    // Image — beste resolutie uit srcset (heel = 1280w), anders src.
    let imageUrl: string | null = null;
    const srcsetMatch = block.match(/srcset="([^"]+)"/);
    if (srcsetMatch) {
      const cands = srcsetMatch[1].split(',').map((c) => c.trim().split(/\s+/));
      // Prefer 'heel' (1280w) sized variant if present
      const heel = cands.find((c) => c[1] === '1280w');
      const dubbel = cands.find((c) => c[1] === '2560w');
      imageUrl = (heel ?? dubbel ?? cands[0])?.[0] ?? null;
    }
    if (!imageUrl) {
      const srcMatch = block.match(/<img\s+src="([^"]+)"/);
      if (srcMatch) imageUrl = srcMatch[1];
    }
    if (imageUrl && !imageUrl.startsWith('http')) {
      imageUrl = `${BASE}/${imageUrl.replace(/^\//, '')}`;
    }

    items.push({ showSlug, url, title, subtitle, startsAt, soldOut, imageUrl });
  }
  return items;
}

function groupByProduction(items: RawItem[]): Production[] {
  const map = new Map<string, Production>();
  for (const it of items) {
    const existing = map.get(it.showSlug);
    if (existing) {
      existing.occurrences.push({
        startsAt: it.startsAt,
        url: it.url,
        soldOut: it.soldOut,
      });
    } else {
      map.set(it.showSlug, {
        showSlug: it.showSlug,
        title: it.title,
        subtitle: it.subtitle,
        imageUrl: it.imageUrl,
        occurrences: [
          { startsAt: it.startsAt, url: it.url, soldOut: it.soldOut },
        ],
      });
    }
  }
  return Array.from(map.values()).map((p) => ({
    ...p,
    occurrences: p.occurrences.sort(
      (a, b) => a.startsAt.getTime() - b.startsAt.getTime()
    ),
  }));
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
      `media/events/mascini-${slug}.${ext}`,
      buf,
      mime
    );
  } catch (e) {
    console.warn(`[mascini] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type TheaterMasciniResult = {
  venueId: string;
  fetched: number;
  productions: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeTheaterMascini(options?: {
  venueIds?: string[];
}): Promise<TheaterMasciniResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: TheaterMasciniResult = {
    venueId: VENUE_ID,
    fetched: 0,
    productions: 0,
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
    result.errors.push('homepage niet bereikbaar');
    return [result];
  }

  const items = extractItems(html);
  result.fetched = items.length;

  const productions = groupByProduction(items);
  result.productions = productions.length;

  const venueCategory = venue.categories?.[0] ?? 'Theater';

  const byTitle = await loadVenueTitleMap(VENUE_ID, 'evt-mascini-');

  for (const prod of productions) {
    try {
      // Description komt pas van de show-pagina hieronder; titel en
      // eerste datum zijn hier al bekend.
      const { eventId } = resolveEventId(
        byTitle,
        prod.title,
        `evt-mascini-${prod.showSlug}`,
        { startsAt: prod.occurrences[0]?.startsAt ?? null }
      );

      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      if (!existing) {
        const enriched = await enrichEvent({
          title: prod.title,
          description: prod.subtitle,
          venueName: venue.name,
          venueCategory,
        });

        let imageUrl: string | null = null;
        if (prod.imageUrl) {
          imageUrl =
            (await mirrorImage(prod.imageUrl, prod.showSlug)) ?? prod.imageUrl;
        }

        const firstStart = prod.occurrences[0]!.startsAt;
        const refinedKind = refineKindByDuration('show', firstStart, null);

        await db.insert(schema.events).values({
          id: eventId,
          venueId: venue.id,
          title: prod.title,
          description: enriched.cleanedDescription ?? prod.subtitle,
          kind: refinedKind,
          imageUrl,
          category: enriched.category ?? venueCategory,
          featured: false,
          genres: enriched.genres,
          published: true,
        });
        result.inserted++;
      }

      for (const occ of prod.occurrences) {
        const yyyy = occ.startsAt.toISOString().slice(0, 10).replace(/-/g, '');
        const occurrenceId = `occ-mascini-${prod.showSlug}-${yyyy}`;
        await db
          .insert(schema.occurrences)
          .values({
            id: occurrenceId,
            eventId,
            startsAt: occ.startsAt,
            endsAt: null,
            priceCents: null,
            priceNote: null,
            ticketUrl: occ.url,
            room: null,
            lineup: null,
            status: occ.soldOut ? 'sold_out' : 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: {
              eventId,
              startsAt: occ.startsAt,
              ticketUrl: occ.url,
              status: occ.soldOut ? 'sold_out' : 'scheduled',
            },
          });
        result.occurrencesUpserted++;
      }
    } catch (e) {
      result.errors.push(`${prod.showSlug}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
