import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Ticketmaster Discovery API scraper. Multi-venue: gebruikt
 * `scraperConfig.ticketmaster.venueIds[]` per venue om TM venueIds op
 * te halen. Bij venues die vroeger niet via Andreas gescraped konden
 * worden (Cloudflare bij AFAS Live, eigen ticketsystemen bij Carré /
 * DeLaMar / Theater Amsterdam) gebruiken we de Discovery API als bron.
 *
 * Tier-dedup: TM lijst dezelfde show vaak meerdere keren ("Title",
 * "Title | VIP Packages", "Title | Comfort Seats"). We strippen
 * `\s*\|\s*.+$` van de titel en dedupen op (cleanTitle, localDate).
 *
 * Title-grouping: dezelfde show op meerdere avonden (Luke Combs ×3,
 * Harry Styles ×2) → 1 event-row met N occurrences.
 *
 * Idempotency: eventId = `evt-tm-{venueId}-{slug(cleanTitle)}`,
 * occurrenceId = `evt-tm-{venueId}-{slug(cleanTitle)}-{localDate}`.
 */

const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const API = 'https://app.ticketmaster.com/discovery/v2/events.json';

type TmImage = { url: string; width: number; height: number };

type TmAttraction = {
  id?: string;
  name?: string;
  externalLinks?: {
    wiki?: Array<{ url?: string }>;
    homepage?: Array<{ url?: string }>;
  };
};

type TmEvent = {
  id: string;
  name: string;
  url?: string;
  dates?: {
    start?: { localDate?: string; localTime?: string; dateTime?: string };
    end?: { localDate?: string; localTime?: string; dateTime?: string };
    status?: { code?: string };
  };
  images?: TmImage[];
  classifications?: Array<{
    segment?: { name?: string };
    genre?: { name?: string };
    subGenre?: { name?: string };
  }>;
  info?: string;
  pleaseNote?: string;
  priceRanges?: Array<{ min?: number; max?: number; currency?: string }>;
  _embedded?: {
    attractions?: TmAttraction[];
  };
};

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function cleanTitle(name: string): string {
  return name.replace(/\s*\|\s*.+$/, '').trim();
}

function pickImageUrl(images: TmImage[] | undefined): string | null {
  if (!images?.length) return null;
  const sorted = [...images].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  for (const img of sorted) {
    if (!/_RECOMENDATION_|_RETINA_PORTRAIT_3_2/i.test(img.url)) return img.url;
  }
  return sorted[0]?.url ?? null;
}

/**
 * TM Discovery API levert geen description bij events. Maar de
 * `_embedded.attractions[0].externalLinks.wiki[0].url` wijst naar de
 * Wikipedia-pagina van de hoofdartiest. We pakken daar de summary
 * (1-2 alinea's) als bron voor enrichEvent. Werkt het beste voor
 * iconen (Music): bij comedy/theater-acts soms geen Wiki-link.
 */
async function fetchWikipediaSummaryByTitle(lang: string, title: string): Promise<string | null> {
  const api = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  const r = await fetch(api, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!r.ok) return null;
  const d = (await r.json()) as { extract?: string; type?: string };
  if (d.type === 'disambiguation') return null;
  const extract = (d.extract ?? '').trim();
  return extract.length > 30 ? extract : null;
}

