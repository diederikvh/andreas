import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * De Krakeling — kindertheater, pure-HTTP scraper.
 *
 * `krakeling.nl/programma` toont per voorstelling een tile met
 * `<a href="/programma/{slug}">`. Per show-page:
 *  - `og:title` → title
 *  - `og:image` → image
 *  - `og:description` → description (1-2 zinnen)
 *  - `<time datetime="YYYY-MM-DDTHH:MM:SS">` → alle showdates
 *    (multi-show ochtend/middag is normaal voor kindertheater)
 *
 * Idempotency:
 *  - eventId      = `evt-krak-{slug}`
 *  - occurrenceId = `occ-krak-{slug}-{isoDate}`
 */

const UA = 'Mozilla/5.0 (Andreas/1.0)';
const VENUE_ID = 'de-krakeling';
const BASE = 'https://krakeling.nl';
const PROGRAMMA = `${BASE}/programma`;

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(parseInt(c, 10)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' } });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

async function discoverSlugs(): Promise<string[]> {
  const html = await fetchHtml(PROGRAMMA);
  if (!html) return [];
  const slugs = new Set<string>();
  for (const m of html.matchAll(/\/programma\/([a-z0-9-]+)(?=["'#?])/g)) {
    slugs.add(m[1]);
  }
  return Array.from(slugs);
}

type ShowMeta = {
  title: string;
  description: string | null;
  imageUrl: string | null;
  showtimes: Date[];
};

function pickMeta(html: string, name: string): string | null {
  const m = html.match(new RegExp(`<meta\\s+(?:property|name)=["']${name}["']\\s+content=["']([^"']+)["']`, 'i'));
  return m ? decodeHtmlEntities(m[1]) : null;
}

function extractShowtimes(html: string): Date[] {
  const out: Date[] = [];
  const seen = new Set<number>();
  for (const m of html.matchAll(/<time[^>]+datetime=["']([^"']+)["']/g)) {
    // Krakeling time-tags zijn lokale Amsterdam-tijd zonder TZ-suffix.
    const iso = /Z|[+-]\d{2}:\d{2}$/.test(m[1]) ? m[1] : `${m[1]}+02:00`;
    const d = new Date(iso);
    if (isNaN(d.getTime())) continue;
    if (seen.has(d.getTime())) continue;
    seen.add(d.getTime());
    out.push(d);
  }
  return out;
}

function parseShowPage(html: string): ShowMeta | null {
  const title = pickMeta(html, 'og:title');
  if (!title) return null;
  return {
    title,
    description: pickMeta(html, 'og:description'),
    imageUrl: pickMeta(html, 'og:image'),
    showtimes: extractShowtimes(html),
  };
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
    return await uploadToBunny(`media/events/krak-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[krakeling] mirror image ${slug}: ${(e as Error).message}`);
    return null;
  }
}

export type KrakelingResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeKrakeling(options?: { venueIds?: string[] }): Promise<KrakelingResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];
  const [venue] = await db.select().from(schema.venues).where(eq(schema.venues.id, VENUE_ID));
  if (!venue) return [];

  const result: KrakelingResult = {
    venueId: VENUE_ID, fetched: 0, inserted: 0, occurrencesUpserted: 0, skipped: 0, errors: [],
  };

  const slugs = await discoverSlugs();
  result.fetched = slugs.length;
  if (slugs.length === 0) {
    result.errors.push('geen voorstellingen ontdekt op /programma');
    return [result];
  }

  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  const venueCategory = venue.categories?.[0] ?? 'Theater';

  for (const slug of slugs) {
    try {
      const html = await fetchHtml(`${BASE}/programma/${slug}`);
      if (!html) { result.skipped++; continue; }
      const meta = parseShowPage(html);
      if (!meta) { result.skipped++; continue; }

      const fresh = meta.showtimes.filter((d) => d.getTime() > cutoff);
      if (fresh.length === 0) { result.skipped++; continue; }

      const eventId = `evt-krak-${slug}`;
      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;

      if (!existing) {
        try {
          enriched = await enrichEvent({
            title: meta.title,
            description: meta.description,
            venueName: venue.name,
            venueCategory,
          });
        } catch (e) {
          result.errors.push(`enrich ${meta.title}: ${(e as Error).message}`);
        }

        let imageUrl: string | null = null;
        if (meta.imageUrl) imageUrl = await mirrorImage(meta.imageUrl, slug);

        const eventKind = refineKindByDuration(enriched?.kind ?? 'show', fresh[0], null);

        try {
          await db.insert(schema.events).values({
            id: eventId,
            venueId: VENUE_ID,
            title: meta.title,
            description: enriched?.cleanedDescription ?? meta.description,
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

      const ticketUrl = `${BASE}/programma/${slug}`;
      for (const startsAt of fresh) {
        const isoDate = startsAt.toISOString().slice(0, 10);
        const occurrenceId = `occ-krak-${slug}-${isoDate}`;
        try {
          await db
            .insert(schema.occurrences)
            .values({
              id: occurrenceId,
              eventId,
              startsAt,
              endsAt: null,
              priceCents: null,
              priceNote: existing ? null : (enriched?.priceNote ?? null),
              ticketUrl,
              room: null,
              lineup: existing ? null : (enriched?.lineup ?? null),
              status: 'scheduled',
            })
            .onConflictDoUpdate({
              target: schema.occurrences.id,
              set: { startsAt, ticketUrl },
            });
          result.occurrencesUpserted++;
        } catch (e) {
          result.errors.push(`occurrence ${slug} ${isoDate}: ${(e as Error).message}`);
          result.skipped++;
        }
      }
    } catch (e) {
      result.errors.push(`slug ${slug}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
