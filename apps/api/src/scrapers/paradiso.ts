import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';
import { loadVenueTitleMap, resolveEventId } from './_title-dedup.js';

/**
 * Paradiso scraper via GraphQL. De homepage toont maar een 'In the
 * picture' selectie (~20 events), maar hun GraphQL-API
 * (knwxh8dmh1.execute-api.eu-central-1.amazonaws.com/graphql) geeft het
 * volledige programma terug — inclusief events die niet in Paradiso
 * zelf maar in zustervenues spelen (Tolhuistuin, Bitterzoet, Doka).
 *
 * We routeren elk event op `location.title` naar de juiste venue in
 * onze DB. Locaties met een eigen actieve scraper (cinetol via Stager)
 * worden geskipt om duplicates te voorkomen.
 *
 * Per-event description is alleen `subtitle` (~60 chars) in de GraphQL.
 * Voor de rijkere body fetchen we de detail-pagina via Playwright.
 *
 * Idempotency: event-id = `evt-par-{venueId}-{paradisoEventId}`. De
 * Paradiso-id is stabiel over scrapes heen.
 */

const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const GRAPHQL_URL =
  'https://knwxh8dmh1.execute-api.eu-central-1.amazonaws.com/graphql';
const HOMEPAGE = 'https://www.paradiso.nl';

/**
 * Mapping van Paradiso's `location.title` (zoals dat in hun GraphQL
 * verschijnt) naar onze venue.id. Locaties die hier niet in staan
 * worden geskipt (geen eigen venue-record OF venue heeft eigen
 * scraper die voor conflict zou zorgen).
 */
const LOCATION_TO_VENUE: Record<string, string> = {
  Paradiso: 'paradiso',
  Tolhuistuin: 'tolhuistuin',
  Bitterzoet: 'bitterzoet',
  Doka: 'doka',
};

/** Locaties die we expliciet skippen — deze venues hebben een eigen
 *  actieve scraper (Cinetol via Stager) waardoor Paradiso-events daar
 *  zouden dupliceren. */
const SKIP_LOCATIONS = new Set<string>(['Cinetol']);

type ParadisoImageVariant = {
  desktop?: string;
  desktop2x?: string;
  desktopXL?: string;
  desktopXL2x?: string;
  type?: string;
};

type ParadisoGqlEvent = {
  id: string;
  uri: string;
  title: string;
  subtitle: string | null;
  startDateTime: string;
  date: string;
  eventStatus: string;
  highlight: boolean;
  supportAct: string | null;
  soldOut: 'yes' | 'no' | string;
  location: { id: string; title: string }[];
  image: ParadisoImageVariant[];
};

async function fetchAllEvents(): Promise<ParadisoGqlEvent[]> {
  const all: ParadisoGqlEvent[] = [];
  // searchAfter werkt cursor-based: pagineer tot lege response of safety-brake.
  let searchAfter: string[] | null = null;
  const PAGE = 50;
  const QUERY = `query Q($site:String,$size:Int,$gte:String,$searchAfter:[String]){
    program(site:$site,size:$size,gteStartDateTime:$gte,searchAfter:$searchAfter){
      events {
        id uri title subtitle startDateTime date eventStatus highlight supportAct soldOut sort
        location { id title }
        image { desktop desktop2x desktopXL desktopXL2x type }
      }
    }
  }`;

  for (let i = 0; i < 20; i++) {
    const body = {
      query: QUERY,
      variables: {
        site: 'paradisoNederlands',
        size: PAGE,
        gte: new Date().toISOString(),
        searchAfter,
      },
    };
    const r = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': UA,
        origin: HOMEPAGE,
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`GraphQL HTTP ${r.status}`);
    const j = (await r.json()) as {
      data: { program: { events: (ParadisoGqlEvent & { sort?: string[] })[] } };
    };
    const events = j.data?.program?.events ?? [];
    if (events.length === 0) break;
    all.push(...events);
    if (events.length < PAGE) break;
    // Cursor: laatste item's `sort` array
    const lastSort = events[events.length - 1].sort;
    if (!lastSort) break;
    searchAfter = lastSort;
  }
  return all;
}

/** Pak grootste image variant. Paradiso geeft per event meerdere image-
 *  blokken (default/relatedArtists/mediumSquare/narrowCasting/
 *  subBrandImages). Default heeft de meest neutrale crop, maar
 *  narrowCasting (1920x1080) of subBrandImages (~600x780) zijn groter. */
