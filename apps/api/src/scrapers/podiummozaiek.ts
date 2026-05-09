import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Podium Mozaïek (Bos en Lommer). Hun eigen site is een SPA, maar
 * exposeert publieke JSON-data:
 *
 *   GET https://www.podiummozaiek.nl/data/events/all.json
 *
 * Returns array van ~195 events. Per event:
 *  - id (bv. `tm-11869-915fb9d5` voor Ticketmatic-gekoppelde shows,
 *    of een UUID voor eigen producties)
 *  - name (titel)
 *  - custom_description (HTML — uitgebreide beschrijving)
 *  - custom_short (HTML — korte intro)
 *  - custom_labels (Comedy / Theater / Expositie / series:RRREURING)
 *  - custom_images (absolute URL of relatief `/images/{slug}.jpg`)
 *  - startts / endts (ISO timestamps)
 *  - ticket_url, custom_ticket_url
 *  - locationname (zaal)
 *
 * Title-grouping: events met dezelfde clean-title (na strip
 * "(uitverkocht)" e.d.) worden naar één event-row gemerged met N
 * occurrences (matinee+avond op zelfde dag, multi-night).
 *
 * Idempotency: eventId = `evt-pm-{slugify(cleanTitle)}`,
 *              occurrenceId = `occ-pm-{event.id}`.
 */

const VENUE_ID = 'podium-mozaiek';
const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const ALL_EVENTS_URL = 'https://www.podiummozaiek.nl/data/events/all.json';
const BASE = 'https://www.podiummozaiek.nl';

type ApiEvent = {
  id: string;
  name?: string;
  custom_description?: string | null;
  custom_short?: string | null;
  custom_titel?: string | null;
  custom_labels?: string | null;
  custom_images?: string | null;
  custom_ticket_url?: string | null;
  ticket_url?: string | null;
  locationname?: string | null;
  startts?: string | null;
  endts?: string | null;
  _status?: string;
  currentstatus?: number;
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

function cleanTitle(name: string): string {
  return name
    .replace(/\s*\((?:uitverkocht|sold out|wachtlijst|aflasting|geannuleerd|verplaatst)[^)]*\)\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
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

function resolveImageUrl(raw: string): string {
  if (raw.startsWith('http')) return raw;
  if (raw.startsWith('/')) return `${BASE}${raw}`;
  return `${BASE}/${raw}`;
}

async function fetchAllEvents(): Promise<ApiEvent[]> {
  const r = await fetch(ALL_EVENTS_URL, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!r.ok) return [];
  return (await r.json()) as ApiEvent[];
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

  const events = (await fetchAllEvents()).filter(
    (e) => e._status === 'published' && e.name && e.startts
  );
  result.fetched = events.length;
  if (events.length === 0) {
    result.errors.push('geen events in all.json');
    return [result];
  }

  // Title-grouping
  type Group = { titleSlug: string; cleanName: string; head: ApiEvent; events: ApiEvent[] };
  const groups = new Map<string, Group>();
  for (const e of events) {
    const cn = cleanTitle(e.name!);
    const ts = slugify(cn);
    if (!ts) continue;
    const g = groups.get(ts);
    if (g) g.events.push(e);
    else groups.set(ts, { titleSlug: ts, cleanName: cn, head: e, events: [e] });
  }
  // Sort each on startts; head = earliest
  for (const g of groups.values()) {
    g.events.sort((a, b) => (a.startts ?? '').localeCompare(b.startts ?? ''));
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

      const futureEvents = group.events.filter((e) => {
        const t = new Date(e.startts!).getTime();
        return !isNaN(t) && t > cutoff;
      });
      if (futureEvents.length === 0) { result.skipped++; continue; }

      let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;

      if (!existing) {
        const head = group.head;
        // Description: prefer custom_description (lang), fallback custom_short
        const rawDesc =
          head.custom_description?.trim() ||
          head.custom_short?.trim() ||
          null;
        const description = rawDesc ? stripHtml(rawDesc) : null;

        // Image
        let imageUrl: string | null = null;
        if (head.custom_images) {
          const src = resolveImageUrl(head.custom_images);
          imageUrl = (await mirrorImage(src, group.titleSlug)) ?? src;
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

        const headStart = new Date(futureEvents[0]!.startts!);
        const eventKind = refineKindByDuration(enriched?.kind ?? 'show', headStart, null);

        // Genres uit custom_labels (bv. "Comedy", "Theater", "Expositie",
        // "series:RRREURING") als fallback voor Claude-genres
        const labelGenres = head.custom_labels
          ? head.custom_labels
              .split(/[,;|]/)
              .map((s) => s.trim().replace(/^series:/, ''))
              .filter((s) => s && s.length < 30)
          : [];
        const finalGenres = (enriched?.genres?.length ?? 0) > 0 ? enriched!.genres : labelGenres;

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
            genres: finalGenres,
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
          const startsAt = new Date(e.startts!);
          const endsAt = e.endts ? new Date(e.endts.replace(' ', 'T')) : null;
          if (isNaN(startsAt.getTime())) { result.skipped++; continue; }
          const occurrenceId = `occ-pm-${e.id}`;
          const status: 'scheduled' | 'sold_out' = /uitverkocht|sold out/i.test(e.name ?? '') ? 'sold_out' : 'scheduled';
          const ticketUrl = e.custom_ticket_url ?? e.ticket_url ?? null;
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
              room: e.locationname ?? null,
              lineup: existing ? null : (enriched?.lineup ?? null),
              status,
            })
            .onConflictDoUpdate({
              target: schema.occurrences.id,
              set: { startsAt, endsAt, ticketUrl, room: e.locationname ?? null, status },
            });
          result.occurrencesUpserted++;
        } catch (err) {
          result.errors.push(`occurrence ${e.id}: ${(err as Error).message}`);
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
