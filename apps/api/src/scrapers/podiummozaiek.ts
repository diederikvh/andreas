import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Podium Mozaïek (Bos en Lommer) gebruikt **Ticketmatic** als ticketshop.
 * Hun eigen site (`podiummozaiek.nl`) is SSL-broken op moment van
 * schrijven, maar de Ticketmatic shop heeft alle data:
 *
 *   GET https://ticketshop.ticketmatic.com/podium_mozaiek/shop
 *
 * Response heeft inline AngularJS:
 *   angular.module("tm.shop").constant("SHOP", {
 *     account: "podium_mozaiek",
 *     events: [
 *       { code, name, description, subtitle, location, start, end },
 *       ...
 *     ]
 *   })
 *
 * Per event = 1 occurrence (geen performances-array). Voor multi-night
 * shows (bv. "404 CONNECTION (NOT) FOUND" 16:00 + 19:00 op zelfde dag)
 * staan ze als aparte events in de array — title-grouping merge ze
 * (strip "(uitverkocht)" suffix).
 *
 * Idempotency: eventId = `evt-pm-{slugify(cleanTitle)}`,
 *              occurrenceId = `occ-pm-{eventCode}`.
 */

const VENUE_ID = 'podium-mozaiek';
const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const SHOP_URL = 'https://ticketshop.ticketmatic.com/podium_mozaiek/shop';