function pickLargestImage(images: ParadisoImageVariant[] | undefined): string | null {
  if (!images || images.length === 0) return null;
  // Prefer narrowCasting (full-resolution photo)
  const narrowCasting = images.find((i) => i.type === 'narrowCasting');
  const subBrand = images.find((i) => i.type === 'subBrandImages');
  const def = images.find((i) => i.type === 'default') ?? images[0];
  const candidate = narrowCasting ?? subBrand ?? def;
  // Pak hoogste resolutie binnen de candidate
  return (
    candidate.desktopXL2x ?? candidate.desktopXL ?? candidate.desktop2x ?? candidate.desktop ?? null
  );
}

async function mirrorImage(
  sourceUrl: string,
  stableId: string
): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 8 * 1024 * 1024) return null;
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    const path = `media/events/par-${stableId}.${ext}`;
    return await uploadToBunny(path, buf, mime);
  } catch (e) {
    console.warn(`[paradiso] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

type ParadisoDetail = {
  description: string | null;
  hour: number | null;
  minute: number | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function renderDetail(browser: any, url: string): Promise<ParadisoDetail> {
  const ctx = await browser.newContext({ locale: 'nl-NL', userAgent: UA });
  const page = await ctx.newPage();
  try {
    // Twee losse oorzaken achter de 36 van 439 events die wegvielen:
    //
    // 1. `networkidle` haalde 30s niet door open analytics-verbindingen,
    //    terwijl de pagina zelf al lang stond. `domcontentloaded` +
    //    selector-wait is genoeg — zelfde patroon als bimhuis.ts /
    //    melkweg.ts. Gezonde detail-pages zijn <2s binnen, dus 15s is ruim.
    // 2. Paradiso's origin geeft intermittent een 500 ná 30s op detail-
    //    pages; dezelfde URL geeft de volgende poging een snelle 200.
    //    Los gemeten ~50% faalkans per poging, maar de faals zijn NIET
    //    onafhankelijk: in een volle run haalden 3 pogingen skipped van
    //    36 → 22, niet naar ~4. De origin degradeert onder onze eigen
    //    sequentiële load, dus meer pogingen kopen weinig.
    // ponytail: 3 pogingen, geen backoff — kost ~2 min extra wall-clock
    // voor 14 events. Volgende lever is throttlen tussen requests (of
    // een langere pauze na een 500), niet nóg meer pogingen.
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForSelector('main', { timeout: 10000 });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e as Error;
      }
    }
    if (lastErr) throw lastErr;
    await page.waitForTimeout(800);
    const result: ParadisoDetail = await page.evaluate(`(() => {
      const main = document.querySelector('main') ?? document.body;
      const text = main.innerText;
      const lines = text.split('\\n').map(s => s.trim()).filter(Boolean);
      const stop = lines.findIndex(l => /^(Line-up|Route|Accepteer|Bovenzaal\\s*$)/i.test(l));
      const start = lines.findIndex(l => l.length > 80);
      let desc = null;
      if (start >= 0) {
        const end = stop > start ? stop : Math.min(start + 6, lines.length);
        desc = lines.slice(start, end).filter(l => l.length > 30).join('\\n\\n');
      }
      const timeMatch = text.match(/(?:Hoofdprogramma|Aanvang|Show)[:\\s]+(\\d{1,2}):(\\d{2})/);
      const hour = timeMatch ? parseInt(timeMatch[1], 10) : null;
      const minute = timeMatch ? parseInt(timeMatch[2], 10) : null;
      return { description: desc, hour, minute };
    })()`);
    return result;
  } finally {
    await ctx.close();
  }
}

export type ParadisoResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeParadiso(options?: {
  venueIds?: string[];
}): Promise<ParadisoResult[]> {
  // Resultaat per venue, want we kunnen events naar Tolhuistuin/Bitterzoet enz routeren.
  const results = new Map<string, ParadisoResult>();
  const ensure = (venueId: string): ParadisoResult => {
    let r = results.get(venueId);
    if (!r) {
      r = {
        venueId,
        fetched: 0,
        inserted: 0,
        occurrencesUpserted: 0,
        skipped: 0,
        errors: [],
      };
      results.set(venueId, r);
    }
    return r;
  };

  let events: ParadisoGqlEvent[];
  try {
    events = await fetchAllEvents();
  } catch (e) {
    const r = ensure('paradiso');
    r.errors.push(`graphql: ${(e as Error).message}`);
    return [r];
  }

  // Cache van venue-records die we vinden, plus categorieën-fallbacks.
  const venueCache = new Map<string, typeof schema.venues.$inferSelect>();
  for (const slug of Object.values(LOCATION_TO_VENUE)) {
    const [v] = await db
      .select()
      .from(schema.venues)
      .where(eq(schema.venues.id, slug));
    if (v) venueCache.set(slug, v);
  }

  // Browser éénmaal voor alle detail-renders.
  const { chromium } = await import('playwright');
  // Paradiso's CMS geeft per avond een eigen numeriek id, dus een
  // meerdaagse run werd N events ("Fat Freddy's Drop" 12/13/14 okt) en
  // een terugkerende avond idem. Titel binnen de venue is de identiteit.
  // Per venue een eigen map, want deze scraper routeert ook naar
  // Tolhuistuin/Bitterzoet/Doka. Lazy: alleen venues die we echt zien.
  type TitleMap = Awaited<ReturnType<typeof loadVenueTitleMap>>;
  const titleMaps = new Map<string, TitleMap>();
  const titleMapFor = async (vid: string): Promise<TitleMap> => {
    let m = titleMaps.get(vid);
    if (!m) {
      m = await loadVenueTitleMap(vid, `evt-par-${vid}-`);
      titleMaps.set(vid, m);
    }
    return m;
  };

  const browser = await chromium.launch({ headless: true });

  try {
    for (const ev of events) {
      const locTitle = ev.location?.[0]?.title ?? '';
      if (SKIP_LOCATIONS.has(locTitle)) continue;
      const venueId = LOCATION_TO_VENUE[locTitle];
      if (!venueId) continue; // onbekende venue-naam; skip

      // Opt-in filter via --venue
      if (options?.venueIds && !options.venueIds.includes(venueId)) continue;

      const venue = venueCache.get(venueId);
      if (!venue) continue;

      const r = ensure(venueId);
      r.fetched++;

      try {
        // Description komt uit renderDetail (Playwright), ná dit punt —
        // dus de datum is hier het enige signaal.
        const { eventId } = resolveEventId(
          await titleMapFor(venueId),
          ev.title,
          `evt-par-${venueId}-${ev.id}`,
          { startsAt: new Date(ev.startDateTime) }
        );
        const occurrenceId = `occ-par-${venueId}-${ev.id}`;
        const ticketUrl = `${HOMEPAGE}/${ev.uri.replace(/^\//, '')}`;
        const startsAt = new Date(ev.startDateTime);
        const venueCategory = venue.categories?.[0] ?? 'Muziek';

        const status: 'scheduled' | 'cancelled' | 'sold_out' =
          ev.eventStatus?.toLowerCase().includes('cancel')
            ? 'cancelled'
            : ev.soldOut === 'yes'
              ? 'sold_out'
              : 'scheduled';

        // Vroege existing-check: bestaat dit event al, dan alleen
        // de occurrence updaten (tijd/status kan wijzigen). Skip
        // de dure renderDetail() + enrichEvent() en image-mirror.
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
              priceCents: null,
              priceNote: null,
              ticketUrl,
              room: null,
              lineup: null,
              status,
            })
            .onConflictDoUpdate({
              target: schema.occurrences.id,
              // eventId meenemen: occurrences die nog aan een
              // per-avond-event hingen verhuizen zo zelf naar het
              // canonieke event.
              set: { eventId, startsAt, ticketUrl, status },
            });
          r.occurrencesUpserted++;
          continue;
        }

        // Nieuw event — volle flow met Playwright + Claude.
        const detail = await renderDetail(browser, ticketUrl);
        const description = detail.description ?? ev.subtitle;
        const imageSource = pickLargestImage(ev.image);

        const enriched = await enrichEvent({
          title: ev.title,
          description,
          venueName: venue.name,
          venueCategory,
        });

        let imageUrl: string | null = null;
        if (imageSource) {
          imageUrl = (await mirrorImage(imageSource, ev.id)) ?? null;
        }

        const refinedKind = refineKindByDuration(enriched.kind, startsAt, null);

        await db.transaction(async (tx) => {
          await tx.insert(schema.events).values({
            id: eventId,
            venueId,
            title: ev.title,
            description: enriched.cleanedDescription ?? description,
            kind: refinedKind,
            imageUrl,
            category: enriched.category ?? venueCategory,
            featured: ev.highlight,
            genres: enriched.genres,
            published: true,
          });
          r.inserted++;

          await tx
            .insert(schema.occurrences)
            .values({
              id: occurrenceId,
              eventId,
              startsAt,
              endsAt: null,
              priceCents: null,
              priceNote: enriched.priceNote,
              ticketUrl,
              room: enriched.room,
              lineup: enriched.lineup,
              status,
            })
            .onConflictDoUpdate({
              target: schema.occurrences.id,
              set: {
                eventId,
                startsAt,
                priceNote: enriched.priceNote,
                ticketUrl,
                room: enriched.room,
                lineup: enriched.lineup,
                status,
              },
            });
          r.occurrencesUpserted++;
        });
      } catch (e) {
        r.errors.push(`event ${ev.id}: ${(e as Error).message}`);
        r.skipped++;
      }
    }
  } finally {
    await browser.close();
  }

  return Array.from(results.values());
}
