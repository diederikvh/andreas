import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Akhnaton (cultureel podium/club, Nieuwezijds Kolk) scraper.
 *
 * WordPress met custom post type `evenement` — pakken we direct via WP REST:
 *   `/wp-json/wp/v2/evenement?per_page=100&_embed=wp:featuredmedia`
 * → titel, slug, link, content, featured image.
 *
 * De event-datum staat NIET in de REST-response. Op de detail-pagina
 * staat 'm als Elementor heading-widget:
 *   `<p class="elementor-heading-title elementor-size-default">zaterdag 30 mei</p>`
 * Format: Dutch DOW + dag + Dutch maand, géén jaar. Jaar afleiden van
 * huidige maand (rolt naar volgend jaar bij month < nu).
 *
 * Akhnaton publiceert geen aanvangstijd op de event-pagina; we vallen
 * terug op 22:00 (typische club-night). Admin kan tijd per event
 * overrulen.
 *
 * Idempotent: event-id = `evt-akh-{slug}`.
 */

const VENUE_ID = 'akhnaton';
const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const BASE = 'https://akhnaton.nl';
const REST_URL = `${BASE}/wp-json/wp/v2/evenement?per_page=100&_embed=wp:featuredmedia`;

const NL_MONTHS: Record<string, number> = {
  januari: 0, februari: 1, maart: 2, april: 3, mei: 4, juni: 5,
  juli: 6, augustus: 7, september: 8, oktober: 9, november: 10, december: 11,
};

const NL_DOW = new Set([
  'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag',
]);

const DEFAULT_HOUR = 22;
const DEFAULT_MINUTE = 0;

type WpEvenement = {
  id: number;
  slug: string;
  link: string;
  date_gmt: string;
  title: { rendered: string };
  content: { rendered: string };
  _embedded?: {
    'wp:featuredmedia'?: Array<{ source_url?: string }>;
  };
};

/** Strip trailing `-N` recurring suffix om dezelfde wekelijkse/maandelijkse
 *  show te groeperen. `clandestien-23`, `clandestien-22` … → `clandestien`.
 *  `clandestien-slotfeest` blijft 'm zelf (geen trailing nr).
 *  `vrijheidsmaaltijd-2026` strips → `vrijheidsmaaltijd` (oké — jaar-suffix
 *   ook een recurring-aanduiding). */
function canonicalKey(slug: string): string {
  return slug.replace(/-\d+$/, '');
}

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

/** Parse "zaterdag 30 mei" / "donderdag 1 augustus" → {day, month}. */
function parseDutchDateHeading(heading: string): { day: number; month: number } | null {
  const m = heading
    .toLowerCase()
    .trim()
    .match(/^([a-zé]+)\s+(\d{1,2})\s+([a-z]+)$/);
  if (!m) return null;
  if (!NL_DOW.has(m[1])) return null;
  const day = parseInt(m[2], 10);
  const month = NL_MONTHS[m[3]];
  if (month === undefined || day < 1 || day > 31) return null;
  return { day, month };
}

function extractDetailDate(html: string): { day: number; month: number } | null {
  // Elementor heading-widgets renderen als
  // `<p class="elementor-heading-title …">zaterdag 30 mei</p>`.
  // De event-datum is de eerste heading met DOW + dag + Dutch maand.
  const re = /<p class="elementor-heading-title[^"]*">([^<]+)<\/p>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const parsed = parseDutchDateHeading(decode(match[1]));
    if (parsed) return parsed;
  }
  return null;
}

/** Akhnaton's detail-pages noemen tijd als "Doors open at 20:00" of
 *  "aanvang: 20:00". Pak de eerste daarvan zodat we niet op default
 *  22:00 hoeven te leunen. */
function extractDetailTime(html: string): { hour: number; minute: number } | null {
  const m =
    html.match(/Doors\s+open\s+at\s+(\d{1,2})[:.](\d{2})/i) ??
    html.match(/[Aa]anvang[^\d<]{0,20}(\d{1,2})[:.](\d{2})/) ??
    html.match(/[Dd]eur[ae]n[^\d<]{0,40}(\d{1,2})[:.](\d{2})/);
  if (!m) return null;
  return { hour: parseInt(m[1], 10), minute: parseInt(m[2], 10) };
}

/** Pakt de eerste event-poster uit de detail-HTML: een `<img>` met src
 *  op `akhnaton.nl/wp-content/uploads/…`, .jpg/.png/.webp, niet logo/icon.
 *  Akhnaton zet geen WP `featured_media` op posts, dus de poster zit
 *  alleen in de Elementor-rendered content. */
