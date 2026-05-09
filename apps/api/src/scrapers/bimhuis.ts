import { eq } from 'drizzle-orm';
import { chromium, type Browser } from 'playwright';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Bimhuis (jazz, dagelijks). Calendar is een Next.js App Router page
 * die ~40 tiles SSR-rendert voor de komende ~30 dagen — geen sitemap
 * met show-URLs, geen JSON-LD per detail-page, geen API-call. We doen
 * dus Playwright op `/en/calendar/`, pluk per `time.agenda-tile__dates`
 * tile {date, time, title, href}, en groeperen op title.
 *
 * Title-grouping (geleerd van Concertgebouw + Carré + TM):
 *  - Bimhuis hergeeft dezelfde show vaak met `-N` URL-suffix als matinee
 *    of avond op dezelfde dag (`john-scofield-gerald-clayton-duo` +
 *    `john-scofield-gerald-clayton-duo-3`). De `<h3>` titel is identiek.
 *  - Daarom: eventId = `evt-bm-${slugify(title)}` (title-based, niet
 *    URL-based) zodat alle varianten naar één event-row mergen.
 *  - Per occurrence: `(date + time)` is uniek — matinee 15:30 en avond
 *    20:30 zijn 2 occurrences van hetzelfde event.
 *
 * Description + image komen niet uit de tile maar uit detail-page
 * `og:title`/`og:description`/`og:image`. Per nieuw event één extra
 * fetch — daarna existing-check skipt dat.
 */

const VENUE_ID = 'bimhuis';
const UA = 'Mozilla/5.0 (Andreas/1.0; +https://andreas.amsterdam)';
const CALENDAR_URL = 'https://www.bimhuis.nl/en/calendar/';

type Tile = {
  date: string;     // YYYY-MM-DD
  time: string;     // HH:MM
  title: string;
  href: string;
};

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

async function fetchTiles(browser: Browser): Promise<Tile[]> {
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();
  try {
    await page.goto(CALENDAR_URL, { waitUntil: 'networkidle', timeout: 30000 });
    // String-based evaluate vermijdt DOM-type issues in TS strict mode
    // (zoals melkweg.ts en muziekgebouw.ts ook doen).
    const tiles = (await page.evaluate(`(() => {
      const out = [];
      const times = Array.from(document.querySelectorAll('time.agenda-tile__dates'));
      for (const t of times) {
        const date = t.getAttribute('datetime') || '';
        const span = t.querySelector('span');
        const time = (span && span.textContent ? span.textContent.trim() : '');
        let container = t;
        while (container && !container.querySelector('a.agenda-tile__link')) {
          container = container.parentElement;
        }
        const link = container ? container.querySelector('a.agenda-tile__link') : null;
        const h3 = link ? link.querySelector('h3') : null;
        const title = h3 && h3.textContent ? h3.textContent.trim() : '';
        const href = link ? link.href : '';
        if (date && title && href) out.push({ date: date, time: time, title: title, href: href });
      }
      return out;
    })()`)) as Tile[];
    return tiles;
  } finally {
    await ctx.close();
  }
}

type DetailMeta = { description: string | null; imageUrl: string | null };

async function fetchDetail(href: string): Promise<DetailMeta> {
  try {
    const r = await fetch(href, { headers: { 'user-agent': UA } });
    if (!r.ok) return { description: null, imageUrl: null };
    const html = await r.text();
    const desc = html.match(/<meta property="og:description" content="([^"]+)"/)?.[1] ?? null;
    const img = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1] ?? null;
    return {
      description: desc ? desc.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'") : null,
      imageUrl: img,
    };
  } catch {
    return { description: null, imageUrl: null };
  }
}

