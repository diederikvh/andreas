import { createHash } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Muziekgebouw aan 't IJ scraper. Hun /nl/agenda is een SPA op het
 * "Peppered" CMS van CultureSuite. Pagination via ?page=N. Per
 * event-card extracten we titel/datum/tijd/zaal/image; voor nieuwe
 * events fetchen we de detail-pagina voor de rijke description in
 * <div class="richtext">.
 *
 * Title-grouping: Muziekgebouw geeft dezelfde productie op verschillende
 * dates UNIEKE slugs (bv. "Birdsong" → birdsong-16xq + birdsong-ltqs).
 * Voor user-experience groeperen we op genormaliseerde titel: 1
 * event-record per productie, N occurrences (één per slug/date).
 *
 * Idempotency: event-id = sha256(genormaliseerde titel). Occurrence-id
 * = sha256(title + slug) want de slug is stabiel per voorstelling.
 */

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

function normalizeTitle(title: string, subtitle?: string | null): string {
  const full = subtitle ? `${title} — ${subtitle}` : title;
  return full.toLowerCase().replace(/\s+/g, ' ').trim();
}

const VENUE_ID = 'muziekgebouw-aan-t-ij';
const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const BASE = 'https://www.muziekgebouw.nl';

const NL_MONTHS_SHORT: Record<string, number> = {
  jan: 0, feb: 1, mrt: 2, apr: 3, mei: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, okt: 9, nov: 10, dec: 11,
};

type AgendaCard = {
  title: string;
  subtitle: string | null;
  startsAtIso: string;
  href: string;
  imageUrl: string | null;
  room: string | null;
  tagline: string | null;
};

/** "vr 8 mei 2026" + "20:15" → ISO datetime (lokaal Europe/Amsterdam). */
function parseDateTime(dateText: string, timeText: string | null): Date | null {
  // dateText: "vr 8 mei 2026" of "ma 12 januari 2027"
  const m = dateText.match(/\b(\d{1,2})\s+(jan|feb|mrt|apr|mei|jun|jul|aug|sep|okt|nov|dec)[a-z]*\s+(\d{4})\b/i);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = NL_MONTHS_SHORT[m[2].toLowerCase().slice(0, 3)];
  const year = parseInt(m[3], 10);

  let hour = 20;
  let minute = 0;
  if (timeText) {
    const tm = timeText.match(/(\d{1,2}):(\d{2})/);
    if (tm) {
      hour = parseInt(tm[1], 10);
      minute = parseInt(tm[2], 10);
    }
  }

  return shiftToLocalTime(year, month, day, hour, minute);
}

