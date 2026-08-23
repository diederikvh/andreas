import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';
import { loadVenueTitleMap, resolveEventId } from './_title-dedup.js';

/**
 * De Nieuwe Anita (kleinkunst-podium/café Frederik Hendrikbuurt) scraper.
 *
 * WordPress met custom post type `agenda`. We pakken de listing
 * direct via de WP REST API:
 *   `/wp-json/wp/v2/agenda?per_page=100&_embed=wp:featuredmedia`
 * → titel, slug, link, excerpt, content, image.
 *
 * De event-datum staat NIET in de REST-response (alleen post-publish
 * datum) maar wel als WP-custom-field `_agenda_short_date` op de
 * detail-page als `<span class="w-post-elm-value">July 2</span>`.
 * Format is English "Month D" zonder jaar — afgeleid van huidige
 * maand (rolt naar volgend jaar bij month < nu). Start-tijd uit
 * `agenda_time_start`-custom-field; leeg → default 20:30 Amsterdam.
 *
 * Idempotent: event-id = `evt-anita-{slug}`.
 */

const VENUE_ID = 'de-nieuwe-anita';
const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const BASE = 'https://denieuweanita.nl';
const REST_URL = `${BASE}/wp-json/wp/v2/agenda?per_page=100&_embed=wp:featuredmedia`;

const EN_MONTHS_FULL: Record<string, number> = {
  January: 0, February: 1, March: 2, April: 3, May: 4, June: 5,
  July: 6, August: 7, September: 8, October: 9, November: 10, December: 11,
};

type WpAgenda = {
  id: number;
  slug: string;
  link: string;
  title: { rendered: string };
  excerpt: { rendered: string };
  content: { rendered: string };
  _embedded?: {
    'wp:featuredmedia'?: Array<{ source_url?: string }>;
  };
};

