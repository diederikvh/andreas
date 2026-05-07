import { createHash } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';
import { parseVEvents, type ParsedVEvent } from './_ical-parser.js';

/**
 * iCal-scraper. Voor venues met een open `?ical=1` of `.ics`-feed
 * (WordPress-stijl). Groepeert VEVENTs per URL-stem zodat een
 * "Spoedcursus Toneelspelen" met 4 wekelijkse instanties terugkomt
 * als 1 event met 4 occurrences (i.p.v. 4 losse events).
 *
 * URL-stem: alles voor een trailing `/YYYY-MM-DD/?` — voor The Events
 * Calendar (WordPress) zit de instance-datum in de URL als path-suffix.
 * Events zonder datum-suffix in URL → 1 instance per groep (single).
 *
 * Config in `venues.scraperConfig.ical`:
 *   { url: "https://grond.community/events/?ical=1" }
 *
 * Idempotency: event-id op sha256(urlStem) zodat een instance-toevoeging
 * niet leidt tot een nieuw event. Occurrence-id op sha256(urlStem +
 * startsAt) — verschuivende start-tijden creëren een nieuwe occurrence
 * (oude blijft staan tot die voorbij is).
 */

const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const MAX_BYTES = 8 * 1024 * 1024;

type IcalConfig = { url: string };

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

/**
 * URL-stem voor groeperen van recurring events. The Events Calendar
 * (WordPress) genereert per instance een URL als
 *   https://venue.nl/evenement/cursus-x/2026-05-08/
 * Trailing `/YYYY-MM-DD/?` strippen geeft de stam die alle instanties
 * delen. Events zonder datum-suffix → URL blijft ongewijzigd.
 */
function urlStem(url: string | null): string | null {
  if (!url) return null;
  return url.replace(/\/\d{4}-\d{2}-\d{2}\/?$/, '/');
}

/**
 * Groepeer VEVENTs zodat instanties van dezelfde recurring event in
 * één groep komen. Sleutel = urlStem (preferred) of `summary:{title}`
 * als URL ontbreekt. Single events → groep met 1 lid.
 */
function groupVEvents(vevents: ParsedVEvent[]): Map<string, ParsedVEvent[]> {
  const groups = new Map<string, ParsedVEvent[]>();
  for (const ev of vevents) {
    const key = urlStem(ev.url) ?? `summary:${ev.summary.toLowerCase()}`;
    const arr = groups.get(key) ?? [];
    arr.push(ev);
    groups.set(key, arr);
  }
  return groups;
}

async function mirrorImageToBunny(
  sourceUrl: string,
  venueId: string,
  uidHash: string
): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, {
      headers: { 'user-agent': UA },
    });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return null;
    const ext = mime.includes('png')
      ? 'png'
      : mime.includes('webp')
        ? 'webp'
        : mime.includes('gif')
          ? 'gif'
          : mime.includes('avif')
            ? 'avif'
            : 'jpg';
    const path = `media/events/ical-${venueId}-${uidHash}.${ext}`;
    return await uploadToBunny(path, buf, mime);
  } catch (e) {
    console.warn(
      `[ical] mirror image ${sourceUrl} failed: ${(e as Error).message}`
    );
    return null;
  }
}