async function mirrorImage(sourceUrl: string, slug: string): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 8 * 1024 * 1024) return null;
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    return await uploadToBunny(`media/events/bm-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[bimhuis] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type BimhuisResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeBimhuis(options?: {
  venueIds?: string[];
}): Promise<BimhuisResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: BimhuisResult = {
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
  const venueCategory = venue.categories?.[0] ?? 'Muziek';

  const browser = await chromium.launch();
  let tiles: Tile[];
  try {
    tiles = await fetchTiles(browser);
  } catch (e) {
    result.errors.push(`fetch tiles: ${(e as Error).message}`);
    await browser.close();
    return [result];
  } finally {
    // browser blijft open tot na alle fetches als Playwright nodig is
  }
  await browser.close();

  result.fetched = tiles.length;
  if (tiles.length === 0) {
    result.errors.push('geen tiles ontdekt');
    return [result];
  }

  // Dedup tiles op (title, date, time) — Bimhuis rendert tiles soms
  // dubbel op de same agenda page (zien we in probe).
  const seen = new Set<string>();
  const unique: Tile[] = [];
  for (const t of tiles) {
    const key = `${t.title.toLowerCase()}__${t.date}__${t.time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(t);
  }

  // Group on title — multiple tiles met dezelfde titel = matinee+avond
  // of meerdere dagen. Eén event-row, N occurrences.
  type Group = { title: string; href: string; tiles: Tile[] };
  const groups = new Map<string, Group>();
  for (const t of unique) {
    const titleSlug = slugify(t.title);
    if (!titleSlug) continue;
    const existing = groups.get(titleSlug);
    if (existing) {
      existing.tiles.push(t);
    } else {
      groups.set(titleSlug, { title: t.title, href: t.href, tiles: [t] });
    }
  }

  const cutoff = Date.now() - 6 * 60 * 60 * 1000;

  for (const [titleSlug, group] of groups) {
    try {
      const eventId = `evt-bm-${titleSlug}`;
      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      // Sort tiles op datum+tijd voor de "head" reference
      group.tiles.sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
      const head = group.tiles[0];

      let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;
      let imageUrl: string | null = null;
      let description: string | null = null;

      if (!existing) {
        const detail = await fetchDetail(head.href);
        description = detail.description;
        if (detail.imageUrl) {
          imageUrl = (await mirrorImage(detail.imageUrl, titleSlug)) ?? detail.imageUrl;
        }
        try {
          enriched = await enrichEvent({
            title: group.title,
            description,
            venueName: venue.name,
            venueCategory,
          });
        } catch (e) {
          result.errors.push(`enrich ${group.title}: ${(e as Error).message}`);
        }

        const headStart = new Date(`${head.date}T${head.time || '20:30'}:00+02:00`);
        const eventKind = refineKindByDuration(enriched?.kind ?? 'show', headStart, null);

        try {
          await db.insert(schema.events).values({
            id: eventId,
            venueId: venue.id,
            title: group.title,
            description: enriched?.cleanedDescription ?? description,
            kind: eventKind,
            imageUrl,
            category: enriched?.category ?? venueCategory,
            featured: false,
            genres: enriched?.genres ?? ['jazz'],
            published: true,
          });
          result.inserted++;
        } catch (e) {
          result.errors.push(`insert event ${eventId}: ${(e as Error).message}`);
          continue;
        }
      }

      // Occurrences upsert
      for (const t of group.tiles) {
        try {
          const startsAt = new Date(`${t.date}T${t.time || '20:30'}:00+02:00`);
          if (isNaN(startsAt.getTime())) { result.skipped++; continue; }
          if (startsAt.getTime() < cutoff) { result.skipped++; continue; }

          const isoSlot = `${t.date}T${(t.time || '20-30').replace(':', '-')}`;
          const occurrenceId = `occ-bm-${titleSlug}-${isoSlot}`;

          await db
            .insert(schema.occurrences)
            .values({
              id: occurrenceId,
              eventId,
              startsAt,
              endsAt: null,
              priceCents: null,
              priceNote: existing ? null : (enriched?.priceNote ?? null),
              ticketUrl: t.href,
              room: null,
              lineup: existing ? null : (enriched?.lineup ?? null),
              status: 'scheduled',
            })
            .onConflictDoUpdate({
              target: schema.occurrences.id,
              set: { startsAt, ticketUrl: t.href },
            });
          result.occurrencesUpserted++;
        } catch (e) {
          result.errors.push(`occurrence ${t.href}: ${(e as Error).message}`);
          result.skipped++;
        }
      }
    } catch (e) {
      result.errors.push(`group ${group.title}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
