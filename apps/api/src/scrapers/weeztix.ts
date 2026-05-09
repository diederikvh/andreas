import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Weeztix is een ticket-platform op OpenTicket-stack. Per shop-UUID
 * (uit `shop.weeztix.com/{uuid}/events`) levert OpenTicket een data-API:
 *
 *   GET https://shop.api.openticket.tech/{shopUuid}/data
 *
 * Returns `{ events: [{ guid, name, description, start, end, location,
 *   category, subcategories }, ...], shops, products, ... }`.
 *
 * Geen API-key nodig, pure HTTP — kan in cron. Image is **niet** in
 * de API; voor venues die een eigen agenda-page hebben met images
 * kunnen we via `imageAgendaUrl` config een augmentatie-fetch doen
 * (later, voor MVP zonder).
 *
 * Eerste gebruikers: Tilla Tec, Radio Radio, Warehouse Elementenstraat.
 *
 * Idempotency: `eventId = evt-wz-{venueId}-{event.guid}`.
 */

const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const API_BASE = 'https://shop.api.openticket.tech';
const SHOP_BASE = 'https://shop.weeztix.com';

type ApiEvent = {
  guid: string;
  name: string;
  description: string | null;
  start: string;
  end?: string;
  status?: string;
  category?: string;
  subcategories?: string[];
  location?: { name?: string; address?: string } | null;
};

async function fetchShopData(shopUuid: string): Promise<{ events: ApiEvent[] }> {
  try {
    const r = await fetch(`${API_BASE}/${shopUuid}/data`, {
      headers: { 'user-agent': UA, accept: 'application/json' },
    });
    if (!r.ok) return { events: [] };
    return (await r.json()) as { events: ApiEvent[] };
  } catch {
    return { events: [] };
  }
}

/** Optioneel: haal og:image van eigen agenda-page op voor alle events.
 *  Per event matcht via title-prefix (best-effort). Geen vereiste. */
async function fetchImageMap(agendaUrl: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const r = await fetch(agendaUrl, { headers: { 'user-agent': UA } });
    if (!r.ok) return out;
    const html = await r.text();
    // Sample: alle <img src="..."> + nearby title-text
    // Pas dit per venue aan in DB-config indien meer custom needed.
    const imgs = Array.from(html.matchAll(/<img[^>]+src="([^"]+\.(?:jpg|jpeg|png|webp))"/gi)).map((m) => m[1]);
    for (const img of imgs) {
      if (/logo|sprite|icon|placeholder/i.test(img)) continue;
      // Use filename as soft-key for matching
      const key = (img.split('/').pop() ?? '').toLowerCase().replace(/\.\w+$/, '').replace(/[^a-z0-9]/g, '');
      if (key && !out.has(key)) out.set(key, img);
    }
  } catch {}
  return out;
}

async function mirrorImage(sourceUrl: string, slug: string): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength < 1024 || buf.byteLength > 16 * 1024 * 1024) return null;
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : mime.includes('avif') ? 'avif' : 'jpg';
    return await uploadToBunny(`media/events/wz-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[weeztix] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

function softMatchKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
}

export type WeeztixVenueResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeWeeztix(options?: {
  venueIds?: string[];
}): Promise<WeeztixVenueResult[]> {
  const allVenues = await db.select().from(schema.venues);
  const targets = allVenues.filter((v) => {
    if (options?.venueIds && !options.venueIds.includes(v.id)) return false;
    return Boolean(v.scraperConfig?.weeztix?.shopUuid);
  });

  const results: WeeztixVenueResult[] = [];

  for (const venue of targets) {
    const cfg = venue.scraperConfig!.weeztix!;
    const result: WeeztixVenueResult = {
      venueId: venue.id, fetched: 0, inserted: 0, occurrencesUpserted: 0, skipped: 0, errors: [],
    };
    const venueCategory = venue.categories?.[0] ?? 'Muziek';

    const data = await fetchShopData(cfg.shopUuid);
    const events = data.events;
    result.fetched = events.length;
    if (events.length === 0) {
      results.push(result);
      continue;
    }

    // Optioneel: image-map van eigen agenda-page
    const imageMap = cfg.imageAgendaUrl ? await fetchImageMap(cfg.imageAgendaUrl) : new Map<string, string>();

    const cutoff = Date.now() - 6 * 60 * 60 * 1000;

    for (const ev of events) {
      try {
        if (!ev.guid || !ev.name || !ev.start) {
          result.skipped++;
          continue;
        }
        const startsAt = new Date(ev.start);
        if (isNaN(startsAt.getTime()) || startsAt.getTime() < cutoff) {
          result.skipped++;
          continue;
        }
        const endsAt = ev.end ? new Date(ev.end) : null;

        const eventId = `evt-wz-${venue.id}-${ev.guid}`;
        const [existing] = await db
          .select({ id: schema.events.id })
          .from(schema.events)
          .where(eq(schema.events.id, eventId))
          .limit(1);

        let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;

        if (!existing) {
          const description = ev.description?.trim() || null;
          // Image-match: zoek op title in image-map
          const matchKey = softMatchKey(ev.name);
          const sourceImg = Array.from(imageMap.entries()).find(([k]) => matchKey.includes(k.slice(0, 8)) || k.includes(matchKey.slice(0, 8)))?.[1] ?? null;
          let imageUrl: string | null = null;
          if (sourceImg) {
            imageUrl = (await mirrorImage(sourceImg, `${venue.id}-${ev.guid}`)) ?? sourceImg;
          }

          try {
            enriched = await enrichEvent({
              title: ev.name,
              description,
              venueName: venue.name,
              venueCategory,
            });
          } catch (e) {
            result.errors.push(`enrich ${ev.name}: ${(e as Error).message}`);
          }

          const eventKind = refineKindByDuration(enriched?.kind ?? 'show', startsAt, endsAt);
          // Genres: subcategories + Claude
          const apiGenres = (ev.subcategories ?? []).filter((g) => g && g !== 'other').slice(0, 3);
          const enrichGenres = enriched?.genres ?? [];
          const finalGenres = [...new Set([...apiGenres, ...enrichGenres])].slice(0, 6);

          try {
            await db.insert(schema.events).values({
              id: eventId,
              venueId: venue.id,
              title: ev.name,
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
          const occurrenceId = `occ-wz-${venue.id}-${ev.guid}`;
          const ticketUrl = `${SHOP_BASE}/${cfg.shopUuid}/events/${ev.guid}`;
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
              room: ev.location?.name ?? null,
              lineup: existing ? null : (enriched?.lineup ?? null),
              status: 'scheduled',
            })
            .onConflictDoUpdate({
              target: schema.occurrences.id,
              set: { startsAt, endsAt, ticketUrl },
            });
          result.occurrencesUpserted++;
        } catch (e) {
          result.errors.push(`occurrence ${ev.guid}: ${(e as Error).message}`);
          result.skipped++;
        }
      } catch (e) {
        result.errors.push(`event ${ev.guid}: ${(e as Error).message}`);
        result.skipped++;
      }
    }
    results.push(result);
  }

  return results;
}
