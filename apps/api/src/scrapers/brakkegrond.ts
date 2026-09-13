import { and, eq, gt, inArray } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import {
  parseAgendaCards,
  parseShowPage,
  parseTicketSlots,
  type AgendaCard,
  type Slot,
} from './_brakkegrond-page.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Vlaams Cultuurhuis De Brakke Grond. Hun /agenda is volledig CSR en
 * detail-pages óók — geen JSON-LD, geen og-meta met betekenisvolle
 * description, geen sitemap die helpt.
 *
 * Strategie:
 *  1. Playwright opent `/agenda`, harvest show-URLs `/agenda/{id}/{slug}`
 *  2. Per show-page (Playwright, `domcontentloaded` want `networkidle`
 *     timeout't door long-poll websockets):
 *       - h1 → title
 *       - .text-block.block (NL) → description
 *       - figure.gallery-block__image img → image
 *       - .event-detail__tickets-{date,info} → speeldata en tijd
 *
 * De datums komen uit de ticketkolom, niet uit de lopende tekst. Dat
 * was hier jarenlang mis: de oude parser zocht in de body naar
 * "vr 18 sep, 18:30 — 23:59", en dat formaat staat op precies één van
 * de 41 pagina's. De andere 40 werden stil overgeslagen — gemeten op
 * 2026-09-11, drie scrape-runs op rij hetzelfde. Vandaar ook
 * `skipReasons` in het resultaat: een overslag zonder reden is
 * onzichtbaar, en onzichtbaar betekende hier: maanden.
 *
 * Title-grouping: één event-row per show, N occurrences per speeldag
 * (multi-night theater is regel hier).
 *
 * Idempotency:
 *  - eventId      = `evt-bg-{showId}` (numeriek deel uit URL)
 *  - occurrenceId = `occ-bg-{showId}-{YYYY-MM-DD}T{HH-MM}` (UTC)
 */

const VENUE_ID = 'de-brakke-grond';
const UA = 'Mozilla/5.0 (Andreas/1.0)';
const AGENDA_URL = 'https://brakkegrond.nl/agenda';

type ShowMeta = {
  url: string;
  showId: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  room: string | null;
  slots: Slot[];
};

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

async function fetchPagina(url: string): Promise<string | null> {
  for (let poging = 1; poging <= 3; poging++) {
    try {
      const r = await fetch(url, {
        headers: { 'user-agent': UA, 'accept-language': 'nl-NL' },
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

async function harvestShowUrls(): Promise<AgendaCard[]> {
  const html = await fetchPagina(AGENDA_URL);
  if (!html) throw new Error('agenda niet op te halen');
  return parseAgendaCards(html);
}

async function fetchShowMeta(url: string): Promise<ShowMeta | null> {
  const html = await fetchPagina(url);
  if (!html) return null;
  const p = parseShowPage(html);
  if (!p) return null;

  const idMatch = url.match(/\/agenda\/(\d+)\//);
  const showId = idMatch?.[1] ?? slugify(p.title);
  const slots = parseTicketSlots(p.dateText, p.infoText);
  if (slots.length === 0) return null;

  // Zaal: het infoblok bevat naast de zaal ook losse mededelingen
  // ("Gratis toegang. Graag even aanmelden.", "Meer info volgt
  // binnenkort!"). Een zaalnaam is een kort label zonder zinstekens —
  // "Grote zaal", "Rode zaal", of bij een uitvoering elders
  // "Theater Bellevue". "de Brakke Grond" is de venue zelf en zegt
  // niets over waar je moet zijn.
  const room = p.infoParts.find(
    (x) =>
      !/[.!?]/.test(x) &&
      x.split(/\s+/).length <= 4 &&
      !/\d{1,2}[:.]\d{2}/.test(x) &&
      !/brakke\s*grond/i.test(x)
  ) ?? null;

  return {
    url,
    showId,
    title: p.title,
    description: p.description,
    imageUrl: p.imageUrl,
    room,
    slots,
  };
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
    return await uploadToBunny(`media/events/bg-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[brakkegrond] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type BrakkeGrondResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  occurrencesPruned: number;
  skipped: number;
  /** Waaróm er is overgeslagen. Een kale teller verbergt een kapotte
      parser: die stond hier 40 van de 41 pagina's over te slaan en het
      log zei alleen `skipped: 40`. */
  skipReasons: Record<string, number>;
  errors: string[];
};

export async function scrapeBrakkeGrond(options?: {
  venueIds?: string[];
}): Promise<BrakkeGrondResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: BrakkeGrondResult = {
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
  const venueCategory = venue.categories?.[0] ?? 'Theater';

  const cards = await harvestShowUrls();
  result.fetched = cards.length;
  if (cards.length === 0) {
    result.errors.push('geen show-URLs op /agenda');
    return [result];
  }

  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  /** eventId → occurrence-ids die de bron dit rondje aanbood. */
  const seenOcc = new Map<string, Set<string>>();

  for (const { url, category } of cards) {
    try {
      // Een residentie is een werkperiode, geen voorstelling: geen
      // tijd, geen kaartverkoop, niks om heen te gaan. De Brakke Grond
      // zet ze wel op de agenda, wij niet.
      //
      // De ticketknop leek eerst het signaal, maar dat is 'ie niet:
      // zeventien pagina's missen die knop en daar zitten gewone
      // festivals bij (IDFA DocLab, Brainwash) die hun kaarten elders
      // verkopen. Het categorie-label is wél eenduidig.
      if (/residentie/i.test(category)) {
        skip('residentie');
        // Leeg in seenOcc zetten zodat de prune eerder ingelezen
        // datums opruimt. Het event-rijtje blijft leeg achter; dat
        // ruimt scripts/_prune-orphan-events.ts op.
        const resId = url.match(/\/agenda\/(\d+)\//)?.[1];
        if (resId) seenOcc.set(`evt-bg-${resId}`, new Set());
        continue;
      }
      const meta = await fetchShowMeta(url);
      if (!meta) { skip('geen titel of geen datum in ticketblok'); continue; }

      const futureSlots = meta.slots.filter((s) => (s.endsAt ?? s.startsAt).getTime() > cutoff);
      if (futureSlots.length === 0) { skip('alle speeldata voorbij'); continue; }

      const eventId = `evt-bg-${meta.showId}`;
      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;

      if (!existing) {
        let imageUrl: string | null = null;
        if (meta.imageUrl) {
          imageUrl = (await mirrorImage(meta.imageUrl, meta.showId)) ?? meta.imageUrl;
        }
        try {
          enriched = await enrichEvent({
            title: meta.title,
            description: meta.description,
            venueName: venue.name,
            venueCategory,
          });
        } catch (e) {
          result.errors.push(`enrich ${meta.title}: ${(e as Error).message}`);
        }

        const headStart = futureSlots[0]!.startsAt;
        const headEnd = futureSlots[0]!.endsAt;
        const eventKind = refineKindByDuration(enriched?.kind ?? 'show', headStart, headEnd);

        try {
          await db.insert(schema.events).values({
            id: eventId,
            venueId: venue.id,
            title: meta.title,
            description: enriched?.cleanedDescription ?? meta.description,
            kind: eventKind,
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

      for (const slot of futureSlots) {
        try {
          const isoDate = slot.startsAt.toISOString().slice(0, 10);
          const isoTime = slot.startsAt.toISOString().slice(11, 16).replace(':', '-');
          const occurrenceId = `occ-bg-${meta.showId}-${isoDate}T${isoTime}`;
          await db
            .insert(schema.occurrences)
            .values({
              id: occurrenceId,
              eventId,
              startsAt: slot.startsAt,
              endsAt: slot.endsAt,
              priceCents: null,
              priceNote: existing ? null : (enriched?.priceNote ?? null),
              ticketUrl: meta.url,
              room: meta.room,
              lineup: existing ? null : (enriched?.lineup ?? null),
              status: 'scheduled',
            })
            .onConflictDoUpdate({
              target: schema.occurrences.id,
              // room hoort hierbij: die komt elke ronde vers uit de
              // bron, dus een correctie moet een bestaande rij ook
              // bereiken. priceNote en lineup blijven insert-only —
              // die worden door enrich gezet, niet door de bron.
              set: {
                startsAt: slot.startsAt,
                endsAt: slot.endsAt,
                ticketUrl: meta.url,
                room: meta.room,
              },
            });
          result.occurrencesUpserted++;
          const seen = seenOcc.get(eventId) ?? new Set<string>();
          seen.add(occurrenceId);
          seenOcc.set(eventId, seen);
        } catch (err) {
          result.errors.push(`occurrence ${meta.url} ${slot.startsAt.toISOString()}: ${(err as Error).message}`);
          skip('occurrence-write faalde');
        }
      }
    } catch (e) {
      result.errors.push(`show ${url}: ${(e as Error).message}`);
      skip('exception op detailpagina');
    }
  }

  // Toekomstige datums weghalen die de bron niet meer aanbiedt.
  // Zonder dit blijven oude rijen eeuwig staan: er stonden hier 35
  // toekomstige occurrences uit 14 juni die door niemand meer
  // bevestigd werden, en bij een datumwijziging zag je dat nooit.
  //
  // Alleen voor events die we dit rondje écht gezien hebben — een
  // pagina die timeout't of tijdelijk geen ticketblok heeft raakt
  // seenOcc nooit en blijft dus onaangeraakt.
  const pruneCutoff = new Date(cutoff);
  for (const [eventId, keep] of seenOcc) {
    try {
      const bestaand = await db
        .select({ id: schema.occurrences.id })
        .from(schema.occurrences)
        .where(
          and(
            eq(schema.occurrences.eventId, eventId),
            gt(schema.occurrences.startsAt, pruneCutoff)
          )
        );
      const drop = bestaand.map((r) => r.id).filter((id) => !keep.has(id));
      if (!drop.length) continue;
      // Saves hangen aan occurrence-ids. Liever een verlopen rij dan
      // een verdwenen save.
      const saved = await db
        .select({ occurrenceId: schema.saves.occurrenceId })
        .from(schema.saves)
        .where(inArray(schema.saves.occurrenceId, drop));
      const savedIds = new Set(saved.map((r) => r.occurrenceId));
      const finalDrop = drop.filter((id) => !savedIds.has(id));
      if (!finalDrop.length) continue;
      await db
        .delete(schema.occurrences)
        .where(inArray(schema.occurrences.id, finalDrop));
      result.occurrencesPruned += finalDrop.length;
    } catch (e) {
      result.errors.push(`prune ${eventId}: ${(e as Error).message}`);
    }
  }

  return [result];
}
