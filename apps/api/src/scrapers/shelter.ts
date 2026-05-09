import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Shelter Amsterdam — directe WP REST API scraper.
 *
 * Bron: `https://www.shelteramsterdam.nl/wp-json/wp/v2/dt_portfolio`
 *
 * Per event leveren we:
 *  - `title.rendered` (HTML-decoded) — zonder "DD.MM " prefix
 *  - `date` als startsAt (ISO, CET)
 *  - `_embedded.wp:featuredmedia[0].source_url` als image (square 1080×)
 *  - `yoast_head_json.og_description` als description
 *
 * Geen end-time in de bron — default: startsAt + 7u (typische club-night).
 *
 * Idempotency:
 *  - eventId      = `evt-shelter-{slug}`
 *  - occurrenceId = `occ-shelter-{slug}`
 *
 * Ticket-link: `https://web.fourvenues.com/en/iframe/shelter-amsterdam`
 * (Shelter heeft Fourvenues als ticketshop — content komt van WP, tickets
 * blijven daar.)
 */

const UA = 'Mozilla/5.0 (Andreas/1.0)';
const VENUE_ID = 'shelter';
const WP_BASE = 'https://www.shelteramsterdam.nl/wp-json/wp/v2/dt_portfolio';
const TICKET_URL = 'https://web.fourvenues.com/en/iframe/shelter-amsterdam';
const PER_PAGE = 100;

type WpPortfolioItem = {
  id: number;
  slug: string;
  link: string;
  date: string;
  title: { rendered: string };
  featured_media: number;
  yoast_head_json?: {
    og_title?: string;
    og_description?: string;
    description?: string;
    og_image?: Array<{ url: string; width: number; height: number }>;
  };
  _embedded?: {
    'wp:featuredmedia'?: Array<{ source_url: string; alt_text?: string }>;
  };
};

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#038;/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/&#8217;/g, '’')
    .replace(/&#8216;/g, '‘')
    .replace(/&#8220;/g, '“')
    .replace(/&#8221;/g, '”')
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** "27.06 Boss Priester b2b Rich NxT, Job de Jong & more" → "Boss Priester ..." */
function stripDatePrefix(title: string): string {
  return title.replace(/^\s*\d{1,2}\.\d{1,2}\s+/, '').trim();
}

/** og_title is "Title - Shelter Amsterdam"; strip suffix als aanwezig. */
function cleanOgTitle(s: string | undefined | null): string | null {
  if (!s) return null;
  return s.replace(/\s*-\s*Shelter Amsterdam\s*$/, '').trim() || null;
}

async function fetchAllPortfolio(): Promise<WpPortfolioItem[]> {
  const all: WpPortfolioItem[] = [];
  for (let page = 1; page <= 6; page++) {
    const url = `${WP_BASE}?per_page=${PER_PAGE}&page=${page}&_embed=1&orderby=date&order=desc`;
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
    if (r.status === 400 || r.status === 404) break;
    if (!r.ok) throw new Error(`WP REST ${r.status} on page ${page}`);
    const items = (await r.json()) as WpPortfolioItem[];
    if (!Array.isArray(items) || items.length === 0) break;
    all.push(...items);
    if (items.length < PER_PAGE) break;
  }
  return all;
}

async function mirrorImage(sourceUrl: string, slug: string): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength < 1024 || buf.byteLength > 16 * 1024 * 1024) return null;
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    return await uploadToBunny(`media/events/shelter-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[shelter] mirror image failed ${slug}: ${(e as Error).message}`);
    return null;
  }
}

export type ShelterResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeShelter(options?: { venueIds?: string[] }): Promise<ShelterResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];
  const [venue] = await db.select().from(schema.venues).where(eq(schema.venues.id, VENUE_ID));
  if (!venue) return [];

  const result: ShelterResult = {
    venueId: VENUE_ID, fetched: 0, inserted: 0, occurrencesUpserted: 0, skipped: 0, errors: [],
  };

  let items: WpPortfolioItem[];
  try {
    items = await fetchAllPortfolio();
  } catch (e) {
    result.errors.push(`fetch portfolio: ${(e as Error).message}`);
    return [result];
  }

  result.fetched = items.length;
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  const venueCategory = venue.categories?.[0] ?? 'Muziek';

  for (const item of items) {
    try {
      // `date` is "2026-06-27T23:00:41" — geen TZ. Site is CET.
      const startsAt = new Date(item.date + '+02:00');
      if (isNaN(startsAt.getTime())) { result.skipped++; continue; }
      if (startsAt.getTime() < cutoff) { result.skipped++; continue; }

      // Default end: startsAt + 7u
      const endsAt = new Date(startsAt.getTime() + 7 * 60 * 60 * 1000);

      const slug = item.slug;
      const eventId = `evt-shelter-${slug}`;
      const occurrenceId = `occ-shelter-${slug}`;

      // og_title is "DD.MM Title - Shelter Amsterdam"; rendered title is
      // "DD.MM Title". Beide bevatten de prefix → strip altijd.
      const rawTitle = cleanOgTitle(item.yoast_head_json?.og_title)
        ?? decodeHtmlEntities(item.title.rendered ?? '');
      const title = stripDatePrefix(rawTitle);
      if (!title) { result.skipped++; continue; }

      const description = item.yoast_head_json?.og_description?.trim() || null;

      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;
      let imageUrl: string | null = null;

      if (!existing) {
        try {
          enriched = await enrichEvent({
            title,
            description,
            venueName: venue.name,
            venueCategory,
          });
        } catch (e) {
          result.errors.push(`enrich ${title}: ${(e as Error).message}`);
        }

        const ogImage = item.yoast_head_json?.og_image?.[0]?.url
          ?? item._embedded?.['wp:featuredmedia']?.[0]?.source_url
          ?? null;
        if (ogImage) imageUrl = await mirrorImage(ogImage, slug);

        const eventKind = refineKindByDuration(enriched?.kind ?? 'show', startsAt, endsAt);

        try {
          await db.insert(schema.events).values({
            id: eventId,
            venueId: VENUE_ID,
            title,
            description: enriched?.cleanedDescription ?? description,
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
        await db
          .insert(schema.occurrences)
          .values({
            id: occurrenceId,
            eventId,
            startsAt,
            endsAt,
            priceCents: null,
            priceNote: existing ? null : (enriched?.priceNote ?? null),
            ticketUrl: TICKET_URL,
            room: null,
            lineup: existing ? null : (enriched?.lineup ?? null),
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: { startsAt, endsAt, ticketUrl: TICKET_URL },
          });
        result.occurrencesUpserted++;
      } catch (e) {
        result.errors.push(`occurrence ${slug}: ${(e as Error).message}`);
        result.skipped++;
      }
    } catch (e) {
      result.errors.push(`item ${item.slug}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