type Item = {
  slug: string;
  url: string;
  title: string;
  excerpt: string | null;
  imageUrl: string | null;
  startsAt: Date;
};

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

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
    .replace(/&#x27;/g, "'")
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&#8216;/g, '‘')
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

function extractDetailDate(
  html: string
): { day: number; month: number; hour: number; minute: number } | null {
  // _agenda_short_date custom field: "<span class="w-post-elm-value">July 2</span>"
  const dateMatch = html.match(
    /_agenda_short_date[^>]*>[\s\S]*?<span class="w-post-elm-value">([^<]+)<\/span>/
  );
  if (!dateMatch) return null;
  const m = dateMatch[1].trim().match(/^([A-Za-z]+)\s+(\d{1,2})$/);
  if (!m) return null;
  const month = EN_MONTHS_FULL[m[1]];
  const day = parseInt(m[2], 10);
  if (month === undefined) return null;

  // agenda_time_start custom field: "<span class="w-post-elm-value">21:00</span>"
  // of leeg → default 20:30.
  const timeMatch = html.match(
    /agenda_time_start[^>]*>[\s\S]*?<span class="w-post-elm-value">([^<]*)<\/span>/
  );
  let hour = 20;
  let minute = 30;
  if (timeMatch) {
    const tm = timeMatch[1].trim().match(/^(\d{1,2}):(\d{2})/);
    if (tm) {
      hour = parseInt(tm[1], 10);
      minute = parseInt(tm[2], 10);
    }
  }
  return { day, month, hour, minute };
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
      `media/events/anita-${slug}.${ext}`,
      buf,
      mime
    );
  } catch (e) {
    console.warn(`[anita] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type DeNieuweAnitaResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeDeNieuweAnita(options?: {
  venueIds?: string[];
}): Promise<DeNieuweAnitaResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: DeNieuweAnitaResult = {
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

  const posts = await fetchJson<WpAgenda[]>(REST_URL);
  if (!posts) {
    result.errors.push('WP REST API niet bereikbaar');
    return [result];
  }
  result.fetched = posts.length;

  // Anita is multidisciplinair (muziek + theater + film + literatuur);
  // de Muziek-default biaste Claude richting 'Muziek' bij ambigue
  // titels (Cinemanita-filmnight kreeg ten onrechte Muziek). 'Theater'
  // is een neutralere hint voor een multidisciplinair podium —
  // Claude valt voor concrete signals (film/lezing/concert) terug op
  // de juiste category uit titel + description.
  const venueCategory = venue.categories?.[0] ?? 'Theater';

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();

  const byTitle = await loadVenueTitleMap(VENUE_ID, 'evt-anita-');

  for (const p of posts) {
    try {
      const slug = p.slug;
      const title = decode(stripTags(p.title.rendered));
      if (!title) {
        result.skipped++;
        continue;
      }

      // Detail-page voor de event-datum + tijd.
      const detailHtml = await fetchHtml(p.link);
      if (!detailHtml) {
        result.skipped++;
        result.errors.push(`${slug}: detail niet bereikbaar`);
        continue;
      }
      const date = extractDetailDate(detailHtml);
      if (!date) {
        result.skipped++;
        // Stilletjes overslaan: niet elk WP-agenda-post heeft een
        // datum-veld ingevuld (drafts/concepten).
        continue;
      }
      // Jaar-inferentie: huidig tenzij maand al gepasseerd (dan +1).
      const year = date.month < currentMonth ? currentYear + 1 : currentYear;
      const startsAt = shiftToLocalTime(
        year,
        date.month,
        date.day,
        date.hour,
        date.minute
      );
      // Skip events ouder dan 24u — agenda-posts blijven soms staan
      // na de datum.
      if (startsAt.getTime() < now.getTime() - 24 * 60 * 60_000) {
        result.skipped++;
        continue;
      }

      // Description: gebruik content.rendered (per-post unieke tekst).
      // De WP excerpt-template op Anita is admin-fout gevuld met
      // dezelfde "Witte Geit..."-tekst op álle posts, dus die negeren
      // we volledig. Content begint met de titel + tijd-aanduiding;
      // we knippen 'm op 800 tekens om buitenproportionele description-
      // sizes te voorkomen.
      let description = decode(stripTags(p.content.rendered || ''))
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 800);
      if (!description) description = null as unknown as string;

      // Description is hier al bekend (puur string-werk op de WP-post),
      // dus die kan als signaal mee: "CinemAnita Fiber Factory" is elke
      // week een andere film en mag niet samengevoegd worden.
      const { eventId } = resolveEventId(byTitle, title, `evt-anita-${slug}`, {
        startsAt,
        description,
      });
      const occurrenceId = `occ-anita-${slug}`;

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
            startsAt,
            endsAt: null,
            priceCents: null,
            priceNote: null,
            ticketUrl: p.link,
            room: null,
            lineup: null,
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            // eventId meenemen: occurrences die nog aan een per-avond-
            // event hingen verhuizen zo zelf naar het canonieke event.
            set: { eventId, startsAt, ticketUrl: p.link },
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

      const sourceImage =
        p._embedded?.['wp:featuredmedia']?.[0]?.source_url ?? null;
      let imageUrl: string | null = null;
      if (sourceImage) {
        imageUrl = (await mirrorImage(sourceImage, slug)) ?? sourceImage;
      }

      const refinedKind = refineKindByDuration('show', startsAt, null);

      await db.transaction(async (tx) => {
        await tx.insert(schema.events).values({
          id: eventId,
          venueId: venue.id,
          title,
          description: enriched.cleanedDescription ?? description ?? null,
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
            startsAt,
            endsAt: null,
            priceCents: null,
            priceNote: enriched.priceNote,
            ticketUrl: p.link,
            room: enriched.room,
            lineup: enriched.lineup,
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: {
              startsAt,
              priceNote: enriched.priceNote,
              ticketUrl: p.link,
              room: enriched.room,
              lineup: enriched.lineup,
            },
          });
        result.occurrencesUpserted++;
      });
    } catch (e) {
      result.errors.push(`${p.slug}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
