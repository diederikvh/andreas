import { and, eq, gt, inArray } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { parsePaardLinks, parsePaardPage, type PaardEvent } from './_paard-page.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';
import { loadVenueTitleMap, resolveEventId } from './_title-dedup.js';

/**
 * PAARD, Den Haag.
 *
 * Zelfde vorm als 013: `/event/` is één server-rendered archief met het
 * hele komende programma — `/event/page/2/` geeft 404, er is geen
 * tweede pagina. Per event staat alles in de JSON-LD op de
 * detailpagina; de genre-tags komen uit de HTML ernaast.
 *
 * Elke detailpagina wordt elk rondje opgehaald, ook van events die we
 * al kennen: dat houdt datum, zaal en uitverkocht-status bij. Alleen de
 * Claude-enrichment is voorbehouden aan nieuwe events, en die valt bij
 * PAARD vaker weg dan elders — hun eigen tags vullen `genres` al.
 *
 * Tijdzone: hun `startDate` is wandkloktijd zonder offset, dus
 * parseAmsterdamLocal. Zie _paard-page.ts.
 *
 * Idempotency:
 *  - eventId      = `evt-paard-{slug}`, via resolveEventId gegroepeerd op
 *                   titel — PAARD geeft elke editie een eigen slug
 *                   (`40up-47`, `paardcafe-sonny-burnett-18`).
 *  - occurrenceId = `occ-paard-{slug}`
 */

const VENUE_ID = 'paard';
const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const ARCHIEF_URL = 'https://www.paard.nl/event/';
const DETAIL_SPACING_MS = 150;
const MAX_FOUTEN_OP_RIJ = 8;

async function fetchPagina(url: string): Promise<string | null> {
  for (let poging = 1; poging <= 3; poging++) {
    try {
      const r = await fetch(url, {
        headers: { 'user-agent': UA, 'accept-language': 'nl-NL,nl' },
        signal: AbortSignal.timeout(20000),
      });
      if (r.ok) return await r.text();
    } catch {
      // volgende poging
    }
    if (poging < 3) await new Promise((res) => setTimeout(res, 400 * poging));
  }
  return null;
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
    return await uploadToBunny(`media/events/paard-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[paard] mirror image ${slug}: ${(e as Error).message}`);
    return null;
  }
}

export type PaardResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  occurrencesPruned: number;
  skipped: number;
  skipReasons: Record<string, number>;
  errors: string[];
};

export async function scrapePaard(options?: {
  venueIds?: string[];
}): Promise<PaardResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: PaardResult = {
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

  const archief = await fetchPagina(ARCHIEF_URL);
  if (!archief) {
    result.errors.push('/event/ niet op te halen');
    return [result];
  }
  const links = parsePaardLinks(archief);
  if (!links.length) {
    result.errors.push('geen event-links op /event/');
    return [result];
  }

  const events: PaardEvent[] = [];
  let foutenOpRij = 0;
  for (const url of links) {
    const html = await fetchPagina(url);
    await new Promise((res) => setTimeout(res, DETAIL_SPACING_MS));
    if (!html) {
      skip('detailpagina niet op te halen');
      if (++foutenOpRij >= MAX_FOUTEN_OP_RIJ) {
        result.errors.push(`gestopt na ${MAX_FOUTEN_OP_RIJ} mislukte fetches op rij`);
        break;
      }
      continue;
    }
    foutenOpRij = 0;
    const ev = parsePaardPage(html, url);
    if (!ev) { skip('geen bruikbare JSON-LD'); continue; }
    events.push(ev);
  }
  result.fetched = events.length;
  if (!events.length) {
    result.errors.push('geen events geparsed');
    return [result];
  }

  const titleMap = await loadVenueTitleMap(VENUE_ID, 'evt-paard-');
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  const seenOcc = new Map<string, Set<string>>();

  for (const ev of events) {
    try {
      if (ev.startsAt.getTime() < cutoff) { skip('al voorbij'); continue; }

      const { eventId } = resolveEventId(titleMap, ev.title, `evt-paard-${ev.slug}`, {
        startsAt: ev.startsAt,
        description: ev.description,
      });
      const occurrenceId = `occ-paard-${ev.slug}`;

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
            kind: refineKindByDuration(enriched?.kind ?? 'show', ev.startsAt, ev.endsAt),
            imageUrl,
            category: enriched?.category ?? venueCategory,
            featured: false,
            // PAARD's eigen tags gaan voor: die zijn door een mens gezet
            // en consistenter dan wat een model uit een titel afleidt.
            genres: ev.genres.length ? ev.genres : (enriched?.genres ?? []),
            published: true,
          });
          result.inserted++;
        } catch (e) {
          result.errors.push(`insert event ${eventId}: ${(e as Error).message}`);
          continue;
        }
      }

      const status = ev.soldOut ? 'sold_out' : 'scheduled';
      try {
        await db
          .insert(schema.occurrences)
          .values({
            id: occurrenceId,
            eventId,
            startsAt: ev.startsAt,
            endsAt: ev.endsAt,
            priceCents: null,
            priceNote: null,
            ticketUrl: ev.ticketUrl ?? ev.url,
            room: ev.room,
            lineup: null,
            status,
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: {
              eventId,
              startsAt: ev.startsAt,
              endsAt: ev.endsAt,
              ticketUrl: ev.ticketUrl ?? ev.url,
              room: ev.room,
              status,
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
    } catch (e) {
      result.errors.push(`event ${ev.slug}: ${(e as Error).message}`);
      skip('exception op event');
    }
  }

  // Toekomstige datums weghalen die PAARD niet meer aanbiedt. Alleen
  // voor events die we dit rondje echt gezien hebben; saves blijven.
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
