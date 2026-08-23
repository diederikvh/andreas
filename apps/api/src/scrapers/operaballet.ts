import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';
import { loadVenueTitleMap, resolveEventId } from './_title-dedup.js';

/**
 * Nationale Opera & Ballet (Stopera). Drupal-CMS.
 *
 * Strategie:
 *  1. Sitemap (4 pages) → harvest show-URLs voor opera + ballet:
 *       /de-nationale-opera/{seizoen}/{slug}
 *       /het-nationale-ballet/{seizoen}/{slug}
 *  2. Per show-page: parse JSON-LD `Event` voor naam/description/image
 *     en pluk `data-node-id` (Drupal node-ID) + `data-datalayer-item-category`
 *     (Opera/Ballet voor categorie).
 *  3. Speeldatums via Drupal-API:
 *       GET /api/1.0/activities/{nodeId}/nl?limit=100
 *     Returns `{results: [{date: "Zondag 10 mei", time: "14:00 uur", link, status}], total}`.
 *     Dutch datums (geen jaar) → resolve via JSON-LD startDate als anker.
 *
 * Title-grouping (geleerd van eerdere venues): één event-row per show
 * (eventId = `evt-ob-{nodeId}`), occurrences per speeldatum.
 */

const VENUE_ID = 'stopera';
const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const BASE = 'https://www.operaballet.nl';

const SITEMAP_PAGES = [1, 2, 3, 4];
const SHOW_RE = /^https:\/\/www\.operaballet\.nl\/(?:de-nationale-opera|het-nationale-ballet)\/\d{4}-\d{4}\/[a-z0-9-]+$/;

const DUTCH_MONTHS: Record<string, number> = {
  januari: 1, februari: 2, maart: 3, april: 4, mei: 5, juni: 6,
  juli: 7, augustus: 8, september: 9, oktober: 10, november: 11, december: 12,
};

type ShowMeta = {
  url: string;
  nodeId: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  startDate: Date | null;
  endDate: Date | null;
  category: 'Opera' | 'Ballet' | null;
};

type ApiActivity = {
  date: string;        // "Zondag 10 mei"
  time: string;        // "14:00 uur"
  price_or_location?: string;
  status?: string;
  link?: string;
  fullday?: boolean;
};

async function fetchText(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch { return null; }
}

async function harvestShowUrls(): Promise<string[]> {
  const out = new Set<string>();
  for (const p of SITEMAP_PAGES) {
    const xml = await fetchText(`${BASE}/sitemap.xml?page=${p}`);
    if (!xml) continue;
    for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
      if (SHOW_RE.test(m[1])) out.add(m[1]);
    }
  }
  return Array.from(out);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(parseInt(c, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, c) => String.fromCodePoint(parseInt(c, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

function stripHtml(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pickJsonLdEvent(html: string): any | null {
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]+?)<\/script>/g)) {
    try {
      const d = JSON.parse(m[1].trim());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items: any[] = Array.isArray(d) ? d : (d?.['@graph'] ?? [d]);
      for (const x of items) {
        if (x && typeof x === 'object' && /Event/i.test(String(x['@type']))) return x;
      }
    } catch { continue; }
  }
  return null;
}

function pickImageUrl(html: string): string | null {
  const og = html.match(/<meta property="og:image" content="([^"]+)"/);
  return og?.[1] ?? null;
}

function pickNodeId(html: string): string | null {
  // `data-node-id="4423"` op de tickets-container
  return html.match(/data-node-id="(\d+)"/)?.[1] ?? null;
}

function pickCategory(html: string): 'Opera' | 'Ballet' | null {
  const m = html.match(/data-datalayer-item-category="([^"]+)"/);
  if (!m) return null;
  if (/Opera/i.test(m[1])) return 'Opera';
  if (/Ballet/i.test(m[1])) return 'Ballet';
  return null;
}

async function fetchShowMeta(url: string): Promise<ShowMeta | null> {
  const html = await fetchText(url);
  if (!html) return null;
  const json = pickJsonLdEvent(html);
  if (!json) return null;
  const title = (typeof json.name === 'string' ? json.name : '').trim();
  if (!title) return null;
  const nodeId = pickNodeId(html);
  if (!nodeId) return null;
  const description = json.description ? stripHtml(json.description) : null;
  const startDate = json.startDate ? new Date(json.startDate) : null;
  const endDate = json.endDate ? new Date(json.endDate) : null;
  const category = pickCategory(html);
  let imageUrl: string | null = null;
  if (typeof json.image === 'string') imageUrl = json.image;
  else if (Array.isArray(json.image) && json.image[0]) {
    imageUrl = typeof json.image[0] === 'string' ? json.image[0] : (json.image[0]?.url ?? null);
  }
  if (!imageUrl) imageUrl = pickImageUrl(html);
  return { url, nodeId, title, description, imageUrl, startDate, endDate, category };
}

/**
 * Parse "Zondag 10 mei" → Date in juiste jaar (gebaseerd op show-range).
 * Resolve het jaar door de gevonden maand+dag te plaatsen tussen
 * `show.startDate` en `show.endDate` (1 jaar marge erom).
 */
