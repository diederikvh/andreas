/**
 * Het Ketelhuis scraper.
 *
 * Westergasfabriek, hét NL-film-podium. Hun /agenda/ rendert pas
 * client-side — we gebruiken Playwright (lokaal, niet in Fly
 * Dockerfile) om de pagina's te renderen.
 *
 * Plan:
 *   1. Open /films/ → 30+ film-URLs.
 *   2. Per film: JSON-LD met
 *      - 1× MovieTheater (skip)
 *      - 1× Event array met alle screenings (datetime + ticket URL)
 *      - 1× Movie/Article met description (uit `p` op page).
 *   3. Cross-venue dedup op (title, category='Film', kind='show').
 *   4. Occurrence-id = `ketelhuis-show-{ticketing-id}` (zelfde
 *      ticketing-platform als Kriterion: tickets.{venue}.nl/.../show/{id}).
 *
 * Title-cleaning: Ketelhuis suffixed soms met "(NL)" of " | 40th
 * Anniversary"-achtige labels. Voor cross-venue dedup houden we de
 * volledige titel — dat is wat de venue zelf vertoont, en die
 * onderscheidende info hoort erbij ("Top Gun | 40th Anniversary"
 * is een ander event dan de gewone "Top Gun").
 */

import { randomBytes } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';

const FILMS_INDEX_URL = 'https://www.ketelhuis.nl/films/';
const VENUE_ID = 'ketelhuis';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';

export interface KetelhuisResult {
  venueId: 'ketelhuis';
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
}

interface EventLd {
  '@type': string;
  name: string;
  description?: string;
  image?: string;
  startDate?: string;
  /** Ketelhuis zet de film-pagina-URL in `url` en de ticket-URL onder
      `offers.url`. We pakken offers.url. */
  url?: string;
  offers?: {
    url?: string;
    price?: string | number;
    priceCurrency?: string;
  };
}