async function fetchWikipediaSummary(wikiUrl: string): Promise<string | null> {
  try {
    const m = wikiUrl.match(/\/wiki\/([^?#]+)/);
    if (!m) return null;
    const title = decodeURIComponent(m[1]);
    const lang = /^(\w{2,3})\.wikipedia\.org/.exec(new URL(wikiUrl).host)?.[1] ?? 'en';
    return await fetchWikipediaSummaryByTitle(lang, title);
  } catch {
    return null;
  }
}

/**
 * Type-bepaling voor relevance-check. Music-acts moeten in hun Wiki-
 * summary een muziek-keyword hebben, comedy-acts een comedy-keyword.
 * Anders is de gevonden Wikipedia-pagina vermoedelijk een homoniem
 * (Typhoon → novella, Josh Wolf → soccer player, Khalid → naam-uitleg).
 */
type ActKind = 'music' | 'comedy' | 'unknown';

function actKind(ev: TmEvent): ActKind {
  const segments = (ev.classifications ?? []).map((c) => c.segment?.name ?? '');
  const subgenres = (ev.classifications ?? []).map((c) => c.subGenre?.name ?? '');
  if (segments.includes('Music')) return 'music';
  if (segments.includes('Arts & Theatre') && subgenres.some((s) => /comedy/i.test(s))) return 'comedy';
  return 'unknown';
}

function isRelevantSummary(summary: string, kind: ActKind): boolean {
  const s = summary.toLowerCase();
  if (kind === 'music') {
    return /\b(singer|band|musician|rapper|songwriter|composer|orchestra|dj|duo|trio|ensemble|hip-hop|rock|pop|metal|jazz|electronic|producer|guitarist|drummer|bassist|vocalist|group)\b/.test(
      s
    );
  }
  if (kind === 'comedy') return /\b(comedian|comedy|stand-?up)\b/.test(s);
  return true;
}

/**
 * Wikipedia search-fallback. Probeert eerst directe summary (vaak
 * lukt dat al), anders opensearch met type-context.
 */
async function searchWikipediaSummary(name: string, kind: ActKind): Promise<string | null> {
  try {
    // Stap 1: directe summary (bijv. "Cypress Hill" → American hip-hop group)
    const direct = await fetchWikipediaSummaryByTitle('en', name);
    if (direct && isRelevantSummary(direct, kind)) return direct;

    // Stap 2: opensearch met context-hint voor homoniem-disambiguatie
    const context = kind === 'music' ? 'singer' : kind === 'comedy' ? 'comedian' : null;
    if (!context) return null;
    const query = `${name} ${context}`;
    const api = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(
      query
    )}&limit=3&namespace=0&format=json`;
    const r = await fetch(api, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const d = (await r.json()) as [string, string[], string[], string[]];
    const titles = d[1] ?? [];
    const nameNorm = name.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    for (const title of titles) {
      const tNorm = title
        .toLowerCase()
        .replace(/\s*\([^)]+\)\s*$/, '')
        .replace(/[^a-z0-9 ]/g, '')
        .trim();
      if (tNorm === nameNorm || tNorm.startsWith(nameNorm) || nameNorm.startsWith(tNorm)) {
        const summary = await fetchWikipediaSummaryByTitle('en', title);
        if (summary && isRelevantSummary(summary, kind)) return summary;
      }
    }
    return null;
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
    if (buf.byteLength > 8 * 1024 * 1024) return null;
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    return await uploadToBunny(`media/events/tm-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[ticketmaster] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

async function fetchVenueEvents(tmVenueId: string, apiKey: string, keyword?: string): Promise<TmEvent[]> {
  const all: TmEvent[] = [];
  let page = 0;
  const size = 100;
  for (;;) {
    const u = new URL(API);
    u.searchParams.set('venueId', tmVenueId);
    u.searchParams.set('size', String(size));
    u.searchParams.set('page', String(page));
    u.searchParams.set('apikey', apiKey);
    if (keyword) u.searchParams.set('keyword', keyword);
    const r = await fetch(u, { headers: { 'user-agent': UA } });
    if (!r.ok) {
      console.warn(`[ticketmaster] venueId=${tmVenueId} page=${page}: HTTP ${r.status}`);
      break;
    }
    const d = (await r.json()) as { _embedded?: { events?: TmEvent[] }; page?: { totalPages?: number } };
    const events = d._embedded?.events ?? [];
    all.push(...events);
    const totalPages = d.page?.totalPages ?? 1;
    if (page + 1 >= totalPages || events.length === 0) break;
    page++;
    if (page >= 50) break;
  }
  return all;
}

type EventCategory = 'Muziek' | 'Theater' | 'Literatuur' | 'Film' | 'Kunst';

function inferCategory(ev: TmEvent, fallback: EventCategory): EventCategory {
  const segments = (ev.classifications ?? [])
    .map((c) => c.segment?.name)
    .filter((s): s is string => Boolean(s));
  if (segments.includes('Music')) return 'Muziek';
  if (segments.includes('Arts & Theatre')) return 'Theater';
  if (segments.includes('Film')) return 'Film';
  return fallback;
}

function tmGenresToList(ev: TmEvent): string[] {
  const out = new Set<string>();
  for (const c of ev.classifications ?? []) {
    if (c.genre?.name && c.genre.name !== 'Undefined') out.add(c.genre.name);
    if (c.subGenre?.name && c.subGenre.name !== 'Undefined' && c.subGenre.name !== c.genre?.name) {
      out.add(c.subGenre.name);
    }
  }
  return Array.from(out).slice(0, 4);
}

export type TicketmasterVenueResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeTicketmaster(options?: {
  venueIds?: string[];
}): Promise<TicketmasterVenueResult[]> {
  const apiKey = process.env.TICKETMASTER_API_KEY;
  if (!apiKey) {
    console.warn('[ticketmaster] geen TICKETMASTER_API_KEY in env — skipping');
    return [];
  }

  const allVenues = await db.select().from(schema.venues);
  const targets = allVenues.filter((v) => {
    if (options?.venueIds && !options.venueIds.includes(v.id)) return false;
    return Boolean(v.scraperConfig?.ticketmaster?.venueIds?.length);
  });

  const results: TicketmasterVenueResult[] = [];

  for (const venue of targets) {
    const cfg = venue.scraperConfig!.ticketmaster!;
    const result: TicketmasterVenueResult = {
      venueId: venue.id,
      fetched: 0,
      inserted: 0,
      occurrencesUpserted: 0,
      skipped: 0,
      errors: [],
    };

    const venueCategory: EventCategory = (venue.categories?.[0] as EventCategory) ?? 'Muziek';

    // Fetch alle events over alle TM-venueIds van deze Andreas-venue
    const raw: TmEvent[] = [];
    for (const tmId of cfg.venueIds) {
      try {
        const evs = await fetchVenueEvents(tmId, apiKey, cfg.keyword);
        raw.push(...evs);
      } catch (e) {
        result.errors.push(`tm venueId=${tmId}: ${(e as Error).message}`);
      }
    }
    result.fetched = raw.length;

    // Dedup tier-suffixes: groepeer op (cleanTitle, localDate). Pak de
    // eerste hit (vaak de basis-tier zonder " | ").
    const groups = new Map<string, TmEvent>();
    for (const ev of raw) {
      const localDate = ev.dates?.start?.localDate;
      if (!localDate) { result.skipped++; continue; }
      const ct = cleanTitle(ev.name);
      const key = `${ct.toLowerCase()}__${localDate}`;
      const prev = groups.get(key);
      if (!prev) {
        groups.set(key, ev);
        continue;
      }
      // Voorkeur: titel zonder " | " (basis-tier)
      const prevHasSuffix = / \| /.test(prev.name);
      const curHasSuffix = / \| /.test(ev.name);
      if (prevHasSuffix && !curHasSuffix) groups.set(key, ev);
    }

    // Title-groepen voor multi-night: per cleanTitle één event-row
    type Group = { cleanTitle: string; events: TmEvent[] };
    const byTitle = new Map<string, Group>();
    for (const ev of groups.values()) {
      const ct = cleanTitle(ev.name);
      const key = ct.toLowerCase();
      const g = byTitle.get(key);
      if (g) g.events.push(ev);
      else byTitle.set(key, { cleanTitle: ct, events: [ev] });
    }

    // Sorteer per groep op startDate
    for (const g of byTitle.values()) {
      g.events.sort((a, b) => {
        const da = a.dates?.start?.dateTime ?? a.dates?.start?.localDate ?? '';
        const db_ = b.dates?.start?.dateTime ?? b.dates?.start?.localDate ?? '';
        return da.localeCompare(db_);
      });
    }

    for (const group of byTitle.values()) {
      const titleSlug = slugify(group.cleanTitle);
      if (!titleSlug) { result.skipped += group.events.length; continue; }
      const eventId = `evt-tm-${venue.id}-${titleSlug}`;

      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      const head = group.events[0];

      // Bouw shared event-data (alleen nodig bij nieuw event)
      let imageUrl: string | null = null;
      let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;
      let category: EventCategory = venueCategory;
      let eventKind: 'show' | 'exhibition' = 'show';
      let description: string | null = null;

      if (!existing) {
        category = inferCategory(head, venueCategory);
        const tmGenres = tmGenresToList(head);
        const tmDescription = [head.info, head.pleaseNote].filter(Boolean).join('\n\n').trim() || null;

        // TM events hebben standaard geen description. Probeer Wikipedia
        // van de hoofdartiest als bron voor enrichEvent. Eerst de
        // wiki-link uit attraction.externalLinks; bij gemis fallback op
        // search met de attractie-naam.
        let wikiDescription: string | null = null;
        const headAttraction = head._embedded?.attractions?.[0];
        const kind = actKind(head);
        const wikiUrl = headAttraction?.externalLinks?.wiki?.[0]?.url;
        if (!tmDescription && wikiUrl) {
          const direct = await fetchWikipediaSummary(wikiUrl);
          if (direct && isRelevantSummary(direct, kind)) wikiDescription = direct;
        }
        if (!tmDescription && !wikiDescription && headAttraction?.name) {
          wikiDescription = await searchWikipediaSummary(headAttraction.name, kind);
        }
        description = tmDescription ?? wikiDescription;
        try {
          enriched = await enrichEvent({
            title: group.cleanTitle,
            description,
            venueName: venue.name,
            venueCategory: category,
          });
        } catch (e) {
          result.errors.push(`enrich ${group.cleanTitle}: ${(e as Error).message}`);
        }

        const sourceImg = pickImageUrl(head.images);
        if (sourceImg) {
          imageUrl = (await mirrorImage(sourceImg, `${venue.id}-${titleSlug}`)) ?? sourceImg;
        }

        // Combineer TM-genres + Claude-genres (Claude prio)
        const enrichedGenres = enriched?.genres ?? [];
        const mergedGenres = enrichedGenres.length > 0 ? enrichedGenres : tmGenres;

        const headStart = head.dates?.start?.dateTime ?? head.dates?.start?.localDate;
        const headEnd = head.dates?.end?.dateTime ?? head.dates?.end?.localDate;
        const startsAt = headStart ? new Date(headStart) : null;
        const endsAt = headEnd ? new Date(headEnd) : null;
        eventKind = refineKindByDuration(enriched?.kind ?? 'show', startsAt ?? new Date(), endsAt ?? null);

        try {
          await db.insert(schema.events).values({
            id: eventId,
            venueId: venue.id,
            title: group.cleanTitle,
            description: enriched?.cleanedDescription ?? description,
            kind: eventKind,
            imageUrl,
            category: enriched?.category ?? category,
            featured: false,
            genres: mergedGenres,
            published: true,
          });
          result.inserted++;
        } catch (e) {
          result.errors.push(`insert event ${eventId}: ${(e as Error).message}`);
          continue;
        }
      }

      // Voor elk event in de groep → occurrence-upsert
      for (const ev of group.events) {
        try {
          const localDate = ev.dates?.start?.localDate;
          if (!localDate) { result.skipped++; continue; }
          const startDateTime = ev.dates?.start?.dateTime;
          const startsAt = startDateTime ? new Date(startDateTime) : new Date(`${localDate}T20:00:00+02:00`);
          if (isNaN(startsAt.getTime())) { result.skipped++; continue; }
          const endDateTime = ev.dates?.end?.dateTime;
          const endsAt = endDateTime ? new Date(endDateTime) : null;

          const occurrenceId = `occ-tm-${venue.id}-${titleSlug}-${localDate}`;
          const status = ev.dates?.status?.code === 'cancelled' ? 'cancelled' : 'scheduled';
          const ticketUrl = ev.url ?? null;
          const priceCents = ev.priceRanges?.[0]?.min
            ? Math.round(ev.priceRanges[0].min * 100)
            : null;

          await db
            .insert(schema.occurrences)
            .values({
              id: occurrenceId,
              eventId,
              startsAt,
              endsAt,
              priceCents,
              priceNote: enriched?.priceNote ?? null,
              ticketUrl,
              room: enriched?.room ?? null,
              lineup: enriched?.lineup ?? null,
              status,
            })
            .onConflictDoUpdate({
              target: schema.occurrences.id,
              set: {
                startsAt,
                endsAt,
                priceCents,
                ticketUrl,
                status,
              },
            });
          result.occurrencesUpserted++;
        } catch (e) {
          result.errors.push(`occurrence ${ev.id}: ${(e as Error).message}`);
          result.skipped++;
        }
      }
    }

    results.push(result);
  }

  return results;
}