function parseDutchDate(dateStr: string, timeStr: string, anchor: Date | null): Date | null {
  const m = dateStr.toLowerCase().match(/(\d{1,2})\s+(\w+)/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const monthName = m[2];
  const month = DUTCH_MONTHS[monthName];
  if (!month) return null;
  const t = timeStr.match(/(\d{1,2}):(\d{2})/);
  const hh = t ? parseInt(t[1], 10) : 20;
  const mm = t ? parseInt(t[2], 10) : 0;

  // Year resolution: try anchor-year, then anchor-year+1
  const baseYear = anchor ? anchor.getFullYear() : new Date().getFullYear();
  for (const y of [baseYear, baseYear + 1, baseYear - 1]) {
    const candidate = new Date(`${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+02:00`);
    if (isNaN(candidate.getTime())) continue;
    // Accept als binnen ~6 maanden van anchor (of als anchor null, accept always)
    if (!anchor) return candidate;
    const delta = Math.abs(candidate.getTime() - anchor.getTime());
    if (delta < 200 * 24 * 60 * 60 * 1000) return candidate;
  }
  return null;
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
    return await uploadToBunny(`media/events/ob-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[operaballet] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type OperaballetResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeOperaballet(options?: {
  venueIds?: string[];
}): Promise<OperaballetResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: OperaballetResult = {
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

  const showUrls = await harvestShowUrls();
  result.fetched = showUrls.length;
  if (showUrls.length === 0) {
    result.errors.push('geen show-URLs in sitemap');
    return [result];
  }

  const cutoff = Date.now() - 6 * 60 * 60 * 1000;

  const byTitle = await loadVenueTitleMap(VENUE_ID, 'evt-ob-');

  for (const url of showUrls) {
    try {
      const meta = await fetchShowMeta(url);
      if (!meta) { result.skipped++; continue; }

      // Skip als endDate (laatste avond) >6u voorbij is
      const endRef = (meta.endDate ?? meta.startDate)?.getTime() ?? null;
      if (endRef !== null && endRef < cutoff) { result.skipped++; continue; }

      // fetchShowMeta halen we voor elke show-URL op, dus titel, datum
      // en JSON-LD-description zijn hier alle drie gratis.
      const { eventId } = resolveEventId(byTitle, meta.title, `evt-ob-${meta.nodeId}`, {
        startsAt: meta.startDate,
        description: meta.description,
      });
      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      // Speeldatums ophalen — limit ruim om alle data binnen te halen
      const activities = await fetchJson<{ results: ApiActivity[]; total: number }>(
        `${BASE}/api/1.0/activities/${meta.nodeId}/nl?limit=100`
      );
      const slots: Array<{ startsAt: Date; ticketUrl: string | null; status: string }> = [];
      for (const a of activities?.results ?? []) {
        const dt = parseDutchDate(a.date, a.time, meta.startDate ?? meta.endDate);
        if (!dt) continue;
        // Operaballet's API geeft soms `link: ""` voor events die nog
        // niet in verkoop zijn, regio-tours, of voorverkoop. Trim eerst
        // en val terug op de detail-pagina op operaballet.nl zodat de
        // gebruiker tenminste naar de juiste info wordt gestuurd i.p.v.
        // een lege ticket-knop.
        const rawLink = (a.link ?? '').trim();
        const ticketUrl = rawLink.length > 0 ? rawLink : meta.url;
        slots.push({
          startsAt: dt,
          ticketUrl,
          status: a.status === 'sold-out' ? 'sold_out' : 'scheduled',
        });
      }
      const futureSlots = slots.filter((s) => s.startsAt.getTime() > cutoff);
      if (futureSlots.length === 0) { result.skipped++; continue; }

      let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;

      if (!existing) {
        let imageUrl: string | null = null;
        if (meta.imageUrl) {
          imageUrl = (await mirrorImage(meta.imageUrl, `${meta.nodeId}`)) ?? meta.imageUrl;
        }

        const venueCategory = meta.category === 'Ballet' || meta.category === 'Opera' ? 'Theater' : (venue.categories?.[0] ?? 'Theater');

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

        const headStart = futureSlots[0]!.startsAt;
        const eventKind = refineKindByDuration(enriched?.kind ?? 'show', headStart, null);

        // Genres uit ITA-style: voeg "opera" of "ballet" toe als deze
        // niet al door enrich is opgepikt.
        const baseGenres = enriched?.genres ?? [];
        const cat = meta.category?.toLowerCase();
        const genres = cat && !baseGenres.some((g) => g.toLowerCase().includes(cat))
          ? [cat, ...baseGenres]
          : baseGenres;

        try {
          await db.insert(schema.events).values({
            id: eventId,
            venueId: venue.id,
            title: meta.title,
            description: enriched?.cleanedDescription ?? meta.description,
            kind: eventKind,
            imageUrl,
            category: enriched?.category ?? 'Theater',
            featured: false,
            genres,
            published: true,
          });
          result.inserted++;
        } catch (e) {
          result.errors.push(`insert event ${eventId}: ${(e as Error).message}`);
          continue;
        }
      }

      for (const slot of futureSlots) {
        try {
          const isoSlot = slot.startsAt.toISOString().slice(0, 16).replace(':', '-');
          const occurrenceId = `occ-ob-${meta.nodeId}-${isoSlot}`;
          await db
            .insert(schema.occurrences)
            .values({
              id: occurrenceId,
              eventId,
              startsAt: slot.startsAt,
              endsAt: null,
              priceCents: null,
              priceNote: existing ? null : (enriched?.priceNote ?? null),
              ticketUrl: slot.ticketUrl,
              room: null,
              lineup: existing ? null : (enriched?.lineup ?? null),
              status: slot.status as 'scheduled' | 'sold_out',
            })
            .onConflictDoUpdate({
              target: schema.occurrences.id,
              set: {
                // eventId meenemen: occurrences die nog aan een los
                // event hingen verhuizen zo zelf mee.
                eventId,
                startsAt: slot.startsAt,
                ticketUrl: slot.ticketUrl,
                status: slot.status as 'scheduled' | 'sold_out',
              },
            });
          result.occurrencesUpserted++;
        } catch (e) {
          result.errors.push(`occurrence ${meta.nodeId}/${slot.startsAt.toISOString()}: ${(e as Error).message}`);
          result.skipped++;
        }
      }
    } catch (e) {
      result.errors.push(`show ${url}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