export async function scrapeKetelhuis(): Promise<KetelhuisResult[]> {
  const result: KetelhuisResult = {
    venueId: 'ketelhuis',
    fetched: 0,
    inserted: 0,
    occurrencesUpserted: 0,
    skipped: 0,
    errors: [],
  };

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ userAgent: UA, locale: 'nl-NL' });
    const page = await ctx.newPage();

    // Stap 1: alle film-URLs.
    await page.goto(FILMS_INDEX_URL, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    await page.waitForTimeout(2000);
    const filmUrls = (await page.evaluate(`(() => {
      const links = [...document.querySelectorAll('a[href*="/films/"]')]
        .map((a) => a.getAttribute('href'))
        .filter((h) => Boolean(h && /\\/films\\/[^/]+\\/?$/.test(h)));
      return [...new Set(links)];
    })()`)) as string[];

    const now = Date.now();
    for (const filmUrl of filmUrls) {
      try {
        await page.goto(filmUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        await page.waitForTimeout(800);
        result.fetched += 1;

        const data = (await page.evaluate(`(() => {
          const blocks = [
            ...document.querySelectorAll('script[type="application/ld+json"]'),
          ]
            .map((s) => s.textContent ?? '')
            .filter(Boolean);
          const ogImage =
            document
              .querySelector('meta[property="og:image"]')
              ?.getAttribute('content') ?? null;
          const titleH1 = document.querySelector('h1')?.textContent?.trim() ?? null;
          const descP =
            document
              .querySelector('.single-film p, main p, article p')
              ?.textContent?.trim() ?? null;
          return { blocks, ogImage, titleH1, descP };
        })()`)) as {
          blocks: string[];
          ogImage: string | null;
          titleH1: string | null;
          descP: string | null;
        };

        // Parse alle Event-items uit JSON-LD; ze hebben name (filmtitel),
        // startDate (ISO), description, image. Verzamel uniques per
        // ticket-show-id zodat dezelfde voorstelling niet dubbel telt.
        const events: EventLd[] = [];
        for (const raw of data.blocks) {
          try {
            const parsed = JSON.parse(raw);
            const items = Array.isArray(parsed) ? parsed : [parsed];
            for (const it of items) {
              if (
                it &&
                typeof it === 'object' &&
                (it as { '@type'?: string })['@type'] === 'Event'
              ) {
                events.push(it as EventLd);
              }
            }
          } catch {
            /* skip */
          }
        }

        if (events.length === 0) {
          result.skipped += 1;
          continue;
        }

        const title =
          events[0].name?.trim() ||
          data.titleH1?.trim() ||
          '';
        if (!title) {
          result.skipped += 1;
          continue;
        }
        const description =
          events[0].description?.trim() || data.descP || null;
        const imageUrl = events[0].image?.trim() || data.ogImage || null;

        // Filter op toekomstige screenings.
        const future = events.filter((e) => {
          if (!e.startDate) return false;
          const t = new Date(fixIsoTimezone(e.startDate)).getTime();
          return Number.isFinite(t) && t >= now;
        });
        if (future.length === 0) {
          result.skipped += 1;
          continue;
        }

        // Cross-venue dedup.
        const [existing] = await db
          .select({
            id: schema.events.id,
            description: schema.events.description,
            imageUrl: schema.events.imageUrl,
          })
          .from(schema.events)
          .where(
            and(
              eq(schema.events.title, title),
              eq(schema.events.category, 'Film'),
              eq(schema.events.kind, 'show')
            )
          )
          .limit(1);

        let eventId: string;
        if (existing) {
          eventId = existing.id;
          const patch: Record<string, string> = {};
          if (!existing.description && description) {
            patch.description = description;
          }
          if (
            imageUrl &&
            (!existing.imageUrl ||
              /wiki(p|m)edia\.org/.test(existing.imageUrl))
          ) {
            patch.imageUrl = imageUrl;
          }
          if (Object.keys(patch).length > 0) {
            await db
              .update(schema.events)
              .set(patch)
              .where(eq(schema.events.id, eventId));
          }
        } else {
          eventId = `film-${slugify(title)}-${randomBytes(3).toString('hex')}`;
          await db.insert(schema.events).values({
            id: eventId,
            venueId: VENUE_ID,
            title,
            description,
            kind: 'show',
            imageUrl,
            category: 'Film',
          });
          result.inserted += 1;
        }

        // Dedup per ticket-show-id zodat Ketelhuis' meerdere JSON-LD
        // entries voor dezelfde voorstelling niet leiden tot dubbele
        // occurrence-upserts.
        const seenShowIds = new Set<string>();
        for (const e of future) {
          const ticketUrl = e.offers?.url ?? null;
          const showId = parseShowId(ticketUrl ?? undefined);
          if (!showId || seenShowIds.has(showId)) continue;
          seenShowIds.add(showId);
          const occId = `ketelhuis-show-${showId}`;
          const startsAt = new Date(fixIsoTimezone(e.startDate!));
          if (Number.isNaN(startsAt.getTime())) continue;
          const priceCents =
            e.offers?.price != null
              ? Math.round(parseFloat(String(e.offers.price)) * 100)
              : null;

          const [existingOcc] = await db
            .select({ id: schema.occurrences.id })
            .from(schema.occurrences)
            .where(eq(schema.occurrences.id, occId))
            .limit(1);

          if (existingOcc) {
            await db
              .update(schema.occurrences)
              .set({
                startsAt,
                ticketUrl,
                priceCents: priceCents,
                venueId: VENUE_ID,
                eventId,
              })
              .where(eq(schema.occurrences.id, occId));
          } else {
            await db.insert(schema.occurrences).values({
              id: occId,
              eventId,
              venueId: VENUE_ID,
              startsAt,
              priceCents,
              ticketUrl,
              status: 'scheduled',
            });
          }
          result.occurrencesUpserted += 1;
        }
      } catch (e) {
        result.errors.push(
          `${filmUrl}: ${(e as Error).message ?? String(e)}`
        );
      }
    }
  } finally {
    await browser.close();
  }

  return [result];
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** Ketelhuis schrijft soms `+1:00` i.p.v. `+01:00` — JS Date faalt dan. */
function fixIsoTimezone(s: string): string {
  return s.replace(/([+-])(\d):(\d{2})$/, (_, sign, h, m) => `${sign}0${h}:${m}`);
}

function parseShowId(url?: string): string | null {
  if (!url) return null;
  const m = url.match(/\/show\/(\d+)/);
  return m ? m[1] : null;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}
