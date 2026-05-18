import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Odessa Amsterdam (Veemkade) — Wix-site die zijn programma uit
 * Hipsy.nl trekt en als repeater-items op de homepage rendert. Per
 * event-id zien we een blok met:
 *   - <img src="https://cdn.hipsy.nl/images/events/{id}-{uuid}.jpg">
 *   - aria-label="Wed 20 May"           (dag-naam + DD Month, geen jaar)
 *   - aria-label="Ecstatic Dance | …"   (event-title)
 *   - <a href="https://hipsy.nl/event/{numId}-{slug}">…</a>
 *
 * Jaar wordt afgeleid uit de huidige datum (als parsed datum in 't
 * verleden valt, +1 jaar).
 *
 * Idempotency: `evt-od-{hipsy-id}`, `occ-od-{hipsy-id}`.
 */

const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const PAGE_URL = 'https://www.odessa.amsterdam/';
const VENUE_ID = 'odessa';

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(parseInt(c, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, c) => String.fromCodePoint(parseInt(c, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, ' ');
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, mei: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, okt: 9, nov: 10, dec: 11,
};

type Card = {
  hipsyId: string;
  title: string;
  startsAt: Date;
  imageUrl: string | null;
  ticketUrl: string;
};

/** Parse "Wed 20 May" of "Sat 30 Aug" → Date in Amsterdam-tz. Geen
 *  jaar in input — pak huidig jaar; als parsed datum >60 dagen in 't
 *  verleden, neem volgend jaar. */
function parseDate(label: string): Date | null {
  const m = label.match(/^[A-Za-z]{3}\s+(\d{1,2})\s+([A-Za-z]{3,})$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const monIdx = MONTHS[m[2].toLowerCase().slice(0, 3)];
  if (monIdx === undefined) return null;
  const now = new Date();
  let year = now.getFullYear();
  const dst = monIdx >= 2 && monIdx <= 9;
  let off = dst ? '+02:00' : '+01:00';
  // Ecstatic dance is typisch in de avond — default 19:00 NL.
  let dt = new Date(`${year}-${String(monIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T19:00:00${off}`);
  if (Number.isNaN(dt.getTime())) return null;
  // Roll naar volgend jaar als parsed datum in 't verleden ligt
  if (dt.getTime() < now.getTime() - 60 * 24 * 60 * 60_000) {
    year += 1;
    dt = new Date(`${year}-${String(monIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T19:00:00${off}`);
    if (Number.isNaN(dt.getTime())) return null;
  }
  return dt;
}

function parseCards(html: string): Card[] {
  const out: Card[] = [];
  const seen = new Set<string>();
  // Anchor op repeater-item containers: `comp-mdgkbbmq__{hipsyId}`.
  // hipsyId is een numerieke event-id (zie Hipsy URLs).
  const containerRe = /id="comp-mdgkbbmq__(\d+)"([\s\S]*?)(?=id="comp-mdgkbbmq__\d+"|<\/section>)/g;
  for (const cm of html.matchAll(containerRe)) {
    const hipsyId = cm[1];
    if (seen.has(hipsyId)) continue;
    seen.add(hipsyId);
    const block = cm[0];

    // Hipsy ticket URL (eerste binnen blok)
    const ticketM = block.match(/href="(https:\/\/hipsy\.nl\/event\/\d+-[a-z0-9-]+)"/);
    if (!ticketM) continue;
    const ticketUrl = ticketM[1];

    // Image (hipsy CDN)
    let imageUrl: string | null = null;
    const imgM = block.match(/<img[^>]+src="(https:\/\/cdn\.hipsy\.nl\/images\/events\/[^"]+)"/);
    if (imgM) imageUrl = imgM[1];

    // Twee aria-labels: eerste is "Wed 20 May", tweede de titel.
    const ariaMs = [...block.matchAll(/aria-label="([^"]+)"/g)]
      .map((m) => decodeEntities(m[1]).trim())
      .filter((s) => s && !/^(TICKETS|JOIN|MORE)$/i.test(s));
    if (ariaMs.length < 2) continue;
    const dateLabel = ariaMs[0];
    const title = ariaMs[1];
    if (!title) continue;
    const startsAt = parseDate(dateLabel);
    if (!startsAt) continue;

    out.push({ hipsyId, title, startsAt, imageUrl, ticketUrl });
  }
  return out;
}

async function mirrorImage(sourceUrl: string, slug: string): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength < 1024 || buf.byteLength > 16 * 1024 * 1024) return null;
    const ext = mime.includes('png') ? 'png'
      : mime.includes('webp') ? 'webp'
      : mime.includes('avif') ? 'avif' : 'jpg';
    return await uploadToBunny(`media/events/od-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[odessa] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type OdessaResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeOdessa(_options?: {
  venueIds?: string[];
}): Promise<OdessaResult[]> {
  const result: OdessaResult = {
    venueId: VENUE_ID, fetched: 0, inserted: 0,
    occurrencesUpserted: 0, skipped: 0, errors: [],
  };

  const [venue] = await db
    .select()
    .from(schema.venues)
    .where(eq(schema.venues.id, VENUE_ID))
    .limit(1);
  if (!venue) {
    result.errors.push(`venue ${VENUE_ID} bestaat niet`);
    return [result];
  }

  let html: string;
  try {
    const r = await fetch(PAGE_URL, { headers: { 'user-agent': UA } });
    if (!r.ok) {
      result.errors.push(`fetch ${PAGE_URL}: HTTP ${r.status}`);
      return [result];
    }
    html = await r.text();
  } catch (e) {
    result.errors.push(`fetch error: ${(e as Error).message}`);
    return [result];
  }

  const cards = parseCards(html);
  result.fetched = cards.length;

  const cutoff = Date.now() - 6 * 60 * 60 * 1000;

  for (const card of cards) {
    try {
      if (card.startsAt.getTime() < cutoff) {
        result.skipped++;
        continue;
      }
      const eventId = `evt-od-${card.hipsyId}`;
      const occurrenceId = `occ-od-${card.hipsyId}`;

      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;

      if (!existing) {
        let imageUrl: string | null = null;
        if (card.imageUrl) {
          imageUrl = (await mirrorImage(card.imageUrl, card.hipsyId)) ?? card.imageUrl;
        }

        try {
          enriched = await enrichEvent({
            title: card.title,
            description: null,
            venueName: venue.name,
            venueCategory: 'Muziek',
          });
        } catch (e) {
          result.errors.push(`enrich ${card.title}: ${(e as Error).message}`);
        }

        const eventKind = refineKindByDuration(
          enriched?.kind ?? 'show', card.startsAt, null,
        );

        try {
          await db.insert(schema.events).values({
            id: eventId,
            venueId: VENUE_ID,
            title: card.title,
            description: enriched?.cleanedDescription ?? null,
            kind: eventKind,
            imageUrl,
            category: enriched?.category ?? 'Muziek',
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
            startsAt: card.startsAt,
            endsAt: null,
            priceCents: null,
            priceNote: existing ? null : (enriched?.priceNote ?? null),
            ticketUrl: card.ticketUrl,
            room: null,
            lineup: existing ? null : (enriched?.lineup ?? null),
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: { startsAt: card.startsAt, ticketUrl: card.ticketUrl },
          });
        result.occurrencesUpserted++;
      } catch (e) {
        result.errors.push(`occurrence ${card.hipsyId}: ${(e as Error).message}`);
        result.skipped++;
      }
    } catch (e) {
      result.errors.push(`card ${card.hipsyId}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