function extractDetailImage(html: string): string | null {
  const re = /<img[^>]+src="(https?:\/\/akhnaton\.nl\/wp-content\/uploads\/[^"]+\.(?:jpe?g|png|webp))"/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const src = match[1];
    if (/logo|icon|favicon/i.test(src)) continue;
    return src;
  }
  return null;
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
      `media/events/akh-${slug}.${ext}`,
      buf,
      mime
    );
  } catch (e) {
    console.warn(`[akhnaton] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type AkhnatonResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeAkhnaton(options?: {
  venueIds?: string[];
}): Promise<AkhnatonResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: AkhnatonResult = {
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

  const posts = await fetchJson<WpEvenement[]>(REST_URL);
  if (!posts) {
    result.errors.push('WP REST API niet bereikbaar');
    return [result];
  }
  result.fetched = posts.length;

  const venueCategory = venue.categories?.[0] ?? 'Muziek';

  const now = new Date();
  const pastCutoff = now.getTime() - 24 * 60 * 60_000;

  // Groepeer recurring posts: `clandestien-23`, `-22`, … → één event
  // `clandestien` met 23 occurrences. Bare slug (clandestien-slotfeest)
  // blijft eigen groep.
  const groups = new Map<string, WpEvenement[]>();
  for (const p of posts) {
    const key = canonicalKey(p.slug);
    const arr = groups.get(key) ?? [];
    arr.push(p);
    groups.set(key, arr);
  }

  for (const [canonical, items] of groups) {
    // Per-post: detail-HTML → datum → occurrence-candidate.
    // Voor recurring shows (zelfde 'maart' in 23 posts) anchor-en we het
    // jaar aan post.date_gmt: een post gepubliceerd in maart 2026 met
    // "29 maart" hoort bij 2026, niet 2027. Zonder dit zou het naive
    // "month < currentMonth → year+1"-pad alle <currentMonth-events naar
    // volgend jaar tillen — incorrect voor archief-posts.
    const occurrences: Array<{
      post: WpEvenement;
      startsAt: Date;
      imageSourceUrl: string | null;
    }> = [];

    for (const p of items) {
      try {
        const detailHtml = await fetchHtml(p.link);
        if (!detailHtml) {
          result.errors.push(`${p.slug}: detail niet bereikbaar`);
          continue;
        }
        const date = extractDetailDate(detailHtml);
        if (!date) continue;

        const pub = new Date(p.date_gmt + 'Z');
        const pubYear = pub.getUTCFullYear();
        const pubMonth = pub.getUTCMonth();
        const year = date.month < pubMonth ? pubYear + 1 : pubYear;

        const time = extractDetailTime(detailHtml);
        const startsAt = shiftToLocalTime(
          year,
          date.month,
          date.day,
          time?.hour ?? DEFAULT_HOUR,
          time?.minute ?? DEFAULT_MINUTE
        );
        if (startsAt.getTime() < pastCutoff) continue;
        const imageSourceUrl = extractDetailImage(detailHtml);
        occurrences.push({ post: p, startsAt, imageSourceUrl });
      } catch (e) {
        result.errors.push(`${p.slug}: ${(e as Error).message}`);
      }
    }

    if (occurrences.length === 0) {
      result.skipped += items.length;
      continue;
    }

    // Pick canonical metadata-bron: nieuwste publicatie (= meest actuele
    // beschrijving/title-casing). Posts zijn niet gegarandeerd
    // gesorteerd, dus expliciet.
    const metaPost = [...items].sort((a, b) =>
      b.date_gmt.localeCompare(a.date_gmt)
    )[0];
    const title = decode(stripTags(metaPost.title.rendered));
    if (!title) {
      result.skipped += items.length;
      continue;
    }

    const eventId = `evt-akh-${canonical}`;
    const [existing] = await db
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(eq(schema.events.id, eventId))
      .limit(1);

    let description = decode(stripTags(metaPost.content.rendered || ''))
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 800);
    if (!description) description = null as unknown as string;

    // refinedKind o.b.v. earliest occurrence (recurring shows blijven
    // 'show'; alleen lange exhibitions zouden 'exhibition' worden)
    const earliest = occurrences.reduce((a, b) =>
      a.startsAt < b.startsAt ? a : b
    );

    if (!existing) {
      const enriched = await enrichEvent({
        title,
        description: description || null,
        venueName: venue.name,
        venueCategory,
      });

      // Pak de poster uit de earliest occurrence (= eerstvolgende editie).
      // Voor recurring shows (Clandestien-23/-22) hergebruikt Akhnaton
      // typisch één poster — die zit dan op alle occurrences.
      const sourceImage = earliest.imageSourceUrl;
      let imageUrl: string | null = null;
      if (sourceImage) {
        imageUrl = (await mirrorImage(sourceImage, canonical)) ?? sourceImage;
      }

      const refinedKind = refineKindByDuration('show', earliest.startsAt, null);

      await db.insert(schema.events).values({
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

      for (const occ of occurrences) {
        await db
          .insert(schema.occurrences)
          .values({
            id: `occ-akh-${occ.post.slug}`,
            eventId,
            startsAt: occ.startsAt,
            endsAt: null,
            priceCents: null,
            priceNote: enriched.priceNote,
            ticketUrl: occ.post.link,
            room: enriched.room,
            lineup: enriched.lineup,
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: {
              startsAt: occ.startsAt,
              ticketUrl: occ.post.link,
            },
          });
        result.occurrencesUpserted++;
      }
    } else {
      // Event bestaat al: upsert alleen occurrences (idempotent re-runs)
      for (const occ of occurrences) {
        await db
          .insert(schema.occurrences)
          .values({
            id: `occ-akh-${occ.post.slug}`,
            eventId,
            startsAt: occ.startsAt,
            endsAt: null,
            priceCents: null,
            priceNote: null,
            ticketUrl: occ.post.link,
            room: null,
            lineup: null,
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: {
              startsAt: occ.startsAt,
              ticketUrl: occ.post.link,
            },
          });
        result.occurrencesUpserted++;
      }
    }
  }

  return [result];
}
