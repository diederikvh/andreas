import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * WP Theatre scraper. Voor venues die de WordPress-plugin "WP Theatre"
 * gebruiken (Podium DE FLUX, en mogelijk meer Nederlandse podia later).
 * De plugin renderd events op `/event/{slug}/` met een vast Yoast-block
 * + body-conventie:
 *   "Datum 8 mei 2026   Voorverkoop € 18,50   Deur € 21,00
 *    Locatie De Kade   Zaal open 20:00   Aanvang 20:30"
 *
 * Strategie:
 *   1. Scrape de agenda-pagina (paginated of niet) → unieke
 *      `/event/{slug}/` URLs.
 *   2. Per event-URL: platte fetch (geen Playwright nodig, server-side
 *      gerenderd HTML), parse OG-meta + body voor datum/tijd/prijs/
 *      beschrijving.
 *
 * Idempotency: event-id = `evt-wpt-{venueId}-{slug}`. Slug uit URL is
 * stabiel zolang de venue 'em niet hernoemt.
 *
 * Config: `venues.scraperConfig.wpTheatre = { agendaUrl: '...' }`.
 */

const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';

const NL_MONTHS: Record<string, number> = {
  januari: 0, februari: 1, maart: 2, april: 3, mei: 4, juni: 5,
  juli: 6, augustus: 7, september: 8, oktober: 9, november: 10, december: 11,
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(parseInt(c, 10)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

function extractOg(html: string, prop: string): string | null {
  const re = new RegExp(
    `<meta\\s+property="og:${prop}"\\s+content="([^"]+)"`,
    'i'
  );
  const m = html.match(re);
  return m ? decodeEntities(m[1]) : null;
}

function parseDutchDate(text: string | null): { y: number; m: number; d: number } | null {
  if (!text) return null;
  const m = text.match(/\b(\d{1,2})\s+(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)\s+(\d{4})\b/i);
  if (!m) return null;
  return {
    y: parseInt(m[3], 10),
    m: NL_MONTHS[m[2].toLowerCase()],
    d: parseInt(m[1], 10),
  };
}

function parseTime(text: string | null, label: 'Aanvang' | 'Zaal open'): { h: number; m: number } | null {
  if (!text) return null;
  const re = new RegExp(`${label}\\s*[:\\s]?\\s*(\\d{1,2})[:.](\\d{2})`, 'i');
  const m = text.match(re);
  if (!m) return null;
  return { h: parseInt(m[1], 10), m: parseInt(m[2], 10) };
}

function parsePriceCents(text: string | null, label: 'Voorverkoop' | 'Deur'): number | null {
  if (!text) return null;
  const re = new RegExp(`${label}\\s*€?\\s*(\\d+(?:[,.]\\d{2})?)`, 'i');
  const m = text.match(re);
  if (!m) return null;
  const v = parseFloat(m[1].replace(',', '.'));
  if (isNaN(v)) return null;
  return Math.round(v * 100);
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

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

async function discoverEventUrls(agendaUrl: string): Promise<string[]> {
  const html = await fetchHtml(agendaUrl);
  if (!html) return [];
  const re = /href="(https?:\/\/[^"]*\/event\/[a-z0-9-]+\/?)"/gi;
  const urls = new Set<string>();
  for (const m of html.matchAll(re)) {
    const u = m[1].replace(/\/$/, ''); // strip trailing slash voor consistentie
    if (u.endsWith('/feed') || u.endsWith('/category')) continue;
    urls.add(u + '/');
  }
  return Array.from(urls);
}

/** Strip HTML naar plain text. Behoudt paragraph-breaks. */
function htmlToText(html: string): string {
  return html
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Pak de event-body uit `entry-content` (WP standard). Strip HTML +
 *  knip de meta-info-prefix ("Datum X, Voorverkoop €X, ...") weg zodat
 *  alleen de echte tekst overblijft. */
function extractBody(html: string): string | null {
  const m = html.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]+?)<\/div>\s*<\/div>/);
  if (!m) return null;
  let body = decodeEntities(htmlToText(m[1]));
  // Knip meta-blok weg — alles tot en met de eerste "Aanvang HH:MM"
  const aanvangIdx = body.search(/Aanvang\s+\d{1,2}[:.]\d{2}/);
  if (aanvangIdx >= 0) {
    const after = body.slice(aanvangIdx).match(/\d{1,2}[:.]\d{2}/);
    if (after) {
      body = body.slice(aanvangIdx + after.index! + after[0].length).trim();
    }
  }
  // Knip "Tickets vanaf €..." prefix
  body = body.replace(/^Tickets\s+vanaf\s+€\s*\d+[,.]?\d*\s*/i, '');
  // Tag-suffix wegknippen
  body = body.replace(/\s*Getagged\s+.+$/i, '').trim();
  return body || null;
}

