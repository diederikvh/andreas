import { and, eq, gt, inArray } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { parseAmsterdamLocal } from './_amsterdam-tz.js';
import { parseRomaDetail, parseRomaTiles, type RomaTile } from './_deroma-page.js';
import { loadVenueTitleMap, resolveEventId } from './_title-dedup.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * De Roma, Borgerhout (Antwerpen). De enige venue buiten Nederland.
 *
 * Hun agenda is server-rendered: tien pagina's van zestien tegels via
 * `?page=N`, samen 152 events. De tegel draagt titel, datum, tijd,
 * beeld, teaser en ticketstatus — genoeg voor een volledige rij. De
 * detailpagina heeft JSON-LD met de volle omschrijving, de zaal en de
 * eindtijd; die halen we alleen op voor events die we nog niet kennen,
 * zoals paradiso.ts ook doet.
 *
 * Tijdzone: Antwerpen ligt in Europe/Brussels, dat exact dezelfde
 * offsets en klokwissels heeft als Europe/Amsterdam. parseAmsterdamLocal
 * klopt hier dus, ook al staat er Amsterdam in de naam.
 *
 * Idempotency:
 *  - eventId      = `evt-roma-{slug}`, via resolveEventId gegroepeerd op
 *                   titel — De Roma geeft elke speeldatum een eigen slug
 *                   (`t-dansant-672`, `t-dansant-673`).
 *  - occurrenceId = `occ-roma-{slug}`
 */

const VENUE_ID = 'de-roma';
const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const AGENDA_URL = 'https://deroma.be/agenda';
const MAX_PAGINAS = 15;
/** Hun origin is niet snel; even ademruimte tussen detail-fetches. */
const DETAIL_SPACING_MS = 150;

async function fetchPagina(url: string): Promise<string | null> {
  for (let poging = 1; poging <= 3; poging++) {
    try {
      const r = await fetch(url, {
        headers: { 'user-agent': UA, 'accept-language': 'nl-BE,nl' },
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

async function harvestTiles(): Promise<RomaTile[]> {
  const perUrl = new Map<string, RomaTile>();
  for (let p = 1; p <= MAX_PAGINAS; p++) {
    const html = await fetchPagina(p === 1 ? AGENDA_URL : `${AGENDA_URL}?page=${p}`);
    if (!html) break;
    const tiles = parseRomaTiles(html);
    if (!tiles.length) break;
    const voor = perUrl.size;
    for (const t of tiles) perUrl.set(t.url, t);
    // Geen nieuwe URLs meer: we draaien rond op de laatste pagina.
    if (perUrl.size === voor) break;
  }
  return [...perUrl.values()];
}

function slugVan(url: string): string | null {
  return url.match(/\/event\/([a-z0-9-]+)\/?$/i)?.[1] ?? null;
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
    return await uploadToBunny(`media/events/roma-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[deroma] mirror image ${slug}: ${(e as Error).message}`);
    return null;
  }
}

export type DeRomaResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  occurrencesPruned: number;
  skipped: number;
  skipReasons: Record<string, number>;
  errors: string[];
};

export async function scrapeDeRoma(options?: {
  venueIds?: string[];
}): Promise<DeRomaResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: DeRomaResult = {
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

  const tiles = await harvestTiles();
  result.fetched = tiles.length;
  if (!tiles.length) {
    result.errors.push('geen tegels op /agenda');
    return [result];
  }

  // De Roma geeft elke speeldatum een eigen slug, dus een reeks wordt
  // anders N losse events. Titel binnen de venue is de identiteit.
  const titleMap = await loadVenueTitleMap(VENUE_ID, 'evt-roma-');
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  const seenOcc = new Map<string, Set<string>>();

  for (const tile of tiles) {
    try {
      const slug = slugVan(tile.url);
      if (!slug) { skip('geen slug in URL'); continue; }
      if (!tile.time) { skip('geen tijd op de tegel'); continue; }

      const startsAt = parseAmsterdamLocal(`${tile.date}T${tile.time}:00`);
      if (isNaN(startsAt.getTime())) { skip('datum niet te parsen'); continue; }
      if (startsAt.getTime() < cutoff) { skip('al voorbij'); continue; }

      const { eventId, owns } = resolveEventId(titleMap, tile.title, `evt-roma-${slug}`, {
        startsAt,
        description: tile.teaser,
      });
      void owns;
      const occurrenceId = `occ-roma-${slug}`;

      const [bestaand] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      let endsAt: Date | null = null;
      let room: string | null = null;

      if (!bestaand) {
        // Alleen voor nieuwe events de detailpagina erbij: die geeft de
        // volle omschrijving, de zaal en de eindtijd.
        const detailHtml = await fetchPagina(tile.url);
        await new Promise((res) => setTimeout(res, DETAIL_SPACING_MS));
        const detail = detailHtml ? parseRomaDetail(detailHtml) : null;
        if (detail?.endLocal) {
          const e = parseAmsterdamLocal(detail.endLocal);
          if (!isNaN(e.getTime()) && e.getTime() > startsAt.getTime()) endsAt = e;
        }
        // "De Roma" is de venue zelf en zegt niets over waar je moet
        // zijn; "Amor" is hun tweede zaal en wél nuttig.
        room = detail?.room && !/^de\s*roma$/i.test(detail.room) ? detail.room : null;

        const description = detail?.description ?? tile.teaser;
        let imageUrl: string | null = null;
        if (tile.imageUrl) imageUrl = (await mirrorImage(tile.imageUrl, slug)) ?? tile.imageUrl;

        let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;
        try {
          enriched = await enrichEvent({
            title: tile.title,
            description,
            venueName: venue.name,
            venueCategory,
          });
        } catch (e) {
          result.errors.push(`enrich ${tile.title}: ${(e as Error).message}`);
        }

        try {
          await db.insert(schema.events).values({
            id: eventId,
            venueId: VENUE_ID,
            title: tile.title,
            description: enriched?.cleanedDescription ?? description,
            kind: refineKindByDuration(enriched?.kind ?? 'show', startsAt, endsAt),
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

      try {
        await db
          .insert(schema.occurrences)
          .values({
            id: occurrenceId,
            eventId,
            startsAt,
            endsAt,
            priceCents: null,
            priceNote: null,
            ticketUrl: tile.url,
            room,
            lineup: null,
            status: tile.soldOut ? 'sold_out' : 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            // eventId meenemen: occurrences die nog aan een eigen event
            // per speeldatum hingen verhuizen zo naar het canonieke.
            // room alleen zetten als we 'm deze ronde hebben opgehaald,
            // anders wist een bestaand event z'n zaal.
            set: {
              eventId,
              startsAt,
              ticketUrl: tile.url,
              status: tile.soldOut ? 'sold_out' : 'scheduled',
              ...(room ? { room } : {}),
              ...(endsAt ? { endsAt } : {}),
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
      result.errors.push(`tegel ${tile.url}: ${(e as Error).message}`);
      skip('exception op tegel');
    }
  }

  // Toekomstige datums weghalen die de bron niet meer aanbiedt. Alleen
  // voor events die we dit rondje écht gezien hebben; saves blijven
  // staan, liever een verlopen rij dan een verdwenen save.
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