function shiftToLocalTime(y: number, mo: number, d: number, h: number, mi: number): Date {
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

/** Render één agenda-pagina via Playwright en pak alle event-cards.
 *  Pagination via ?page=N URL param (standaard Peppered/CultureSuite). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAgendaPage(browser: any, pageNum: number): Promise<{
  cards: AgendaCard[];
  hasNext: boolean;
}> {
  const ctx = await browser.newContext({ locale: 'nl-NL', userAgent: UA });
  const page = await ctx.newPage();
  try {
    const url = pageNum === 1 ? `${BASE}/nl/agenda` : `${BASE}/nl/agenda?page=${pageNum}`;
    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    // Wacht tot eventCards renderen of tot 5 sec (mogelijk leeg)
    try {
      await page.waitForSelector('li.eventCard', { timeout: 5000 });
    } catch {
      return { cards: [], hasNext: false };
    }
    await page.waitForTimeout(1000);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: { cards: AgendaCard[]; hasNext: boolean } = await page.evaluate(`(function(){
      var cards = Array.from(document.querySelectorAll('li.eventCard')).map(function(c){
        var title = c.querySelector('.title');
        var sub = c.querySelector('.subtitle');
        var date = c.querySelector('.start');
        var time = c.querySelector('.time');
        var venue = c.querySelector('.venue');
        var tagline = c.querySelector('.tagline');
        var link = c.querySelector('a.desc');
        var img = c.querySelector('img');
        return {
          title: title ? title.textContent.trim() : null,
          subtitle: sub ? sub.textContent.trim() : null,
          dateText: date ? date.textContent.trim() : null,
          timeText: time ? time.textContent.trim() : null,
          room: venue ? venue.textContent.trim() : null,
          tagline: tagline ? tagline.textContent.replace(/\\s+/g,' ').trim() : null,
          href: link ? link.getAttribute('href') : null,
          imageUrl: img ? img.getAttribute('src') : null,
        };
      });
      var hasNext = !!document.querySelector('a.btn.next, a.next.btn');
      return { cards: cards, hasNext: hasNext };
    })()`);

    const cards: AgendaCard[] = [];
    for (const c of result.cards) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw: any = c;
      if (!raw.title || !raw.dateText || !raw.href) continue;
      const startsAt = parseDateTime(raw.dateText, raw.timeText);
      if (!startsAt) continue;
      cards.push({
        title: raw.title,
        subtitle: raw.subtitle ?? null,
        startsAtIso: startsAt.toISOString(),
        href: raw.href,
        imageUrl: raw.imageUrl ?? null,
        room: raw.room ?? null,
        tagline: raw.tagline ?? null,
      });
    }
    return { cards, hasNext: result.hasNext };
  } finally {
    await ctx.close();
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

/** Pak rijke description uit `<div class="richtext">` block. */
function extractRichDescription(html: string): string | null {
  // Greedy match tot de bekende afsluiter (metaWrapper of einde)
  const m = html.match(/<div[^>]*class="[^"]*richtext[^"]*"[^>]*>([\s\S]+?)<\/div>\s*<\/div>/);
  if (!m) return null;
  let body = m[1]
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&euml;/g, 'ë')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return body || null;
}

