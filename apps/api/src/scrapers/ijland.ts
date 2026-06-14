import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * IJland (NDSM/Vasumweg) — Custom WP-theme, geen tribe-events. Events
 * staan in `<div class="agenda_card">` blokken op /agenda/:
 *
 *   <a class="overlap_link" href="https://ijland.nl/agenda/{slug}/">
 *   <img src="...">
 *   <span class="date">DD/MM/YYYY</span>
 *   <h5>title</h5>
 *   <strong class="agenda-tag">Clubnight</strong>
 *   <a class="btn_three" href="...weeztix/paylogic/divedeeplabel/...">GET TICKETS</a>
 *
 * Geen start-tijd op listing → default 23:00 (Clubnight).
 *
 * Idempotency: `evt-ijl-{slug}`, `occ-ijl-{slug}-{ISO-date}`.
 */

const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const PAGE_URL = 'https://ijland.nl/agenda/';
const VENUE_ID = 'ijland';

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(parseInt(c, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, c) => String.fromCodePoint(parseInt(c, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, ' ');
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

type Card = {
  slug: string;
  url: string;
  title: string;
  startsAt: Date;
  imageUrl: string | null;
  tag: string | null;
  ticketUrl: string | null;
};

async function parseCards(html: string): Promise<Card[]> {
  const out: Card[] = [];
  const cardRe = /<div class="agenda_card">([\s\S]*?)<\/div>\s*<\/div>/g;
  for (const m of html.matchAll(cardRe)) {
    const block = m[0];

    // Overlap link → slug + url
    const linkM = block.match(/<a class="overlap_link" href="(https:\/\/ijland\.nl\/agenda\/([a-z0-9-]+)\/?)"/);
    if (!linkM) continue;
    const url = linkM[1];
    const slug = linkM[2];

    // Image
    let imageUrl: string | null = null;
    const imgM = block.match(/<img\s+src="([^"]+)"/);
    if (imgM) imageUrl = imgM[1];

    // Date: <span class="date">DD/MM/YYYY</span>
    const dateM = block.match(/<span class="date">(\d{1,2})\/(\d{1,2})\/(\d{4})<\/span>/);
    if (!dateM) continue;
    const day = parseInt(dateM[1], 10);
    const month = parseInt(dateM[2], 10);
    const year = parseInt(dateM[3], 10);
    const dst = month >= 3 && month <= 10;
    const off = dst ? '+02:00' : '+01:00';

    // Default 23:00 (club) maar detail-pagina kan overrulen via
    // `<span>HH:MM - HH:MM</span>` of `aanvang HH:MM`. Listing zelf
    // bevat de tijd niet — Music Bingo bv. start om 20:00, niet 23:00.
    let hour = 23;
    let minute = 0;
    try {
      const det = await fetch(url, { headers: { 'user-agent': UA } });
      if (det.ok) {
        const html = await det.text();
        const tm =
          html.match(/<span>\s*(\d{1,2})[:.](\d{2})\s*-\s*\d{1,2}[:.]\d{2}\s*<\/span>/) ??
          html.match(/aanvang[^<]{0,40}?(\d{1,2})[:.](\d{2})/i);
        if (tm) {
          hour = parseInt(tm[1], 10);
          minute = parseInt(tm[2], 10);
        }
      }
    } catch {
      /* gebruik default 23:00 */
    }
    const startsAt = new Date(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${off}`);
    if (Number.isNaN(startsAt.getTime())) continue;

    // Title
    const titleM = block.match(/<h5 class="notranslate">([\s\S]*?)<\/h5>/);
    if (!titleM) continue;
    const title = decodeEntities(stripTags(titleM[1])).trim();
    if (!title) continue;
    // Private events filteren — verhuurde avonden zonder publieke
    // tickets, geen UX-waarde.
    if (/^private\s+event/i.test(title)) continue;

    // Tag
    let tag: string | null = null;
    const tagM = block.match(/<strong class="agenda-tag">([\s\S]*?)<\/strong>/);
    if (tagM) tag = decodeEntities(stripTags(tagM[1])).trim();

    // Ticket-URL (eerste btn_three a-tag)
    let ticketUrl: string | null = null;
    const ticketM = block.match(/<a[^>]+href="([^"]+)"[^>]*class="[^"]*btn_three[^"]*"/);
    if (ticketM) ticketUrl = ticketM[1];

    out.push({ slug, url, title, startsAt, imageUrl, tag, ticketUrl });
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
    return await uploadToBunny(`media/events/ijl-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[ijland] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type IJlandResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeIJland(_options?: {
  venueIds?: string[];
}): Promise<IJlandResult[]> {
  const result: IJlandResult = {
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

  const cards = await parseCards(html);
  result.fetched = cards.length;

  const cutoff = Date.now() - 6 * 60 * 60 * 1000;

  for (const card of cards) {
    try {
      if (card.startsAt.getTime() < cutoff) {
        result.skipped++;
        continue;
      }
      const isoDate = card.startsAt.toISOString().slice(0, 10);
      const eventId = `evt-ijl-${card.slug}`;
      const occurrenceId = `occ-ijl-${card.slug}-${isoDate}`;

      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;

      if (!existing) {
        let imageUrl: string | null = null;
        if (card.imageUrl) {
          imageUrl = (await mirrorImage(card.imageUrl, card.slug)) ?? card.imageUrl;
        }
        const description = card.tag ? `Tag: ${card.tag}` : null;

        try {
          enriched = await enrichEvent({
            title: card.title,
            description,
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
            description: enriched?.cleanedDescription ?? description,
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
        const ticketUrl = card.ticketUrl ?? card.url;
        await db
          .insert(schema.occurrences)
          .values({
            id: occurrenceId,
            eventId,
            startsAt: card.startsAt,
            endsAt: null,
            priceCents: null,
            priceNote: existing ? null : (enriched?.priceNote ?? null),
            ticketUrl,
            room: null,
            lineup: existing ? null : (enriched?.lineup ?? null),
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: { startsAt: card.startsAt, ticketUrl },
          });
        result.occurrencesUpserted++;
      } catch (e) {
        result.errors.push(`occurrence ${card.slug}: ${(e as Error).message}`);
        result.skipped++;
      }
    } catch (e) {
      result.errors.push(`card ${card.slug}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
