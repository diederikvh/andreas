import { and, eq, gt, inArray } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import {
  categorieVanGenre,
  parseTivoliFeed,
  type TivoliEvent,
} from './_tivoli-feed.js';
import { refineKindByDuration } from './enrich.js';
import { loadVenueTitleMap, resolveEventId } from './_title-dedup.js';

/**
 * TivoliVredenburg, Utrecht. Met 873 events het grootste programma dat
 * we scrapen — meer dan Paradiso en Muziekgebouw samen.
 *
 * Via hun RSS-feed, niet via de site: die zit achter een
 * Cloudflare-challenge waar Node's fetch niet doorheen komt (403, ook
 * vanaf Fly). `/agenda/feed/` is niet afgeschermd en levert per item de
 * volledige productie-JSON uit hun CMS. Zie _tivoli-feed.ts.
 *
 * Geen enrichEvent. De feed geeft zelf een omschrijving, een beeld, de
 * zaal, de prijs én een genre, en dat laatste vertaalt deterministisch
 * naar onze categorie. Bij 873 events scheelt dat evenveel LLM-calls —
 * het verschil tussen een uur en een paar minuten, en hun eigen
 * indeling is betrouwbaarder dan wat een model uit een titel afleidt.
 *
 * Idempotency:
 *  - eventId      = `evt-tv-{displayId}`, via resolveEventId gegroepeerd
 *                   op titel (een meerdaagse serie krijgt per avond een
 *                   eigen displayId).
 *  - occurrenceId = `occ-tv-{displayId}`
 */

const VENUE_ID = 'tivolivredenburg';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';
const FEED = 'https://www.tivolivredenburg.nl/agenda/feed/';
/** 88 paginas bij 873 events; ruim boven de huidige omvang stoppen. */
const MAX_PAGINAS = 140;
const SPACING_MS = 120;

async function fetchPagina(url: string): Promise<string | null> {
  for (let poging = 1; poging <= 3; poging++) {
    try {
      const r = await fetch(url, {
        headers: { 'user-agent': UA, 'accept-language': 'nl-NL' },
        signal: AbortSignal.timeout(25000),
      });
      if (r.status === 404) return null; // voorbij de laatste pagina
      if (r.ok) return await r.text();
    } catch {
      // volgende poging
    }
    if (poging < 3) await new Promise((res) => setTimeout(res, 500 * poging));
  }
  return null;
}

async function harvest(): Promise<TivoliEvent[]> {
  const perId = new Map<string, TivoliEvent>();
  for (let p = 1; p <= MAX_PAGINAS; p++) {
    const xml = await fetchPagina(p === 1 ? FEED : `${FEED}?paged=${p}`);
    if (!xml) break;
    const evs = parseTivoliFeed(xml);
    if (!evs.length) break;
    const voor = perId.size;
    for (const e of evs) perId.set(e.id, e);
    // Geen nieuwe ids meer: we draaien rond op de laatste pagina.
    if (perId.size === voor) break;
    await new Promise((res) => setTimeout(res, SPACING_MS));
  }
  return [...perId.values()];
}

async function mirrorImage(sourceUrl: string, id: string): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength < 1024 || buf.byteLength > 8 * 1024 * 1024) return null;
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    return await uploadToBunny(`media/events/tv-${id}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[tivoli] mirror image ${id}: ${(e as Error).message}`);
    return null;
  }
}

export type TivoliResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  occurrencesPruned: number;
  skipped: number;
  skipReasons: Record<string, number>;
  errors: string[];
};

export async function scrapeTivoliVredenburg(options?: {
  venueIds?: string[];
}): Promise<TivoliResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: TivoliResult = {
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

  const events = await harvest();
  result.fetched = events.length;
  if (!events.length) {
    result.errors.push('geen events in de feed');
    return [result];
  }

  const titleMap = await loadVenueTitleMap(VENUE_ID, 'evt-tv-');
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  const seenOcc = new Map<string, Set<string>>();

  for (const ev of events) {
    try {
      // Het CMS levert UTC met een Z, dus new Date() is hier correct —
      // geen wandkloktijd die nog een offset nodig heeft.
      const startsAt = new Date(ev.startUtc);
      if (isNaN(startsAt.getTime())) { skip('datum niet te parsen'); continue; }
      if (startsAt.getTime() < cutoff) { skip('al voorbij'); continue; }
      const endsAt = ev.endUtc ? new Date(ev.endUtc) : null;
      const eind = endsAt && !isNaN(endsAt.getTime()) && endsAt > startsAt ? endsAt : null;

      const { eventId } = resolveEventId(titleMap, ev.title, `evt-tv-${ev.id}`, {
        startsAt,
        description: ev.description,
      });
      const occurrenceId = `occ-tv-${ev.id}`;

      const [bestaand] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      if (!bestaand) {
        let imageUrl: string | null = null;
        if (ev.imageUrl) imageUrl = (await mirrorImage(ev.imageUrl, ev.id)) ?? ev.imageUrl;
        const categorie = categorieVanGenre(ev.genre);
        try {
          await db.insert(schema.events).values({
            id: eventId,
            venueId: VENUE_ID,
            title: ev.title,
            description: ev.description ?? ev.subtitle,
            kind: refineKindByDuration('show', startsAt, eind),
            imageUrl,
            category: categorie,
            featured: false,
            genres: ev.genre ? [ev.genre] : [],
            published: true,
          });
          result.inserted++;
        } catch (e) {
          result.errors.push(`insert event ${eventId}: ${(e as Error).message}`);
          continue;
        }
      }

      try {
        await db
          .insert(schema.occurrences)
          .values({
            id: occurrenceId,
            eventId,
            startsAt,
            endsAt: eind,
            priceCents: ev.priceCents,
            priceNote: null,
            ticketUrl: ev.ticketUrl ?? ev.url,
            room: ev.room,
            lineup: null,
            status: ev.cancelled ? 'cancelled' : ev.soldOut ? 'sold_out' : 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: {
              eventId,
              startsAt,
              endsAt: eind,
              priceCents: ev.priceCents,
              ticketUrl: ev.ticketUrl ?? ev.url,
              room: ev.room,
              status: ev.cancelled ? 'cancelled' : ev.soldOut ? 'sold_out' : 'scheduled',
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
      result.errors.push(`event ${ev.id}: ${(e as Error).message}`);
      skip('exception op event');
    }
  }

  // Toekomstige datums weghalen die de feed niet meer aanbiedt. Alleen
  // voor events die we dit rondje echt gezien hebben; saves blijven
  // staan.
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