function extractOg(html: string, prop: string): string | null {
  const re = new RegExp(`<meta\\s+property="og:${prop}"\\s+content="([^"]+)"`, 'i');
  const m = html.match(re);
  return m ? m[1] : null;
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
    return await uploadToBunny(`media/events/mg-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[muziekgebouw] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type MuziekgebouwResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeMuziekgebouw(options?: {
  venueIds?: string[];
}): Promise<MuziekgebouwResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: MuziekgebouwResult = {
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

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });

  try {
    // Paginate via ?page=N URL param. Stop wanneer geen "Volgende"
    // knop meer of geen nieuwe slugs (cycle-detectie als safety).
    const seenSlugs = new Set<string>();
    const allCards: AgendaCard[] = [];

    for (let pageNum = 1; pageNum <= 30; pageNum++) {
      const { cards, hasNext } = await fetchAgendaPage(browser, pageNum);
      if (cards.length === 0) break;
      let newInBatch = 0;
      for (const c of cards) {
        const slug = c.href.match(/\/nl\/agenda\/([^/?]+)/)?.[1];
        if (!slug || seenSlugs.has(slug)) continue;
        seenSlugs.add(slug);
        allCards.push(c);
        newInBatch++;
      }
      if (newInBatch === 0 || !hasNext) break;
    }

    result.fetched = allCards.length;
    const venueCategory = venue.categories?.[0] ?? 'Muziek';

    // Title-grouping: dezelfde productie op meerdere dates krijgt
    // unieke slugs van Muziekgebouw maar identieke titel+subtitle.
    // Groepeer op genormaliseerde titel; 1 event-record per groep, N
    // occurrences (één per slug/date).
    const groups = new Map<string, AgendaCard[]>();
    for (const c of allCards) {
      const key = normalizeTitle(c.title, c.subtitle);
      const arr = groups.get(key) ?? [];
      arr.push(c);
      groups.set(key, arr);
    }

    for (const [normalizedTitle, instances] of groups) {
      instances.sort(
        (a, b) => new Date(a.startsAtIso).getTime() - new Date(b.startsAtIso).getTime()
      );
      const first = instances[0];
      const groupHash = shortHash(`mg|${normalizedTitle}`);
      const eventId = `evt-mg-${VENUE_ID}-${groupHash}`;

      try {
        // Existing-check: skip dure detail-fetch + Claude voor
        // bestaande events. Per instance wel occurrence upserten.
        const [existing] = await db
          .select({ id: schema.events.id })
          .from(schema.events)
          .where(eq(schema.events.id, eventId))
          .limit(1);

        if (existing) {
          for (const inst of instances) {
            const slug = inst.href.match(/\/nl\/agenda\/([^/?]+)/)?.[1] ?? '';
            const occurrenceId = `occ-mg-${VENUE_ID}-${shortHash(`${normalizedTitle}|${slug}`)}`;
            const startsAt = new Date(inst.startsAtIso);
            const detailUrl = inst.href.startsWith('http') ? inst.href : `${BASE}${inst.href}`;
            await db
              .insert(schema.occurrences)
              .values({
                id: occurrenceId,
                eventId,
                startsAt,
                endsAt: null,
                priceCents: null,
                priceNote: null,
                ticketUrl: detailUrl,
                room: inst.room,
                lineup: null,
                status: 'scheduled',
              })
              .onConflictDoUpdate({
                target: schema.occurrences.id,
                set: { startsAt, ticketUrl: detailUrl, room: inst.room },
              });
            result.occurrencesUpserted++;
          }
          continue;
        }

        // Nieuw event — fetch detail-pagina (van eerste instance) voor
        // rich description + Claude enrich.
        const firstSlug = first.href.match(/\/nl\/agenda\/([^/?]+)/)?.[1] ?? groupHash;
        const detailUrl = first.href.startsWith('http') ? first.href : `${BASE}${first.href}`;
        const detailHtml = await fetchHtml(detailUrl);
        const richDesc = detailHtml ? extractRichDescription(detailHtml) : null;
        const ogDesc = detailHtml ? extractOg(detailHtml, 'description') : null;
        const description = richDesc ?? ogDesc ?? first.tagline;

        const enriched = await enrichEvent({
          title: first.title,
          description,
          venueName: venue.name,
          venueCategory,
        });

        let imageUrl: string | null = null;
        if (first.imageUrl) {
          imageUrl = (await mirrorImage(first.imageUrl, firstSlug)) ?? first.imageUrl;
        }

        const startsAt = new Date(first.startsAtIso);
        const refinedKind = refineKindByDuration(enriched.kind, startsAt, null);
        const fullTitle = first.subtitle ? `${first.title} — ${first.subtitle}` : first.title;

        await db.transaction(async (tx) => {
          await tx.insert(schema.events).values({
            id: eventId,
            venueId: venue.id,
            title: fullTitle,
            description: enriched.cleanedDescription ?? description,
            kind: refinedKind,
            imageUrl,
            category: enriched.category ?? venueCategory,
            featured: false,
            genres: enriched.genres,
            published: true,
          });
          result.inserted++;

          for (const inst of instances) {
            const slug = inst.href.match(/\/nl\/agenda\/([^/?]+)/)?.[1] ?? '';
            const occurrenceId = `occ-mg-${VENUE_ID}-${shortHash(`${normalizedTitle}|${slug}`)}`;
            const instStarts = new Date(inst.startsAtIso);
            const instUrl = inst.href.startsWith('http') ? inst.href : `${BASE}${inst.href}`;
            await tx
              .insert(schema.occurrences)
              .values({
                id: occurrenceId,
                eventId,
                startsAt: instStarts,
                endsAt: null,
                priceCents: null,
                priceNote: enriched.priceNote,
                ticketUrl: instUrl,
                room: inst.room ?? enriched.room,
                lineup: enriched.lineup,
                status: 'scheduled',
              })
              .onConflictDoUpdate({
                target: schema.occurrences.id,
                set: {
                  startsAt: instStarts,
                  priceNote: enriched.priceNote,
                  ticketUrl: instUrl,
                  room: inst.room ?? enriched.room,
                  lineup: enriched.lineup,
                },
              });
            result.occurrencesUpserted++;
          }
        });
      } catch (e) {
        result.errors.push(`group ${normalizedTitle}: ${(e as Error).message}`);
        result.skipped++;
      }
    }
  } finally {
    await browser.close();
  }

  return [result];
}