type ShopEvent = {
  code: string;
  name: string;
  description?: string;
  subtitle?: string;
  location?: string;
  start?: string;        // "2026-03-20T20:30:00"
  end?: string;
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

/** Strip status-suffixen die niet de echte titel zijn. */
function cleanTitle(name: string): string {
  return name
    .replace(/\s*\((?:uitverkocht|sold out|wachtlijst|aflasting|geannuleerd|verplaatst)[^)]*\)\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchShopEvents(): Promise<ShopEvent[]> {
  const r = await fetch(SHOP_URL, { headers: { 'user-agent': UA } });
  if (!r.ok) return [];
  const html = await r.text();
  const inline = html.match(/<script(?![^>]*src)[^>]*>([\s\S]+?)<\/script>/g) ?? [];
  for (const block of inline) {
    if (!block.includes('"events"')) continue;
    // Find SHOP constant
    const m = block.match(/\.constant\("SHOP",\s*(\{[\s\S]+?\})\s*\)/);
    if (!m) continue;
    try {
      const d = JSON.parse(m[1]) as { events?: ShopEvent[] };
      return d.events ?? [];
    } catch {
      continue;
    }
  }
  return [];
}

async function fetchDetailMeta(code: string): Promise<{ description: string | null; image: string | null }> {
  try {
    const r = await fetch(`${SHOP_URL}/event/${code}`, { headers: { 'user-agent': UA } });
    if (!r.ok) return { description: null, image: null };
    const html = await r.text();
    const desc = html.match(/<meta property="og:description" content="([^"]+)"/)?.[1] ?? null;
    const img = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1] ?? null;
    return {
      description: desc ? desc.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'") : null,
      image: img,
    };
  } catch {
    return { description: null, image: null };
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
    return await uploadToBunny(`media/events/pm-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[podiummozaiek] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type PodiumMozaiekResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapePodiumMozaiek(options?: {
  venueIds?: string[];
}): Promise<PodiumMozaiekResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: PodiumMozaiekResult = {
    venueId: VENUE_ID, fetched: 0, inserted: 0, occurrencesUpserted: 0, skipped: 0, errors: [],
  };

  const [venue] = await db.select().from(schema.venues).where(eq(schema.venues.id, VENUE_ID));
  if (!venue) {
    result.errors.push('venue niet in DB');
    return [result];
  }
  const venueCategory = venue.categories?.[0] ?? 'Theater';

  const events = await fetchShopEvents();
  result.fetched = events.length;
  if (events.length === 0) {
    result.errors.push('geen events in Ticketmatic SHOP');
    return [result];
  }

  // Title-grouping: strip "(uitverkocht)" e.d., merge events met
  // dezelfde clean title naar één event-row (multi-occurrence).
  type Group = { titleSlug: string; head: ShopEvent; cleanName: string; events: ShopEvent[] };
  const groups = new Map<string, Group>();
  for (const e of events) {
    if (!e.code || !e.name || !e.start) continue;
    const cleanName = cleanTitle(e.name);
    const titleSlug = slugify(cleanName);
    if (!titleSlug) continue;
    const g = groups.get(titleSlug);
    if (g) g.events.push(e);
    else groups.set(titleSlug, { titleSlug, cleanName, head: e, events: [e] });
  }
  // Sort events per group on start date; head = earliest
  for (const g of groups.values()) {
    g.events.sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''));
    g.head = g.events[0];
  }

  const cutoff = Date.now() - 6 * 60 * 60 * 1000;

  for (const group of groups.values()) {
    try {
      const eventId = `evt-pm-${group.titleSlug}`;
      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      // Filter future slots
      const futureEvents = group.events.filter((e) => {
        const t = new Date(`${e.start!.replace(' ', 'T')}+02:00`).getTime();
        return !isNaN(t) && t > cutoff;
      });
      if (futureEvents.length === 0) { result.skipped++; continue; }

      let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;

      if (!existing) {
        // SHOP description is vaak leeg — gebruik subtitle als bron
        // en haal og-meta van detail-page indien nodig.
        let description = group.head.description?.trim() || group.head.subtitle?.trim() || null;
        let imageUrl: string | null = null;
        if (!description || description.length < 30) {
          const detail = await fetchDetailMeta(group.head.code);
          if (detail.description) description = detail.description;
          if (detail.image) {
            imageUrl = (await mirrorImage(detail.image, group.titleSlug)) ?? detail.image;
          }
        }

        try {
          enriched = await enrichEvent({
            title: group.cleanName,
            description,
            venueName: venue.name,
            venueCategory,
          });
        } catch (e) {
          result.errors.push(`enrich ${group.cleanName}: ${(e as Error).message}`);
        }

        const headStart = new Date(`${futureEvents[0]!.start!.replace(' ', 'T')}+02:00`);
        const eventKind = refineKindByDuration(enriched?.kind ?? 'show', headStart, null);

        try {
          await db.insert(schema.events).values({
            id: eventId,
            venueId: venue.id,
            title: group.cleanName,
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
          result.errors.push(`insert event ${eventId}: ${(e as Error).message}`);
          continue;
        }
      }

      for (const e of futureEvents) {
        try {
          const startsAt = new Date(`${e.start!.replace(' ', 'T')}+02:00`);
          const endsAt = e.end ? new Date(`${e.end.replace(' ', 'T')}+02:00`) : null;
          if (isNaN(startsAt.getTime())) { result.skipped++; continue; }
          const occurrenceId = `occ-pm-${e.code}`;
          const status: 'scheduled' | 'sold_out' = /uitverkocht|sold out/i.test(e.name) ? 'sold_out' : 'scheduled';
          const ticketUrl = `${SHOP_URL}/event/${e.code}`;
          await db
            .insert(schema.occurrences)
            .values({
              id: occurrenceId,
              eventId,
              startsAt,
              endsAt,
              priceCents: null,
              priceNote: existing ? null : (enriched?.priceNote ?? null),
              ticketUrl,
              room: e.location ?? null,
              lineup: existing ? null : (enriched?.lineup ?? null),
              status,
            })
            .onConflictDoUpdate({
              target: schema.occurrences.id,
              set: { startsAt, endsAt, ticketUrl, room: e.location ?? null, status },
            });
          result.occurrencesUpserted++;
        } catch (err) {
          result.errors.push(`occurrence ${e.code}: ${(err as Error).message}`);
          result.skipped++;
        }
      }
    } catch (e) {
      result.errors.push(`group ${group.titleSlug}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