export type IcalVenueResult = {
  venueId: string;
  venueName: string;
  url: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

async function scrapeOneVenue(
  venue: typeof schema.venues.$inferSelect,
  cfg: IcalConfig
): Promise<IcalVenueResult> {
  const result: IcalVenueResult = {
    venueId: venue.id,
    venueName: venue.name,
    url: cfg.url,
    fetched: 0,
    inserted: 0,
    occurrencesUpserted: 0,
    skipped: 0,
    errors: [],
  };

  let ics: string;
  try {
    const r = await fetch(cfg.url, { headers: { 'user-agent': UA } });
    if (!r.ok) {
      result.errors.push(`fetch: HTTP ${r.status}`);
      return result;
    }
    ics = await r.text();
  } catch (e) {
    result.errors.push(`fetch: ${(e as Error).message}`);
    return result;
  }

  const vevents = parseVEvents(ics);
  result.fetched = vevents.length;

  // Filter voorbij events weg — cutoff = nu - 6u zodat night-events die
  // tot 04:00 doorgaan op hun avond nog binnenkomen.
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  const upcoming = vevents.filter(
    (e) => (e.endsAt ?? e.startsAt).getTime() > cutoff
  );

  const venueCategory = venue.categories?.[0] ?? 'Muziek';

  const groups = groupVEvents(upcoming);

  for (const [groupKey, instances] of groups) {
    // Sorteer instanties op startsAt; eerste = canoniek voor enrich +
    // image-mirror (één call per recurring event, niet per instance).
    instances.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    const first = instances[0];

    try {
      const groupHash = shortHash(groupKey);
      const eventId = `evt-ical-${venue.id}-${groupHash}`;

      const enriched = await enrichEvent({
        title: first.summary,
        description: first.description,
        venueName: venue.name,
        venueCategory,
      });

      // Image alleen bij eerste keer event zien naar Bunny mirroren —
      // her-runs hergebruiken dezelfde CDN-URL.
      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      let imageUrl: string | null = null;
      if (!existing && first.imageUrl) {
        imageUrl =
          (await mirrorImageToBunny(first.imageUrl, venue.id, groupHash)) ??
          first.imageUrl;
      }

      // Categories uit iCal als genres-fallback (lowercase). Claude
      // genres winnen als die zijn ingevuld. Combineer categorieën van
      // alle instanties — recurring events delen meestal dezelfde set,
      // maar voor de zekerheid mergen we.
      const allCategories = new Set<string>();
      for (const inst of instances) {
        for (const c of inst.categories) allCategories.add(c.toLowerCase().trim());
      }
      const fallbackGenres = Array.from(allCategories)
        .filter((c) => c.length > 0 && c.length < 30)
        .slice(0, 4);
      const finalGenres =
        enriched.genres.length > 0 ? enriched.genres : fallbackGenres;

      const status: 'scheduled' | 'cancelled' | 'sold_out' = 'scheduled';

      // Refine kind: lange all-day events → exhibition.
      const refinedKind = refineKindByDuration(
        enriched.kind,
        first.startsAt,
        first.endsAt
      );

      await db.transaction(async (tx) => {
        if (!existing) {
          await tx.insert(schema.events).values({
            id: eventId,
            venueId: venue.id,
            title: first.summary,
            description: enriched.cleanedDescription ?? first.description,
            kind: refinedKind,
            imageUrl,
            category: enriched.category ?? venueCategory,
            featured: false,
            genres: finalGenres,
            published: true,
          });
          result.inserted++;
        }

        // Per instance een eigen occurrence — id stabiel per (groep,
        // startsAt) zodat herscrapes met verschoven tijden idempotent
        // blijven (oude occurrence blijft bestaan met oude tijd, nieuwe
        // wordt apart geinsert).
        for (const inst of instances) {
          const occHash = shortHash(`${groupKey}|${inst.startsAt.toISOString()}`);
          const occurrenceId = `occ-ical-${venue.id}-${occHash}`;
          await tx
            .insert(schema.occurrences)
            .values({
              id: occurrenceId,
              eventId,
              startsAt: inst.startsAt,
              endsAt: inst.endsAt,
              priceCents: null,
              priceNote: enriched.priceNote,
              ticketUrl: inst.url,
              room: enriched.room,
              lineup: enriched.lineup,
              status,
            })
            .onConflictDoUpdate({
              target: schema.occurrences.id,
              set: {
                startsAt: inst.startsAt,
                endsAt: inst.endsAt,
                priceNote: enriched.priceNote,
                ticketUrl: inst.url,
                room: enriched.room,
                lineup: enriched.lineup,
                status,
              },
            });
          result.occurrencesUpserted++;
        }
      });
    } catch (e) {
      result.errors.push(`group ${groupKey}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return result;
}

export async function scrapeIcal(options?: {
  venueIds?: string[];
}): Promise<IcalVenueResult[]> {
  const all = await db.select().from(schema.venues);
  const targets = all.filter((v) => {
    const cfg = v.scraperConfig?.ical;
    if (!cfg?.url) return false;
    if (options?.venueIds && !options.venueIds.includes(v.id)) return false;
    return true;
  });

  const results: IcalVenueResult[] = [];
  for (const v of targets) {
    const cfg = v.scraperConfig!.ical!;
    results.push(await scrapeOneVenue(v, cfg));
  }
  return results;
}
