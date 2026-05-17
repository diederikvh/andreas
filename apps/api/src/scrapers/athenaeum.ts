import { eq } from 'drizzle-orm';
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Athenaeum | Scheltema — Playwright + stealth scraper voor 3 Amsterdam-
 * filialen die elk een eigen agenda-page hebben op athenaeumscheltema.nl.
 *
 *   - Athenaeum Spui      → /agenda-spui
 *   - Scheltema (Rokin)   → /agenda-scheltema
 *   - Athenaeum Zuidoost  → /agenda-zuidoost
 *
 * De site zit achter Cloudflare managed-challenge — plain `fetch` of
 * headless Playwright zonder stealth geven 403. `playwright-extra` +
 * `puppeteer-extra-plugin-stealth` passeert wel.
 *
 * Per tile (`<a class="news-article-link">`):
 *   - href = `/agenda-{filiaal}/{slug}`
 *   - `<img src="/media/{hash}/{slug}.webp">`
 *   - `<h3>{Title}</h3>`
 *   - `<span>{description-tekst}</span>` met Datum: + Inloop: + Locatie
 *
 * Date-pattern in tekst: `Datum: {DOW} {dag} {NL-maand}` (geen jaar).
 * Time-pattern: `Inloop: {HH.MM} uur`. Year inferentie: huidige jaar
 * tenzij maand < currentMonth → +1.
 *
 * Idempotent: `evt-{venueId}-{slug}`, `occ-{venueId}-{slug}`.
 * Playwright-only — niet in Fly Docker image (zoals OT301, Bimhuis).
 */

const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const BASE = 'https://athenaeumscheltema.nl';

const FILIALEN: Array<{ venueId: string; path: string; prefix: string }> = [
  { venueId: 'athenaeum-spui', path: 'agenda-spui', prefix: 'aths' },
  { venueId: 'scheltema', path: 'agenda-scheltema', prefix: 'scht' },
  { venueId: 'athenaeum-zuidoost', path: 'agenda-zuidoost', prefix: 'athz' },
  { venueId: 'van-rossum', path: 'agenda-van-rossum', prefix: 'vrss' },
];

const NL_MONTHS: Record<string, number> = {
  januari: 0, februari: 1, maart: 2, april: 3, mei: 4, juni: 5,
  juli: 6, augustus: 7, september: 8, oktober: 9, november: 10, december: 11,
  jan: 0, feb: 1, mrt: 2, maa: 2, apr: 3, jun: 5, jul: 6, aug: 7,
  sep: 8, sept: 8, okt: 9, nov: 10, dec: 11,
};

const DEFAULT_HOUR = 19;
const DEFAULT_MINUTE = 0;

chromium.use(stealth());

function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(parseInt(c, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, c) => String.fromCodePoint(parseInt(c, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&#8211;/g, '–').replace(/&#8212;/g, '—')
    .replace(/&#8216;/g, '‘').replace(/&#8217;/g, '’').replace(/&nbsp;/g, ' ');
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function shiftToLocalTime(
  y: number, mo: number, d: number, h: number, mi: number
): Date {
  const tentative = new Date(Date.UTC(y, mo, d, h, mi, 0));
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Amsterdam',
    timeZoneName: 'longOffset',
  });
  const off = dtf.formatToParts(tentative).find((p) => p.type === 'timeZoneName')?.value;
  const m = off?.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  const sign = m && m[1] === '+' ? 1 : -1;
  const oh = m ? parseInt(m[2], 10) : 0;
  const om = m ? parseInt(m[3] ?? '0', 10) : 0;
  return new Date(tentative.getTime() - sign * (oh * 60 + om) * 60_000);
}

/** Parse "Dinsdag 12 mei, 17.00 uur" of "Donderdag 5 juni 2026, 19.30 uur"
 *  → { day, month, hour, minute }. */
function parseEventInfo(
  text: string
): { day: number; month: number; hour: number; minute: number } | null {
  const m = text
    .toLowerCase()
    .trim()
    .match(/^[a-zé]+\s+(\d{1,2})\s+([a-zé]+)(?:\s+\d{4})?,?\s*(\d{1,2})[.:](\d{2})/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = NL_MONTHS[m[2]];
  if (month === undefined) return null;
  const hour = parseInt(m[3], 10);
  const minute = parseInt(m[4], 10);
  return { day, month, hour, minute };
}

type Tile = {
  slug: string;
  url: string;
  title: string;
  eventInfo: string;
  description: string;
  imageSourceUrl: string | null;
};

async function fetchTilesViaStealth(path: string): Promise<Tile[]> {
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({
      locale: 'nl-NL',
      viewport: { width: 1280, height: 800 },
    });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/${path}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    // Wacht extra zodat Cloudflare-challenge afgewerkt is.
    await page.waitForTimeout(4000);
    const html = await page.content();
    return parseTiles(html, path);
  } finally {
    await browser.close();
  }
}

function parseTiles(html: string, agendaPath: string): Tile[] {
  const out: Tile[] = [];
  const seen = new Set<string>();
  // Per `<a class="news-article-link" href="/agenda-{filiaal}/{slug}">…</a>`
  const linkRe = new RegExp(
    `<a class="news-article-link"\\s+href="(/${agendaPath}/([^"#?]+))"[^>]*>([\\s\\S]*?)</a>`,
    'g'
  );
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const slug = m[2];
    if (seen.has(slug)) continue;
    seen.add(slug);
    const inner = m[3];

    // Title in `<div class="news-article-title">{title}</div>`
    const titleMatch = inner.match(
      /<div class="news-article-title[^"]*">([\s\S]*?)<\/div>/
    );
    const title = titleMatch ? decode(stripTags(titleMatch[1])) : '';
    if (!title) continue;

    // Date+time in `<div class="news-article-event-information">{info}</div>`
    const infoMatch = inner.match(
      /<div class="news-article-event-information[^"]*">([\s\S]*?)<\/div>/
    );
    const eventInfo = infoMatch ? decode(stripTags(infoMatch[1])) : '';

    // Description: tekst uit `<span data-text-content="…">` (de full text
    // van het bericht, vóór truncatie). Gestripte HTML.
    const dataMatch = inner.match(
      /data-text-content="([^"]+)"/
    );
    const desc = dataMatch
      ? decode(stripTags(decode(dataMatch[1]))).slice(0, 800)
      : '';

    // Image
    const imgMatch = inner.match(/<img[^>]+src="([^"]+)"/);
    let imageSourceUrl: string | null = null;
    if (imgMatch) {
      const src = imgMatch[1];
      imageSourceUrl = src.startsWith('http') ? src : `${BASE}${src}`;
    }

    out.push({
      slug,
      url: `${BASE}/${agendaPath}/${slug}`,
      title,
      eventInfo,
      description: desc,
      imageSourceUrl,
    });
  }
  return out;
}

