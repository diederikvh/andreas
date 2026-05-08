import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Boom Chicago eigen-shows scraper. Aanvulling op Ticketmaster (TM
 * dekt de Engelstalige tour-acts zoals Ali Wong, Roy Wood Jr. — ~14
 * events). De doorlopende programmering (Improv Spectacular, Comedy
 * Embassy, Sunday Night Live, etc.) loopt via FareHarbor en is veel
 * groter qua volume.
 *
 * Strategie:
 *  1. /shows lijst → 9 show-slugs
 *  2. Per show-page → eerste FareHarbor item-id (niet 140084 — die is
 *     de generic "Tickets" knop, gedeeld door alle pages)
 *  3. Per item: fetch /api/v1/companies/boomchicago/items/{id}/calendar/{Y}/{M}/
 *     voor 6 maanden vooruit → availabilities (datums + tijden)
 *  4. Per item: fetch structured-description voor de beschrijving
 *  5. Per item: fetch /images/ voor de eerste foto
 *
 * Idempotency:
 *  - eventId      = `evt-bc-{itemId}`
 *  - occurrenceId = `occ-bc-{availabilityPk}`
 */

const VENUE_ID = 'boom-chicago';
const UA = 'Mozilla/5.0 (Andreas/1.0; +https://andreas.amsterdam)';
const FH_BASE = 'https://fareharbor.com/api/v1/companies/boomchicago';
const FH_ITEMS_BASE = 'https://fareharbor.com/api/items/v1/boomchicago';
const SHOWS_LIST_URL = 'https://boomchicago.nl/shows';

/** "Tickets" / wildcard item-id, op elke /shows/{slug}/ pagina embed
    als generic CTA. Niet de echte show-item. */
const TICKETS_WILDCARD_ITEM = '140084';

type FhAvailability = {
  pk: number;
  start_at: string;
  end_at?: string | null;
  is_sold_out?: boolean;
  is_bookable?: boolean;
  item?: { pk?: number; name?: string };
};

type FhCalendar = {
  calendar: {
    year: number;
    month: number;
    weeks: Array<{
      days: Array<{
        at: string;
        availabilities: FhAvailability[];
      }>;
    }>;
  };
};

type FhStructuredDesc = {
  description?: string;
  short_description?: string;
};

type FhItem = {
  item: {
    pk: number;
    name: string;
  };
};

type FhImages = {
  images: Array<{ image_url?: string; image_cdn_url?: string }>;
};

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/json', referer: 'https://fareharbor.com/' },
    });
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

