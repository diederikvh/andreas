import { and, eq, gt, inArray } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { parseAmareLinks, parseAmarePage, type AmareEvent } from './_amare-page.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';
import { loadVenueTitleMap, resolveEventId } from './_title-dedup.js';

/**
 * Amare, Den Haag. Huis van het Residentie Orkest, het Nederlands Dans
 * Theater en het Koninklijk Conservatorium — en dus vooral klassiek,
 * dans en opera.
 *
 * Niet in Ticketmaster, dus een eigen scraper. `/nl/agenda?page=N` geeft
 * vijftien tegels per pagina; we lopen door tot een pagina niks meer
 * oplevert.
 *
 * Per detailpagina staat er een JSON-LD `Event` per speeldatum, dus een
 * reeks komt hier binnen als één event met meerdere occurrences — geen
 * titel-dedup nodig zoals bij venues die elke avond een eigen pagina
 * geven.
 *
 * Prijs en ticketlink zitten achter hun JS-kaartverkoop en staan niet in
 * de HTML; de ticketlink wijst daarom naar de eventpagina zelf.
 *
 * Idempotency:
 *  - eventId      = `evt-am-{slug}`
 *  - occurrenceId = `occ-am-{slug}-{YYYY-MM-DD}`
 */

const VENUE_ID = 'amare';
const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const AGENDA_URL = 'https://www.amare.nl/nl/agenda';
/** 19 pagina's bij de eerste meting; ruim erboven stoppen. */
const MAX_PAGINAS = 40;
const SPACING_MS = 150;
const MAX_FOUTEN_OP_RIJ = 8;

async function fetchPagina(url: string): Promise<string | null> {
  for (let poging = 1; poging <= 3; poging++) {
    try {
      const r = await fetch(url, {
        headers: { 'user-agent': UA, 'accept-language': 'nl-NL,nl' },
        signal: AbortSignal.timeout(25000),
      });
      if (r.ok) return await r.text();
    } catch {
      // volgende poging
    }
    if (poging < 3) await new Promise((res) => setTimeout(res, 400 * poging));
  }
  return null;
}

async function harvestLinks(): Promise<string[]> {
  const alle: string[] = [];
  const gezien = new Set<string>();
  for (let p = 1; p <= MAX_PAGINAS; p++) {
    const html = await fetchPagina(p === 1 ? AGENDA_URL : `${AGENDA_URL}?page=${p}`);
    if (!html) break;
    const links = parseAmareLinks(html);
    if (!links.length) break;
    const voor = gezien.size;
    for (const u of links) {
      if (gezien.has(u)) continue;
      gezien.add(u);
      alle.push(u);
    }
    // Geen nieuwe links meer: we draaien rond op de laatste pagina.
    if (gezien.size === voor) break;
    await new Promise((res) => setTimeout(res, SPACING_MS));
  }
  return alle;
}

async function mirrorImage(sourceUrl: string, slug: string): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength < 1024 || buf.byteLength > 8 * 1024 * 1024) return null;
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    return await uploadToBunny(`media/events/am-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[amare] mirror image ${slug}: ${(e as Error).message}`);
    return null;
  }
}

/** YYYY-MM-DD in Amsterdamse tijd, voor een leesbare occurrence-id. */
function dagIso(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

export type AmareResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  occurrencesPruned: number;
  skipped: number;
  skipReasons: Record<string, number>;
  errors: string[];
};

