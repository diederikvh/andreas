import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { parseQfactoryTiles } from './_qfactory-agenda.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Q-Factory (Amsterdam-Oost). Eigen site `q-factory.com/nl#all-events-section`
 * heeft veel rijkere event-data dan de TM venue-page (TM JSON-LD bevat
 * alleen titel + datum, geen image, fake description). Hun own page is
 * een Next.js App Router app — content wordt SSR-rendered binnen
 * `<section id="all-events-section">` met per tile:
 *   - datum (Dutch "Za.09.Mei")
 *   - titel
 *   - korte beschrijving
 *   - zaal (Grote Zaal / Q-Cafe / Loungezaal)
 *   - genre-tags (Concert / Latin / Wereldmuziek / Tribute)
 *   - image (Storyblok CDN)
 *
 * Tiles zijn `cursor-pointer` divs (geen anchor-link), dus we hebben
 * geen detail-page om naar te navigeren — alle data komt uit de tile.
 *
 * TM-jsonld events voor Q-Factory worden bewust opgeruimd voor we
 * onze eigen scraper draaien — die hadden lege images en fake
 * descriptions.
 *
 * Idempotency: eventId = `evt-qf-{slugify(title)}`,
 *              occurrenceId = `occ-qf-{slugify(title)}-{YYYY-MM-DD}`
 */

const VENUE_ID = 'q-factory';
const UA = 'Mozilla/5.0 (Andreas/1.0)';
const AGENDA_URL = 'https://q-factory.com/nl#all-events-section';

const DUTCH_MONTHS_SHORT: Record<string, number> = {
  jan: 1, feb: 2, mrt: 3, mar: 3, apr: 4, mei: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dec: 12,
};

type Tile = {
  date: string;          // "Za.09.Mei"
  title: string;
  description: string;
  room: string;
  tags: string[];
  imageUrl: string;
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

function parseDutchDate(s: string): Date | null {
  // "Za.09.Mei" or "Vr.15.Mei"
  const m = s.match(/(\d{1,2})\.(\w{3})/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = DUTCH_MONTHS_SHORT[m[2].toLowerCase().slice(0, 3)];
  if (!month) return null;
  const now = new Date();
  for (const y of [now.getFullYear(), now.getFullYear() + 1]) {
    // Default 20:30 voor concerten als geen tijd in tile
    const d = new Date(`${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T20:30:00+02:00`);
    if (isNaN(d.getTime())) continue;
    const delta = d.getTime() - now.getTime();
    if (delta > -7 * 24 * 60 * 60 * 1000 && delta < 365 * 24 * 60 * 60 * 1000) return d;
  }
  return null;
}

/** Storyblok image-URLs zoals
 * `https://q-factory.com/_next/image?url=https%3A%2F%2Fa.storyblok.com%2F...&w=640`
 * → unwrap naar de echte Storyblok URL voor mirror.
 */
function unwrapNextImage(src: string): string {
  const m = src.match(/[?&]url=([^&]+)/);
  if (!m) return src;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return src;
  }
}

async function fetchTiles(): Promise<Tile[]> {
  // De agenda is server-rendered; tot 13 sep 2026 werd dit met
  // Playwright uit de DOM gelezen. Naast elkaar gelegd komen datum,
  // titel, zaal, image en tags exact overeen. De description verschilt
  // in witruimte: `textContent` plakte aangrenzende elementen aan
  // elkaar ("Tabber.ConcertK-Pop"), deze versie zet er spaties tussen.
  const r = await fetch(AGENDA_URL, {
    headers: { 'user-agent': UA, 'accept-language': 'nl-NL' },
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`agenda HTTP ${r.status}`);
  return parseQfactoryTiles(await r.text()) as Tile[];
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
    return await uploadToBunny(`media/events/qf-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[qfactory] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type QFactoryResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeQFactory(options?: {
  venueIds?: string[];
}): Promise<QFactoryResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: QFactoryResult = {
    venueId: VENUE_ID, fetched: 0, inserted: 0, occurrencesUpserted: 0, skipped: 0, errors: [],
  };

  const [venue] = await db.select().from(schema.venues).where(eq(schema.venues.id, VENUE_ID));
  if (!venue) {
    result.errors.push('venue niet in DB');
    return [result];
  }
  const venueCategory = venue.categories?.[0] ?? 'Muziek';

  let tiles: Tile[];
  try {
    tiles = await fetchTiles();
  } catch (e) {
    result.errors.push(`fetch tiles: ${(e as Error).message}`);
    return [result];
  }
  result.fetched = tiles.length;
  if (tiles.length === 0) {
    result.errors.push('geen tiles ontdekt');
    return [result];
  }

  // Title-grouping: dezelfde titel op meerdere dagen = 1 event, N occurrences.
  type Group = { titleSlug: string; head: Tile; tiles: Tile[]; slots: Date[] };
  const groups = new Map<string, Group>();
  for (const t of tiles) {
    if (!t.title || t.title.length < 2) continue;
    const startsAt = parseDutchDate(t.date);
    if (!startsAt) continue;
    const titleSlug = slugify(t.title);
    if (!titleSlug) continue;
    const g = groups.get(titleSlug);
    if (g) {
      g.tiles.push(t);
      g.slots.push(startsAt);
    } else {
      groups.set(titleSlug, { titleSlug, head: t, tiles: [t], slots: [startsAt] });
    }
  }

  for (const group of groups.values()) {
    try {
      const eventId = `evt-qf-${group.titleSlug}`;
      const head = group.head;

      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;

      if (!existing) {
        const realImageUrl = head.imageUrl ? unwrapNextImage(head.imageUrl) : null;
        let imageUrl: string | null = null;
        if (realImageUrl) {
          imageUrl = (await mirrorImage(realImageUrl, group.titleSlug)) ?? realImageUrl;
        }

        try {
          enriched = await enrichEvent({
            title: head.title,
            description: head.description || null,
            venueName: venue.name,
            venueCategory,
          });
        } catch (e) {
          result.errors.push(`enrich ${head.title}: ${(e as Error).message}`);
        }

        // Genres: Q-Factory site-tags (Latin, Wereldmuziek, Concert, Tribute)
        // hebben prioriteit boven enrich, maar enrich vult aan.
        const tagGenres = head.tags.filter((t) => !/^Concert$/i.test(t) && t.length < 30);
        const enrichGenres = enriched?.genres ?? [];
        const finalGenres = [...new Set([...tagGenres, ...enrichGenres])].slice(0, 6);

        const eventKind = refineKindByDuration(enriched?.kind ?? 'show', group.slots[0], null);

        try {
          await db.insert(schema.events).values({
            id: eventId,
            venueId: venue.id,
            title: head.title,
            description: enriched?.cleanedDescription ?? (head.description || null),
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

      for (const startsAt of group.slots) {
        try {
          const isoDate = startsAt.toISOString().slice(0, 10);
          const occurrenceId = `occ-qf-${group.titleSlug}-${isoDate}`;
          await db
            .insert(schema.occurrences)
            .values({
              id: occurrenceId,
              eventId,
              startsAt,
              endsAt: null,
              priceCents: null,
              priceNote: enriched?.priceNote ?? null,
              ticketUrl: AGENDA_URL,
              room: head.room || null,
              lineup: enriched?.lineup ?? null,
              status: 'scheduled',
            })
            .onConflictDoUpdate({
              target: schema.occurrences.id,
              set: { startsAt, room: head.room || null },
            });
          result.occurrencesUpserted++;
        } catch (err) {
          result.errors.push(`occurrence ${head.title} ${startsAt.toISOString()}: ${(err as Error).message}`);
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