async function discoverShows(): Promise<Array<{ slug: string; itemId: string }>> {
  const html = await fetchHtml(SHOWS_LIST_URL);
  if (!html) return [];
  const slugs = new Set<string>();
  for (const m of html.matchAll(/href="\/shows\/([a-z][a-z0-9-]+)\/"/g)) {
    slugs.add(m[1]);
  }
  const out: Array<{ slug: string; itemId: string }> = [];
  for (const slug of slugs) {
    const showHtml = await fetchHtml(`https://boomchicago.nl/shows/${slug}/`);
    if (!showHtml) continue;
    // Find all item-IDs and skip the wildcard 140084
    const ids = new Set<string>();
    for (const m of showHtml.matchAll(/\/items\/(\d+)/g)) {
      if (m[1] !== TICKETS_WILDCARD_ITEM) ids.add(m[1]);
    }
    const itemId = Array.from(ids)[0];
    if (itemId) out.push({ slug, itemId });
  }
  return out;
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

/** Strip subtitle "| Amsterdam's Best Stand-Up Comedy" etc. */
function cleanShowName(name: string): string {
  return name.replace(/\s*\|\s*.+$/, '').trim();
}

async function fetchCalendarRange(
  itemId: string,
  monthsAhead: number
): Promise<FhAvailability[]> {
  const all: FhAvailability[] = [];
  const seen = new Set<number>();
  const now = new Date();
  for (let i = 0; i < monthsAhead; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const url = `${FH_BASE}/items/${itemId}/calendar/${y}/${m}/?allow_grouped=yes&bookable_only=no&asn=&path=1&is_fh_app=no`;
    const data = await fetchJson<FhCalendar>(url);
    if (!data?.calendar?.weeks) continue;
    for (const week of data.calendar.weeks) {
      for (const day of week.days) {
        // Skip days die buiten de gevraagde maand vallen (FH calendars
        // tonen ook "other"-month-days uit voor/na voor visuele padding)
        if (!day.at.startsWith(`${y}-${m}-`)) continue;
        for (const av of day.availabilities ?? []) {
          if (av.pk && !seen.has(av.pk)) {
            seen.add(av.pk);
            all.push(av);
          }
        }
      }
    }
  }
  return all;
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
    return await uploadToBunny(`media/events/bc-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[boomchicago] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type BoomChicagoResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeBoomChicago(options?: {
  venueIds?: string[];
}): Promise<BoomChicagoResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: BoomChicagoResult = {
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
  const venueCategory = venue.categories?.[0] ?? 'Theater';

  const shows = await discoverShows();
  result.fetched = shows.length;
  if (shows.length === 0) {
    result.errors.push('geen shows ontdekt op /shows/');
    return [result];
  }

  for (const show of shows) {
    try {
      const eventId = `evt-bc-${show.itemId}`;

      // Item-naam altijd ophalen (cheap call, geen Claude/image-mirror)
      const itemData = await fetchJson<FhItem>(`${FH_BASE}/items/${show.itemId}/`);
      if (!itemData?.item?.name) { result.skipped++; continue; }
      const title = cleanShowName(itemData.item.name);

      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      // Calendars altijd: status (sold_out, cancelled) en nieuwe datums
      // kunnen wijzigen tussen runs.
      const availabilities = await fetchCalendarRange(show.itemId, 6);

      if (!existing) {
        // Nieuw event: fetch description + image
        const descData = await fetchJson<FhStructuredDesc>(
          `${FH_ITEMS_BASE}/${show.itemId}/structured-description/`
        );
        const rawDesc = descData?.description ?? descData?.short_description ?? null;
        const description = rawDesc ? stripHtml(rawDesc) : null;

        const imagesData = await fetchJson<FhImages>(`${FH_BASE}/items/${show.itemId}/images/`);
        const sourceImg =
          imagesData?.images?.[0]?.image_cdn_url ??
          imagesData?.images?.[0]?.image_url ??
          null;

        let imageUrl: string | null = null;
        if (sourceImg) {
          imageUrl = (await mirrorImage(sourceImg, `${show.slug}-${show.itemId}`)) ?? sourceImg;
        }

        let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;
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

        const headStart = availabilities[0]?.start_at
          ? new Date(availabilities[0].start_at)
          : new Date();
        const headEnd = availabilities[0]?.end_at ? new Date(availabilities[0].end_at) : null;
        const eventKind = refineKindByDuration(enriched?.kind ?? 'show', headStart, headEnd);

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
            genres: enriched?.genres ?? ['comedy'],
            published: true,
          });
          result.inserted++;
        } catch (e) {
          result.errors.push(`insert event ${eventId}: ${(e as Error).message}`);
          continue;
        }
      }

      // Occurrences upsert. Skip die >6u voorbij zijn.
      const cutoff = Date.now() - 6 * 60 * 60 * 1000;
      for (const av of availabilities) {
        try {
          const startsAt = new Date(av.start_at);
          if (isNaN(startsAt.getTime())) { result.skipped++; continue; }
          const endsAt = av.end_at ? new Date(av.end_at) : null;
          const refTime = (endsAt ?? startsAt).getTime();
          if (refTime < cutoff) { result.skipped++; continue; }

          const occurrenceId = `occ-bc-${av.pk}`;
          const status = av.is_sold_out ? 'sold_out' : 'scheduled';
          const ticketUrl = `https://fareharbor.com/embeds/book/boomchicago/items/${show.itemId}/?full-items=yes`;

          await db
            .insert(schema.occurrences)
            .values({
              id: occurrenceId,
              eventId,
              startsAt,
              endsAt,
              priceCents: null,
              priceNote: null,
              ticketUrl,
              room: null,
              lineup: null,
              status,
            })
            .onConflictDoUpdate({
              target: schema.occurrences.id,
              set: { startsAt, endsAt, ticketUrl, status },
            });
          result.occurrencesUpserted++;
        } catch (e) {
          result.errors.push(`occurrence ${av.pk}: ${(e as Error).message}`);
          result.skipped++;
        }
      }
    } catch (e) {
      result.errors.push(`show ${show.slug}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
