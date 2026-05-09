import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Internationaal Theater Amsterdam (ITA). Hun /nl/agenda is volledig
 * client-rendered, maar de page roept een **publieke JSON API** aan
 * (geen auth, geen Playwright nodig):
 *
 *   GET /nl/api/v1/channel/events/?lang=nl_nl&sort=startDateTime
 *     &order=asc&limit=50&startDateTime=YYYY-MM-DD
 *     &subRelatedTo=shows.status.live
 *     &with=venue,show,show.headerImage,show.genre,show.director
 *     &page=N
 *
 * Response: `{ data: [...], meta: { pagination: { total, total_pages } } }`.
 * Per event: `show[0]` (zelfde id voor multi-night), `startDateTime`,
 * `venue[0]`, `itaOnTour` (true = ergens anders in NL — skippen).
 *
 * Title-grouping (geleerd van Bimhuis + Concertgebouw): per `show.id`
 * één event-row met N occurrences (één per startDateTime). "Weg met
 * Eddy Bellegueule" speelt bv. 4 avonden in mei — dat is één event.
 *
 * Idempotency:
 *  - eventId      = `evt-ita-{show.id}`
 *  - occurrenceId = `occ-ita-{show.id}-{YYYY-MM-DDTHH:MM}`
 */

const VENUE_ID = 'ita';
const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const API_BASE = 'https://ita.nl/nl/api/v1/channel/events/';

type ApiImage = { url?: string };
type ApiGenre = { title?: string };
type ApiShow = {
  id: number;
  title: string;
  slug?: string;
  url?: string;
  previewIntro?: string;
  intro?: string;
  headerImage?: ApiImage[];
  genre?: ApiGenre[];
};
type ApiEvent = {
  startDateTime?: { date: string; timezone?: string };
  endDateTime?: { date: string; timezone?: string } | null;
  eventStatus?: string;
  itaOnTour?: boolean;
  ticketSaleUrl?: string | null;
  tixPurchaseUrl?: string | null;
  venue?: Array<{ title?: string }>;
  show?: ApiShow[];
};
type ApiResponse = {
  data: ApiEvent[];
  meta: { pagination: { total: number; total_pages: number; current_page: number } };
};

function todayIsoLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

