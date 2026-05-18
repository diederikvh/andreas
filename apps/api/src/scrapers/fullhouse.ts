import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Fullhouse.tech — ticket-platform met Next.js shop-pagina's per
 * seller. URL-vorm: `shop.fullhouse.tech/seller/{sellerSlug}`. Events
 * staan in `__NEXT_DATA__` als `pageProps.events[]`.
 *
 * Event-shape:
 *   _id, url (slug), name, image (https-URL),
 *   start, end (ISO Z), locationName, locationStreet, locationCity,
 *   currency, ticketPrice (geen, alleen vendor-info)
 *
 * Idempotency: `evt-fh-{venueId}-{url}`, `occ-fh-{venueId}-{url}`.
 * Voor venues met dezelfde seller op meerdere venues kan de scraper
 * later worden uitgebreid met locationName-filter.
 */

const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const BASE = 'https://shop.fullhouse.tech';

type FhEvent = {
  _id: string;
  url: string;
  name: string;
  image?: string | null;
  start: string;
  end?: string | null;
  locationName?: string | null;
  locationStreet?: string | null;
  description?: string | null;
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(parseInt(c, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, c) => String.fromCodePoint(parseInt(c, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, ' ');
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function fetchEvents(sellerSlug: string): Promise<FhEvent[]> {
  try {
    const url = `${BASE}/seller/${sellerSlug}`;
    const r = await fetch(url, { headers: { 'user-agent': UA } });
    if (!r.ok) return [];
    const html = await r.text();
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/);
    if (!m) return [];
    let data: unknown;
    try {
      data = JSON.parse(m[1]);
    } catch {
      return [];
    }
    const events = (((data as Record<string, unknown>).props as Record<string, unknown> | undefined)
      ?.pageProps as Record<string, unknown> | undefined)
      ?.events;
    if (!Array.isArray(events)) return [];
    return events as FhEvent[];
  } catch {
    return [];
  }
}

type SlateNode = {
  type?: string;
  text?: string;
  children?: SlateNode[];
};

/** Fullhouse's `description` is soms een Slate-rich-text JSON-array
 *  (e.g. `[{type:"paragraph",children:[{text:"…"}]}]`), soms HTML, soms
 *  plain text. Detecteer + flatten. */
function flattenDescription(desc: string): string {
  const trimmed = desc.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as SlateNode[] | SlateNode;
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      const out: string[] = [];
      function walk(n: SlateNode) {
        if (typeof n.text === 'string') {
          if (n.text) out.push(n.text);
          return;
        }
        for (const c of n.children ?? []) walk(c);
        if (n.type === 'paragraph' || n.type === 'heading') out.push('\n\n');
      }
      for (const n of nodes) walk(n);
      return out.join('').replace(/\n{3,}/g, '\n\n').trim();
    } catch {
      // fall through to plain-text handling
    }
  }
  return decodeEntities(stripTags(desc));
}

/** Probeer per event extra description-tekst uit de detail-pagina te
 *  pluken. Fullhouse rendert event-detail op `shop.fullhouse.tech/event
 *  /{url}` en heeft de beschrijving in __NEXT_DATA__.pageProps.event. */
async function fetchDetailDescription(eventUrl: string): Promise<string | null> {
  try {
    const r = await fetch(`${BASE}/event/${eventUrl}`, {
      headers: { 'user-agent': UA },
    });
    if (!r.ok) return null;
    const html = await r.text();
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/);
    if (!m) return null;
    let data: unknown;
    try {
      data = JSON.parse(m[1]);
    } catch {
      return null;
    }
    const ev = ((((data as Record<string, unknown>).props as Record<string, unknown> | undefined)
      ?.pageProps as Record<string, unknown> | undefined)
      ?.event as Record<string, unknown> | undefined);
    const desc = ev?.description;
    if (typeof desc !== 'string' || !desc.trim()) return null;
    const text = flattenDescription(desc);
    return text.slice(0, 800) || null;
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
    const ext = mime.includes('png') ? 'png'
      : mime.includes('webp') ? 'webp'
      : mime.includes('avif') ? 'avif' : 'jpg';
    return await uploadToBunny(`media/events/fh-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[fullhouse] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type FullhouseResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeFullhouse(options?: {
  venueIds?: string[];
}): Promise<FullhouseResult[]> {
  const allVenues = await db.select().from(schema.venues);
  const targets = allVenues.filter((v) => {
    if (options?.venueIds && !options.venueIds.includes(v.id)) return false;
    return Boolean(v.scraperConfig?.fullhouse?.sellerSlug);
  });

  const results: FullhouseResult[] = [];

  for (const venue of targets) {
    const cfg = venue.scraperConfig!.fullhouse!;
    const result: FullhouseResult = {
      venueId: venue.id, fetched: 0, inserted: 0,
      occurrencesUpserted: 0, skipped: 0, errors: [],
    };

    const items = await fetchEvents(cfg.sellerSlug);
    result.fetched = items.length;

    const cutoff = Date.now() - 6 * 60 * 60 * 1000;

    for (const ev of items) {
      try {
        if (!ev._id || !ev.url || !ev.name || !ev.start) {
          result.skipped++;
          continue;
        }
        const startsAt = new Date(ev.start);
        const endsAt = ev.end ? new Date(ev.end) : null;
        if (Number.isNaN(startsAt.getTime()) || startsAt.getTime() < cutoff) {
          result.skipped++;
          continue;
        }

        const title = decodeEntities(ev.name).trim();
        const eventId = `evt-fh-${venue.id}-${ev.url}`;
        const occurrenceId = `occ-fh-${venue.id}-${ev.url}`;

        const [existing] = await db
          .select({ id: schema.events.id })
          .from(schema.events)
          .where(eq(schema.events.id, eventId))
          .limit(1);

        let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;

        if (!existing) {
          let imageUrl: string | null = null;
          if (ev.image) {
            imageUrl = (await mirrorImage(ev.image, ev.url)) ?? ev.image;
          }
          const description = await fetchDetailDescription(ev.url);

          try {
            enriched = await enrichEvent({
              title,
              description,
              venueName: venue.name,
              venueCategory: 'Muziek',
            });
          } catch (e) {
            result.errors.push(`enrich ${title}: ${(e as Error).message}`);
          }

          const eventKind = refineKindByDuration(
            enriched?.kind ?? 'show', startsAt, endsAt,
          );

          try {
            await db.insert(schema.events).values({
              id: eventId,
              venueId: venue.id,
              title,
              description: enriched?.cleanedDescription ?? description,
              kind: eventKind,
              imageUrl,
              category: enriched?.category ?? 'Muziek',
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

        try {
          const ticketUrl = `${BASE}/event/${ev.url}`;
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
              room: null,
              lineup: existing ? null : (enriched?.lineup ?? null),
              status: 'scheduled',
            })
            .onConflictDoUpdate({
              target: schema.occurrences.id,
              set: { startsAt, endsAt, ticketUrl },
            });
          result.occurrencesUpserted++;
        } catch (e) {
          result.errors.push(`occurrence ${ev.url}: ${(e as Error).message}`);
          result.skipped++;
        }
      } catch (e) {
        result.errors.push(`event ${ev._id}: ${(e as Error).message}`);
        result.skipped++;
      }
    }
    results.push(result);
  }

  return results;
}