export type WpTheatreResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

async function scrapeOneVenue(
  venue: typeof schema.venues.$inferSelect,
  cfg: { agendaUrl: string }
): Promise<WpTheatreResult> {
  const result: WpTheatreResult = {
    venueId: venue.id,
    fetched: 0,
    inserted: 0,
    occurrencesUpserted: 0,
    skipped: 0,
    errors: [],
  };

  const urls = await discoverEventUrls(cfg.agendaUrl);
  result.fetched = urls.length;
  if (urls.length === 0) {
    result.errors.push('geen event-URLs gevonden op agenda');
    return result;
  }

  const venueCategory = venue.categories?.[0] ?? 'Muziek';

  for (const url of urls) {
    try {
      const html = await fetchHtml(url);
      if (!html) { result.skipped++; continue; }
      const ogTitle = extractOg(html, 'title');
      const ogDescription = extractOg(html, 'description');
      const ogImage = extractOg(html, 'image');
      if (!ogTitle) { result.skipped++; continue; }

      // Strip " | Podium DE FLUX" suffix
      const title = ogTitle.replace(/\s*\|\s*[^|]+$/, '').trim();
      if (!title) { result.skipped++; continue; }

      // Datum + Aanvang uit og:description (consistent over WP-Theatre venues)
      const date = parseDutchDate(ogDescription);
      if (!date) { result.skipped++; continue; }
      const aanvang = parseTime(ogDescription, 'Aanvang') ?? { h: 20, m: 0 };
      const startsAt = shiftToLocalTime(date.y, date.m, date.d, aanvang.h, aanvang.m);

      // Prijzen
      const voorverkoop = parsePriceCents(ogDescription, 'Voorverkoop');
      const deur = parsePriceCents(ogDescription, 'Deur');
      const priceCents = voorverkoop ?? deur;
      const priceNote =
        voorverkoop && deur && voorverkoop !== deur
          ? `Deur €${(deur / 100).toFixed(2).replace('.', ',')}`
          : null;

      // Slug uit URL voor stable id
      const slug = url.match(/\/event\/([a-z0-9-]+)\/?$/)?.[1] ?? url.split('/').pop()!;
      const eventId = `evt-wpt-${venue.id}-${slug}`;
      const occurrenceId = `occ-wpt-${venue.id}-${slug}`;

      // Existing check (incremental pattern)
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
            priceCents,
            priceNote,
            ticketUrl: url,
            room: null,
            lineup: null,
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: { startsAt, priceCents, priceNote, ticketUrl: url },
          });
        result.occurrencesUpserted++;
        continue;
      }

      // Nieuw event — full flow.
      const description = extractBody(html) ?? ogDescription;
      const enriched = await enrichEvent({
        title,
        description,
        venueName: venue.name,
        venueCategory,
      });

      let imageUrl: string | null = null;
      if (ogImage) {
        try {
          const r = await fetch(ogImage, { headers: { 'user-agent': UA } });
          if (r.ok) {
            const mime = r.headers.get('content-type') ?? 'image/jpeg';
            if (mime.startsWith('image/')) {
              const buf = await r.arrayBuffer();
              if (buf.byteLength <= 8 * 1024 * 1024) {
                const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
                imageUrl =
                  (await uploadToBunny(`media/events/wpt-${venue.id}-${slug}.${ext}`, buf, mime)) ??
                  ogImage;
              }
            }
          }
        } catch {
          imageUrl = ogImage;
        }
      }

      const refinedKind = refineKindByDuration(enriched.kind, startsAt, null);

      await db.transaction(async (tx) => {
        await tx.insert(schema.events).values({
          id: eventId,
          venueId: venue.id,
          title,
          description: enriched.cleanedDescription ?? description,
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
            priceCents,
            priceNote: priceNote ?? enriched.priceNote,
            ticketUrl: url,
            room: enriched.room,
            lineup: enriched.lineup,
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: {
              startsAt,
              priceCents,
              priceNote: priceNote ?? enriched.priceNote,
              ticketUrl: url,
              room: enriched.room,
              lineup: enriched.lineup,
            },
          });
        result.occurrencesUpserted++;
      });
    } catch (e) {
      result.errors.push(`${url}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return result;
}

export async function scrapeWpTheatre(options?: {
  venueIds?: string[];
}): Promise<WpTheatreResult[]> {
  const all = await db.select().from(schema.venues);
  const targets = all.filter((v) => {
    const cfg = v.scraperConfig?.wpTheatre;
    if (!cfg?.agendaUrl) return false;
    if (options?.venueIds && !options.venueIds.includes(v.id)) return false;
    return true;
  });
  const results: WpTheatreResult[] = [];
  for (const v of targets) {
    const cfg = v.scraperConfig!.wpTheatre!;
    results.push(await scrapeOneVenue(v, cfg));
  }
  return results;
}