async function fetchPage(page: number, startDate: string): Promise<ApiResponse | null> {
  const u = new URL(API_BASE);
  u.searchParams.set('lang', 'nl_nl');
  u.searchParams.set('sort', 'startDateTime');
  u.searchParams.set('order', 'asc');
  u.searchParams.set('limit', '50');
  u.searchParams.set('startDateTime', startDate);
  u.searchParams.set('subRelatedTo', 'shows.status.live');
  u.searchParams.set('with', 'venue,show,show.headerImage,show.genre,show.director,show.festival');
  u.searchParams.set('page', String(page));
  try {
    const r = await fetch(u, { headers: { 'user-agent': UA, accept: 'application/json' } });
    if (!r.ok) return null;
    return (await r.json()) as ApiResponse;
  } catch {
    return null;
  }
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

async function mirrorImage(sourceUrl: string, slug: string): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 8 * 1024 * 1024) return null;
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    return await uploadToBunny(`media/events/ita-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[ita] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type ItaResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeIta(options?: {
  venueIds?: string[];
}): Promise<ItaResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: ItaResult = {
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

  // Fetch alle pages
  const startDate = todayIsoLocal();
  const allEvents: ApiEvent[] = [];
  const first = await fetchPage(1, startDate);
  if (!first) {
    result.errors.push('eerste page faalde');
    return [result];
  }
  allEvents.push(...first.data);
  const totalPages = first.meta?.pagination?.total_pages ?? 1;
  for (let p = 2; p <= totalPages && p <= 50; p++) {
    const next = await fetchPage(p, startDate);
    if (!next) {
      result.errors.push(`page ${p} faalde`);
      break;
    }
    allEvents.push(...next.data);
  }
  result.fetched = allEvents.length;

  // Filter: alleen ITA Amsterdam events (skip itaOnTour=true)
  const inHouse = allEvents.filter((e) => e.itaOnTour !== true && e.show && e.show[0]);

  // Group op show.id (multi-night = zelfde show, verschillende dagen)
  type Group = { show: ApiShow; events: ApiEvent[] };
  const groups = new Map<number, Group>();
  for (const ev of inHouse) {
    const show = ev.show?.[0];
    if (!show?.id) continue;
    const g = groups.get(show.id);
    if (g) g.events.push(ev);
    else groups.set(show.id, { show, events: [ev] });
  }

  const cutoff = Date.now() - 6 * 60 * 60 * 1000;

  for (const [showId, group] of groups) {
    try {
      const eventId = `evt-ita-${showId}`;
      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      // Sort events op startDateTime
      group.events.sort((a, b) =>
        (a.startDateTime?.date ?? '').localeCompare(b.startDateTime?.date ?? '')
      );

      // Skip als alle slots in het verleden zijn
      const futureEvents = group.events.filter((ev) => {
        const t = new Date(`${(ev.startDateTime?.date ?? '').replace(' ', 'T')}+02:00`).getTime();
        return !isNaN(t) && t > cutoff;
      });
      if (futureEvents.length === 0) { result.skipped++; continue; }

      let imageUrl: string | null = null;
      let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;
      let description: string | null = null;
      let eventKind: 'show' | 'exhibition' = 'show';

      if (!existing) {
        const show = group.show;
        description =
          (show.previewIntro ? stripHtml(show.previewIntro) : null) ??
          (show.intro ? stripHtml(show.intro) : null);

        try {
          enriched = await enrichEvent({
            title: show.title,
            description,
            venueName: venue.name,
            venueCategory,
          });
        } catch (e) {
          result.errors.push(`enrich ${show.title}: ${(e as Error).message}`);
        }

        // ITA's image-server geeft "cache resources exhausted" voor
        // originele files maar werkt met `?w=1200` transform-trigger.
        const rawImg = show.headerImage?.[0]?.url ?? null;
        const sourceImg = rawImg && !rawImg.includes('?') ? `${rawImg}?w=1200` : rawImg;
        if (sourceImg) {
          imageUrl = (await mirrorImage(sourceImg, `${show.slug ?? showId}`)) ?? sourceImg;
        }

        const headStart = new Date(
          `${(futureEvents[0]!.startDateTime!.date).replace(' ', 'T')}+02:00`
        );
        const headEnd = futureEvents[0]?.endDateTime?.date
          ? new Date(`${futureEvents[0]!.endDateTime!.date.replace(' ', 'T')}+02:00`)
          : null;
        eventKind = refineKindByDuration(enriched?.kind ?? 'show', headStart, headEnd);

        // Genres uit ITA + enrichEvent merge
        const apiGenres = (show.genre ?? [])
          .map((g) => g.title)
          .filter((s): s is string => Boolean(s));
        const finalGenres = (enriched?.genres?.length ?? 0) > 0
          ? enriched!.genres
          : apiGenres;

        try {
          await db.insert(schema.events).values({
            id: eventId,
            venueId: venue.id,
            title: show.title,
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

      for (const ev of futureEvents) {
        try {
          const startsAt = new Date(`${ev.startDateTime!.date.replace(' ', 'T')}+02:00`);
          if (isNaN(startsAt.getTime())) { result.skipped++; continue; }
          const endsAt = ev.endDateTime?.date
            ? new Date(`${ev.endDateTime.date.replace(' ', 'T')}+02:00`)
            : null;

          const isoSlot = ev.startDateTime!.date.replace(' ', 'T').slice(0, 16).replace(':', '-');
          const occurrenceId = `occ-ita-${showId}-${isoSlot}`;
          const ticketUrl = ev.tixPurchaseUrl ?? ev.ticketSaleUrl ?? group.show.url ?? null;

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
          result.errors.push(`occurrence ${ev.startDateTime?.date}: ${(e as Error).message}`);
          result.skipped++;
        }
      }
    } catch (e) {
      result.errors.push(`group ${showId}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