export async function scrapeAmare(options?: {
  venueIds?: string[];
}): Promise<AmareResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: AmareResult = {
    venueId: VENUE_ID, fetched: 0, inserted: 0, occurrencesUpserted: 0,
    occurrencesPruned: 0, skipped: 0, skipReasons: {}, errors: [],
  };
  const skip = (reden: string) => {
    result.skipped++;
    result.skipReasons[reden] = (result.skipReasons[reden] ?? 0) + 1;
  };

  const [venue] = await db.select().from(schema.venues).where(eq(schema.venues.id, VENUE_ID));
  if (!venue) {
    result.errors.push('venue niet in DB');
    return [result];
  }
  const venueCategory = venue.categories?.[0] ?? 'Muziek';

  const links = await harvestLinks();
  if (!links.length) {
    result.errors.push('geen event-links in de agenda');
    return [result];
  }

  const events: AmareEvent[] = [];
  let foutenOpRij = 0;
  for (const url of links) {
    const html = await fetchPagina(url);
    await new Promise((res) => setTimeout(res, SPACING_MS));
    if (!html) {
      skip('detailpagina niet op te halen');
      if (++foutenOpRij >= MAX_FOUTEN_OP_RIJ) {
        result.errors.push(`gestopt na ${MAX_FOUTEN_OP_RIJ} mislukte fetches op rij`);
        break;
      }
      continue;
    }
    foutenOpRij = 0;
    const ev = parseAmarePage(html, url);
    if (!ev) { skip('geen bruikbare JSON-LD'); continue; }
    events.push(ev);
  }
  result.fetched = events.length;
  if (!events.length) {
    result.errors.push('geen events geparsed');
    return [result];
  }

  const titleMap = await loadVenueTitleMap(VENUE_ID, 'evt-am-');
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  const seenOcc = new Map<string, Set<string>>();

  for (const ev of events) {
    try {
      const toekomstig = ev.momenten.filter((m) => m.startsAt.getTime() >= cutoff);
      if (!toekomstig.length) { skip('alle datums voorbij'); continue; }
      const eerste = toekomstig[0]!;

      const { eventId } = resolveEventId(titleMap, ev.title, `evt-am-${ev.slug}`, {
        startsAt: eerste.startsAt,
        description: ev.description,
      });

      const [bestaand] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      if (!bestaand) {
        let imageUrl: string | null = null;
        if (ev.imageUrl) imageUrl = (await mirrorImage(ev.imageUrl, ev.slug)) ?? ev.imageUrl;

        let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;
        try {
          enriched = await enrichEvent({
            title: ev.title,
            description: ev.description,
            venueName: venue.name,
            venueCategory,
          });
        } catch (e) {
          result.errors.push(`enrich ${ev.title}: ${(e as Error).message}`);
        }

        try {
          await db.insert(schema.events).values({
            id: eventId,
            venueId: VENUE_ID,
            title: ev.title,
            description: enriched?.cleanedDescription ?? ev.description,
            kind: refineKindByDuration(enriched?.kind ?? 'show', eerste.startsAt, eerste.endsAt),
            imageUrl,
            category: enriched?.category ?? venueCategory,
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

      for (const moment of toekomstig) {
        const occurrenceId = `occ-am-${ev.slug}-${dagIso(moment.startsAt)}`;
        try {
          await db
            .insert(schema.occurrences)
            .values({
              id: occurrenceId,
              eventId,
              startsAt: moment.startsAt,
              endsAt: moment.endsAt,
              priceCents: null,
              priceNote: null,
              ticketUrl: ev.url,
              room: moment.room,
              lineup: null,
              status: 'scheduled',
            })
            .onConflictDoUpdate({
              target: schema.occurrences.id,
              set: {
                eventId,
                startsAt: moment.startsAt,
                endsAt: moment.endsAt,
                ticketUrl: ev.url,
                room: moment.room,
              },
            });
          result.occurrencesUpserted++;
          const gezien = seenOcc.get(eventId) ?? new Set<string>();
          gezien.add(occurrenceId);
          seenOcc.set(eventId, gezien);
        } catch (e) {
          result.errors.push(`occurrence ${occurrenceId}: ${(e as Error).message}`);
          skip('occurrence-write faalde');
        }
      }
    } catch (e) {
      result.errors.push(`event ${ev.slug}: ${(e as Error).message}`);
      skip('exception op event');
    }
  }

  const pruneCutoff = new Date(cutoff);
  for (const [eventId, keep] of seenOcc) {
    try {
      const bestaand = await db
        .select({ id: schema.occurrences.id })
        .from(schema.occurrences)
        .where(and(eq(schema.occurrences.eventId, eventId), gt(schema.occurrences.startsAt, pruneCutoff)));
      const drop = bestaand.map((r) => r.id).filter((id) => !keep.has(id));
      if (!drop.length) continue;
      const saved = await db
        .select({ occurrenceId: schema.saves.occurrenceId })
        .from(schema.saves)
        .where(inArray(schema.saves.occurrenceId, drop));
      const savedIds = new Set(saved.map((r) => r.occurrenceId));
      const finalDrop = drop.filter((id) => !savedIds.has(id));
      if (!finalDrop.length) continue;
      await db.delete(schema.occurrences).where(inArray(schema.occurrences.id, finalDrop));
      result.occurrencesPruned += finalDrop.length;
    } catch (e) {
      result.errors.push(`prune ${eventId}: ${(e as Error).message}`);
    }
  }

  return [result];
}