async function mirrorImage(
  sourceUrl: string, prefix: string, slug: string
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
    const ext = mime.includes('png') ? 'png'
      : mime.includes('webp') ? 'webp' : 'jpg';
    return await uploadToBunny(`media/events/${prefix}-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[athenaeum] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type AthenaeumResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeAthenaeum(options?: {
  venueIds?: string[];
}): Promise<AthenaeumResult[]> {
  const results: AthenaeumResult[] = [];
  const now = new Date();
  const nowYear = now.getFullYear();
  const nowMonth = now.getMonth();
  const pastCutoff = now.getTime() - 24 * 60 * 60_000;

  for (const filiaal of FILIALEN) {
    if (options?.venueIds && !options.venueIds.includes(filiaal.venueId)) continue;

    const result: AthenaeumResult = {
      venueId: filiaal.venueId,
      fetched: 0, inserted: 0,
      occurrencesUpserted: 0, skipped: 0, errors: [],
    };

    const [venue] = await db
      .select().from(schema.venues)
      .where(eq(schema.venues.id, filiaal.venueId));
    if (!venue) {
      result.errors.push('venue niet in DB');
      results.push(result);
      continue;
    }

    let tiles: Tile[];
    try {
      tiles = await fetchTilesViaStealth(filiaal.path);
    } catch (e) {
      result.errors.push(`fetch failed: ${(e as Error).message}`);
      results.push(result);
      continue;
    }
    result.fetched = tiles.length;

    const venueCategory = venue.categories?.[0] ?? 'Literatuur';

    for (const tile of tiles) {
      try {
        const info = parseEventInfo(tile.eventInfo);
        if (!info) {
          result.skipped++;
          continue;
        }
        const year = info.month < nowMonth ? nowYear + 1 : nowYear;
        const startsAt = shiftToLocalTime(
          year, info.month, info.day, info.hour, info.minute
        );
        if (startsAt.getTime() < pastCutoff) {
          result.skipped++;
          continue;
        }

        const eventId = `evt-${filiaal.prefix}-${tile.slug}`;
        const occurrenceId = `occ-${filiaal.prefix}-${tile.slug}`;
        const ticketUrl = tile.url;

        const [existing] = await db
          .select({ id: schema.events.id })
          .from(schema.events)
          .where(eq(schema.events.id, eventId))
          .limit(1);

        if (existing) {
          await db
            .insert(schema.occurrences)
            .values({
              id: occurrenceId, eventId, startsAt, endsAt: null,
              priceCents: null, priceNote: null, ticketUrl,
              room: null, lineup: null, status: 'scheduled',
            })
            .onConflictDoUpdate({
              target: schema.occurrences.id,
              set: { startsAt, ticketUrl },
            });
          result.occurrencesUpserted++;
          continue;
        }

        const description = tile.description.length > 30
          ? tile.description.slice(0, 800)
          : null;

        const enriched = await enrichEvent({
          title: tile.title,
          description,
          venueName: venue.name,
          venueCategory,
        });

        let imageUrl: string | null = null;
        if (tile.imageSourceUrl) {
          imageUrl = (await mirrorImage(
            tile.imageSourceUrl, filiaal.prefix, tile.slug
          )) ?? tile.imageSourceUrl;
        }

        const refinedKind = refineKindByDuration('show', startsAt, null);

        await db.transaction(async (tx) => {
          await tx.insert(schema.events).values({
            id: eventId, venueId: venue.id, title: tile.title,
            description: enriched.cleanedDescription ?? description,
            kind: refinedKind, imageUrl,
            category: enriched.category ?? venueCategory,
            featured: false, genres: enriched.genres, published: true,
          });
          result.inserted++;

          await tx
            .insert(schema.occurrences)
            .values({
              id: occurrenceId, eventId, startsAt, endsAt: null,
              priceCents: null, priceNote: enriched.priceNote,
              ticketUrl, room: enriched.room, lineup: enriched.lineup,
              status: 'scheduled',
            })
            .onConflictDoUpdate({
              target: schema.occurrences.id,
              set: {
                startsAt, ticketUrl,
                priceNote: enriched.priceNote, room: enriched.room,
                lineup: enriched.lineup,
              },
            });
          result.occurrencesUpserted++;
        });
      } catch (e) {
        result.errors.push(`${tile.slug}: ${(e as Error).message}`);
        result.skipped++;
      }
    }
    results.push(result);
  }
  return results;
}
