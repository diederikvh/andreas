import { eq } from 'drizzle-orm';
import { chromium } from 'playwright';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Thuishaven (mainstream techno-club, NDSM). WooCommerce + WPBakery
 * page-builder. De homepage rendert per event een TICKETS-knop met
 * `https://thuishaven.nl/{dag}-{maand}-{slug}/` URL. Geen JSON-LD,
 * geen og-meta (alleen "Thuishaven" als description), geen agenda-feed.
 *
 * Strategie:
 *  1. Playwright op homepage → harvest event-URLs vanaf TICKETS-CTA's
 *     (we zagen 8+ events in de #agenda sectie)
 *  2. Per event-URL: server-side rendered detail-page met:
 *     - `<title>` "Thuishaven | DD MMM | {Event title}"
 *     - eerste niet-logo wp-content image als hero
 *     - date in URL slug
 *  3. enrichEvent vult genres (techno) en kind (kind=show, club-night)
 *
 * Idempotency:
 *  - eventId      = `evt-th-{urlSlug}`  (URL slug is uniek per night)
 *  - occurrenceId = `occ-th-{urlSlug}`
 *
 * Lokaal-only (Playwright voor homepage; detail-pages zijn server-side
 * en zouden ook met fetch werken).
 */

const VENUE_ID = 'thuishaven';
const UA = 'Mozilla/5.0 (Andreas/1.0)';
const HOME_URL = 'https://thuishaven.nl';

const DUTCH_MONTHS_SHORT: Record<string, number> = {
  jan: 1, januari: 1, feb: 2, februari: 2, mrt: 3, mar: 3, maart: 3,
  apr: 4, april: 4, mei: 5, jun: 6, juni: 6, jul: 7, juli: 7,
  aug: 8, augustus: 8, sep: 9, september: 9, okt: 10, oktober: 10,
  nov: 11, november: 11, dec: 12, december: 12,
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

/** URL slug zoals "09-mei-thuishaven-w-bart-skils-10hrs-tec" → date + slug. */
function parseDateFromUrl(url: string): { date: Date | null; slugTail: string } {
  const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/\/$/, '');
  const slug = path.replace(/^\//, '');
  // Match leading "DD-MMM" of "DD-mmm-..." patterns
  const m = slug.match(/^(\d{1,2})[-_]([a-z]+)/i);
  if (!m) return { date: null, slugTail: slug };
  const day = parseInt(m[1], 10);
  const monthName = m[2].toLowerCase();
  const month = DUTCH_MONTHS_SHORT[monthName] ?? DUTCH_MONTHS_SHORT[monthName.slice(0, 3)];
  if (!month) return { date: null, slugTail: slug };
  const now = new Date();
  for (const y of [now.getFullYear(), now.getFullYear() + 1]) {
    // Default 23:00 voor club-nights
    const d = new Date(`${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T23:00:00+02:00`);
    if (isNaN(d.getTime())) continue;
    const delta = d.getTime() - now.getTime();
    if (delta > -7 * 24 * 60 * 60 * 1000 && delta < 365 * 24 * 60 * 60 * 1000) return { date: d, slugTail: slug };
  }
  return { date: null, slugTail: slug };
}

async function harvestEventUrls(): Promise<string[]> {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();
  try {
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    for (let i = 0; i < 5; i++) {
      await page.evaluate(`window.scrollTo(0, document.body.scrollHeight * ${(i + 1) / 5})`);
      await page.waitForTimeout(600);
    }
    const urls = (await page.evaluate(`(() => {
      const links = Array.from(document.querySelectorAll('a'));
      const out = new Set();
      const re = /^https:\\/\\/thuishaven\\.nl\\/\\d{1,2}-[a-z]+-[a-z][a-z0-9-]+\\/?$/i;
      for (const a of links) {
        const href = a.href || '';
        if (re.test(href)) out.add(href.replace(/\\/$/, '') + '/');
      }
      return Array.from(out);
    })()`)) as string[];
    return urls;
  } finally {
    await browser.close();
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(parseInt(c, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, c) => String.fromCodePoint(parseInt(c, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

type Lineup = Array<{ name: string; role?: 'dj' | 'support' | 'headliner' | 'act' }>;

/** Parseert `.agenda-line-up__line-up` blok:
 *   <h5>LINE-UP</h5>
 *   <p>Bart Skils 10HRS</p>           ← headliner (na LINE-UP h5)
 *   <p><strong>Loods</strong></p>     ← area-header
 *   <ul><li>A-Z</li></ul>
 *   <p>Alexia Glensy<br>BAUGRUPPE90...</p>  ← dj-lijst per area
 *
 * Strategie: split de body op `<p>` tags. Headliner = eerste niet-area
 * `<p>`. DJs = alle namen in `<p>` na een `<strong>` area-header,
 * gesplitst op <br>.
 */
function parseLineup(html: string): Lineup {
  const m = html.match(/<div[^>]+class="[^"]*agenda-line-up__line-up[^"]*"[^>]*>([\s\S]+?)<\/div>\s*<\/div>/);
  if (!m) return [];
  const block = m[1];
  // Split paragraphs preserving area-headers
  const ps = Array.from(block.matchAll(/<p[^>]*>([\s\S]+?)<\/p>/g)).map((m) => m[1]);
  const out: Lineup = [];
  let firstActSeen = false;
  for (const raw of ps) {
    // Strip area-headers (<strong>X</strong>) — die nemen we niet als artist
    if (/<strong>[\s\S]+?<\/strong>/.test(raw) && !/<br/i.test(raw)) continue;
    // Multiple names separated by <br>
    const names = raw
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .split('\n')
      .map((n) => decodeEntities(n).trim())
      .filter((n) => n && n.length > 1 && n !== '&nbsp;' && !/^A-Z$/.test(n));
    for (const name of names) {
      out.push({
        name,
        role: !firstActSeen ? 'headliner' : 'dj',
      });
      firstActSeen = true;
    }
  }
  return out.slice(0, 30);
}

async function fetchDetailMeta(url: string): Promise<{
  title: string;
  description: string | null;
  imageUrl: string | null;
  lineup: Lineup;
} | null> {
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const html = await r.text();
    const titleM = html.match(/<title[^>]*>([\s\S]+?)<\/title>/);
    const fullTitle = decodeEntities((titleM?.[1] ?? '').trim());
    // "Thuishaven | 09 MEI | Thuishaven w/ Bart Skils 10HRS"
    const parts = fullTitle.split(/\s*\|\s*/).map((s) => s.trim()).filter(Boolean);
    const title = parts.length >= 3 ? parts.slice(2).join(' | ') : (parts[parts.length - 1] ?? fullTitle);
    if (!title || title.length < 3) return null;
    const imgMatches = Array.from(html.matchAll(/<img[^>]+src="([^"]+\.(?:jpg|jpeg|png|webp))"/gi)).map((m) => m[1]);
    const imageUrl = imgMatches.find((u) => !/logo|avatar|sprite|icon/i.test(u)) ?? null;
    const descM = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
    const rawDesc = descM?.[1] ?? null;
    const description = rawDesc && rawDesc !== 'Thuishaven' && rawDesc.length > 30 ? decodeEntities(rawDesc) : null;
    const lineup = parseLineup(html);
    return { title, description, imageUrl, lineup };
  } catch {
    return null;
  }
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
    return await uploadToBunny(`media/events/thh-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[thuishaven] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type ThuishavenResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeThuishaven(options?: {
  venueIds?: string[];
}): Promise<ThuishavenResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: ThuishavenResult = {
    venueId: VENUE_ID, fetched: 0, inserted: 0, occurrencesUpserted: 0, skipped: 0, errors: [],
  };

  const [venue] = await db.select().from(schema.venues).where(eq(schema.venues.id, VENUE_ID));
  if (!venue) {
    result.errors.push('venue niet in DB');
    return [result];
  }
  const venueCategory = venue.categories?.[0] ?? 'Muziek';

  let urls: string[];
  try {
    urls = await harvestEventUrls();
  } catch (e) {
    result.errors.push(`harvest: ${(e as Error).message}`);
    return [result];
  }
  result.fetched = urls.length;
  if (urls.length === 0) {
    result.errors.push('geen event-URLs op homepage');
    return [result];
  }

  const cutoff = Date.now() - 6 * 60 * 60 * 1000;

  for (const url of urls) {
    try {
      const { date, slugTail } = parseDateFromUrl(url);
      if (!date || date.getTime() < cutoff) { result.skipped++; continue; }
      const eventId = `evt-thh-${slugify(slugTail)}`;
      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;
      let imageUrl: string | null = null;
      let description: string | null = null;
      let title: string | null = null;
      let lineup: Lineup = [];

      if (!existing) {
        const meta = await fetchDetailMeta(url);
        if (!meta) { result.skipped++; continue; }
        title = meta.title;
        description = meta.description;
        lineup = meta.lineup;
        if (meta.imageUrl) {
          imageUrl = (await mirrorImage(meta.imageUrl, slugify(slugTail))) ?? meta.imageUrl;
        }

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

        const eventKind = refineKindByDuration(enriched?.kind ?? 'show', date, null);
        const baseGenres = enriched?.genres ?? [];
        const finalGenres = baseGenres.length > 0 ? baseGenres : ['techno'];

        try {
          await db.insert(schema.events).values({
            id: eventId,
            venueId: venue.id,
            title,
            description: enriched?.cleanedDescription ?? description,
            kind: eventKind,
            imageUrl,
            category: enriched?.category ?? venueCategory,
            featured: false,
            genres: finalGenres,
            published: true,
          });
          result.inserted++;
        } catch (e) {
          result.errors.push(`insert event ${eventId}: ${(e as Error).message}`);
          continue;
        }
      }

      try {
        const occurrenceId = `occ-thh-${slugify(slugTail)}`;
        // Combineer detail-page lineup met enrichEvent-lineup (voor
        // existing events vallen we terug op enrich, niet refetchen).
        const finalLineup = lineup.length > 0 ? lineup : (existing ? null : (enriched?.lineup ?? null));
        await db
          .insert(schema.occurrences)
          .values({
            id: occurrenceId,
            eventId,
            startsAt: date,
            endsAt: null,
            priceCents: null,
            priceNote: existing ? null : (enriched?.priceNote ?? null),
            ticketUrl: url,
            room: null,
            lineup: finalLineup,
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: { startsAt: date, ticketUrl: url, lineup: finalLineup ?? undefined },
          });
        result.occurrencesUpserted++;
      } catch (e) {
        result.errors.push(`occurrence ${url}: ${(e as Error).message}`);
        result.skipped++;
      }
    } catch (e) {
      result.errors.push(`event ${url}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
