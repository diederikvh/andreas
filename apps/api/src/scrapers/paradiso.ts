import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';
import { DETAIL_SPACING_MS, fetchDescription } from './_paradiso-detail.js';
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
 * Geen browser meer. De GraphQL geeft `text` (de body uit hun CMS) voor
 * 296 van de 475 events; voor de rest halen we de detailpagina op met
 * een kale fetch. Die pagina is server-rendered, dus de tekst staat in
 * de HTML die je terugkrijgt — gemeten op negen events geeft dat
 * letterlijk dezelfde string als de Playwright-versie gaf.
 *
 * Daardoor kan deze scraper mee in de nachtelijke GitHub Action in
 * plaats van te wachten op een openstaande laptop. Dat was het punt:
 * Paradiso's aankondigingen stonden per mail eerder buiten dan in de
 * app.
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
  /** Body-tekst uit hun CMS. Voor ~62% gevuld; de rest staat alleen
      op de detailpagina. */
  text: string | null;
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
        id uri title subtitle text startDateTime date eventStatus highlight supportAct soldOut sort
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

      // Nieuw event — volle flow met detail-fetch + Claude.
      // `text` uit de GraphQL scheelt een request; die is voor 296 van
      // de 475 events gevuld en komt inhoudelijk overeen met wat de
      // detailpagina toont (gemeten: 508/507, 767/767, 597/597).
      const apiText = (ev.text ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      let description: string | null = apiText || null;
      if (!description) {
        description = await fetchDescription(ticketUrl);
        await new Promise((res) => setTimeout(res, DETAIL_SPACING_MS));
      }
      description = description ?? ev.subtitle;
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

  return Array.from(results.values());
}
