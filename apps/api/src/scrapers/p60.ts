import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * P60 (Amstelveen) scraper. WordPress + Elementor + custom-post-types.
 * Strategie:
 *   1. WP REST API: /wp-json/wp/v2/agenda_item geeft alle events met
 *      title, link, og_image, excerpt, eventtype-IDs.
 *   2. Eventtype-taxonomy (id → genre-naam) eenmalig fetchen voor
 *      genres-mapping ("Indie / Alternative", "Heavy / Metal", etc).
 *   3. Per event: de detail-pagina fetchen om datum + aanvang-tijd
 *      uit het Elementor-template te parsen — datum staat in een
 *      `<div class="elementor-shortcode">vr 08 mei</div>` direct
 *      boven het post-title heading; "20:00 uur" elders in template.
 *
 * Idempotency: event-id uit WP-post-id (stabiel).
 */

const VENUE_ID = 'p60';
const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const BASE = 'https://p60.nl';

const NL_MONTHS_SHORT: Record<string, number> = {
  jan: 0, feb: 1, mrt: 2, apr: 3, mei: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, okt: 9, nov: 10, dec: 11,
};

type WpAgendaItem = {
  id: number;
  slug: string;
  link: string;
  title: { rendered: string };
  excerpt: { rendered: string };
  eventtype?: number[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  yoast_head_json?: { og_image?: { url: string }[]; og_description?: string };
};

type WpTerm = { id: number; name: string; slug: string };

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
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

async function fetchAllAgendaItems(): Promise<WpAgendaItem[]> {
  const all: WpAgendaItem[] = [];
  const PER_PAGE = 100;
  for (let page = 1; page <= 10; page++) {
    const batch = await fetchJson<WpAgendaItem[]>(
      `${BASE}/wp-json/wp/v2/agenda_item?per_page=${PER_PAGE}&page=${page}`
    );
    if (!batch || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < PER_PAGE) break;
  }
  return all;
}

async function fetchEventTypeMap(): Promise<Map<number, string>> {
  const terms = await fetchJson<WpTerm[]>(`${BASE}/wp-json/wp/v2/eventtype?per_page=100`);
  const m = new Map<number, string>();
  for (const t of terms ?? []) {
    // "Indie / Alternative" → split, take first part as primary genre
    const primary = t.name.split('/')[0]?.trim().toLowerCase();
    if (primary) m.set(t.id, primary);
  }
  return m;
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

/** Parse datum + aanvang-tijd uit P60's Elementor-template. */
function parseDateTimeFromHtml(
  html: string,
  rawTitle: string
): { startsAt: Date | null; description: string | null } {
  // Decode entity-titel ("P60&#8217;S" etc) en escape voor regex
  const decoded = rawTitle
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(parseInt(c, 10)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  // Vind de heading met deze titel (ongevoelig voor case + speciale chars
  // door het in de regex te escapen)
  const escaped = decoded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingRe = new RegExp(
    `class="elementor-heading-title[^"]*"[^>]*>\\s*${escaped}\\s*<`,
    'i'
  );
  const headingMatch = html.match(headingRe);
  if (!headingMatch || headingMatch.index === undefined) {
    return { startsAt: null, description: null };
  }

  // Datum: `vr 08 mei` in de 2000 chars vóór de heading
  const before = html.slice(Math.max(0, headingMatch.index - 2000), headingMatch.index);
  const dateRe = /\b(ma|di|wo|do|vr|za|zo)\s+(\d{1,2})\s+(jan|feb|mrt|apr|mei|jun|jul|aug|sep|okt|nov|dec)\b/i;
  const dm = before.match(dateRe);
  if (!dm) return { startsAt: null, description: null };
  const day = parseInt(dm[2], 10);
  const month = NL_MONTHS_SHORT[dm[3].toLowerCase()];
  // Year-detectie: P60 heeft alleen `vr 08 mei` zonder jaar. Afleiden
  // van NU: als de datum >2 maanden in het verleden is, zit 'ie in
  // volgend jaar (ander seizoen). Anders dit jaar.
  const now = new Date();
  let year = now.getUTCFullYear();
  const tentative = new Date(year, month, day);
  const monthsBack = (now.getTime() - tentative.getTime()) / (1000 * 60 * 60 * 24 * 30);
  if (monthsBack > 2) year++;

  // Tijd: zoek "20:00 uur" of "21:30 uur" (eerste match in template, na heading).
  // Of het "Aanvang"-blok met tijd — dat is na de heading.
  const after = html.slice(headingMatch.index, headingMatch.index + 5000);
  let hour = 20;
  let minute = 0;
  // Eerst proberen: heading "Aanvang" + volgende tijd
  const aanvangRe = />Aanvang(?:\s+\w+)?<[\s\S]+?(\d{1,2}):(\d{2})\s*uur/;
  const am = after.match(aanvangRe);
  if (am) {
    hour = parseInt(am[1], 10);
    minute = parseInt(am[2], 10);
  } else {
    // Generieke fallback: eerste "HH:MM uur" in het template-blok
    const tm = after.match(/(\d{1,2}):(\d{2})\s*uur/);
    if (tm) {
      hour = parseInt(tm[1], 10);
      minute = parseInt(tm[2], 10);
    }
  }

  const startsAt = shiftToLocalTime(year, month, day, hour, minute);

  // Description: pak text na de heading tot een common stopper.
  // Strip alle HTML, knip "Support: ..." prefix als die er is, stop
  // bij practische blokken zoals "Eten voor het event" of "Over jouw bezoek".
  const descRe = />\s*([^<]*?(?:Support[^<]*)?)<\/h\d>([\s\S]+?)(?:Eten\s+voor\s+het\s+event|Over\s+jouw\s+bezoek|Praktische|Tickets|elementor-element-c)/;
  const dm2 = after.match(descRe);
  let description: string | null = null;
  if (dm2) {
    let body = dm2[2].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
    body = body.replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(parseInt(c, 10)));
    body = body.replace(/\s+/g, ' ').trim();
    if (body.length > 50) description = body.slice(0, 2000);
  }

  return { startsAt, description };
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
    return await uploadToBunny(`media/events/p60-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[p60] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

function decodeTitle(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(parseInt(c, 10)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

export type P60Result = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeP60(options?: {
  venueIds?: string[];
}): Promise<P60Result[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: P60Result = {
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

  let items: WpAgendaItem[];
  try {
    items = await fetchAllAgendaItems();
  } catch (e) {
    result.errors.push(`wp-api: ${(e as Error).message}`);
    return [result];
  }
  result.fetched = items.length;

  const eventTypeMap = await fetchEventTypeMap();
  const venueCategory = venue.categories?.[0] ?? 'Muziek';

  for (const item of items) {
    try {
      const eventId = `evt-p60-${VENUE_ID}-${item.id}`;
      const occurrenceId = `occ-p60-${VENUE_ID}-${item.id}`;
      const title = decodeTitle(item.title.rendered);

      // Existing-check eerst — skip detail-fetch + Claude voor bestaande events
      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      // Detail-page sowieso nodig voor de starts-at (zelfs voor existing,
      // want startsAt kan wijzigen en hangt niet in de WP-API).
      const html = await fetchHtml(item.link);
      if (!html) { result.skipped++; continue; }
      const { startsAt, description } = parseDateTimeFromHtml(html, item.title.rendered);
      if (!startsAt) { result.skipped++; continue; }

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
            ticketUrl: item.link,
            room: null,
            lineup: null,
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: { startsAt, ticketUrl: item.link },
          });
        result.occurrencesUpserted++;
        continue;
      }

      // Nieuw event — Claude enrich + image-mirror.
      const ogDesc = item.yoast_head_json?.og_description ?? null;
      const finalDescription = description ?? item.excerpt?.rendered?.replace(/<[^>]+>/g, ' ').trim() ?? ogDesc;

      const fallbackGenres = (item.eventtype ?? [])
        .map((id) => eventTypeMap.get(id))
        .filter((g): g is string => !!g)
        .slice(0, 4);

      const enriched = await enrichEvent({
        title,
        description: finalDescription,
        venueName: venue.name,
        venueCategory,
      });

      let imageUrl: string | null = null;
      const ogImage = item.yoast_head_json?.og_image?.[0]?.url;
      if (ogImage) {
        imageUrl = (await mirrorImage(ogImage, item.slug)) ?? ogImage;
      }

      const finalGenres = enriched.genres.length > 0 ? enriched.genres : fallbackGenres;
      const refinedKind = refineKindByDuration(enriched.kind, startsAt, null);

      await db.transaction(async (tx) => {
        await tx.insert(schema.events).values({
          id: eventId,
          venueId: venue.id,
          title,
          description: enriched.cleanedDescription ?? finalDescription,
          kind: refinedKind,
          imageUrl,
          category: enriched.category ?? venueCategory,
          featured: false,
          genres: finalGenres,
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
            ticketUrl: item.link,
            room: enriched.room,
            lineup: enriched.lineup,
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: {
              startsAt,
              priceNote: enriched.priceNote,
              ticketUrl: item.link,
              room: enriched.room,
              lineup: enriched.lineup,
            },
          });
        result.occurrencesUpserted++;
      });
    } catch (e) {
      result.errors.push(`event ${item.id}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
