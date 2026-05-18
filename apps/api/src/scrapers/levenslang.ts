import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Levenslang (Watergraafsmeer) — Webflow CMS-collection op /programma.
 * Per item een `<div class="programma_item w-dyn-item">` met:
 *   - `<img class="programma_img" src="...">`
 *   - date: `<div ...>Fri</div><div ...>19.6.2026</div>` (D.M.YYYY)
 *   - title: `<div class="text-uppercase text-weight-bold">…</div>` (binnen .programma_title-container)
 *   - lineup: `<div class="text-uppercase">…</div>` (binnen .programma_artist-wrapper)
 *   - ticket: `<a href="/events/{slug}" class="programma_ticket-button">`
 *   - hidden end-time: `<div class="event-date-time-hidden">YYYY-MM-DD H:MM</div>`
 *
 * Start-tijd onbekend → default 23:00 (clubavond).
 *
 * Idempotency: `evt-ll-{slug}`, `occ-ll-{slug}`.
 */

const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const PAGE_URL = 'https://www.levenslang.amsterdam/programma';
const SITE_BASE = 'https://www.levenslang.amsterdam';
const VENUE_ID = 'levenslang';

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
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  imageUrl: string | null;
  lineup: string | null;
};

function parseCards(html: string): Card[] {
  const out: Card[] = [];
  // Match elk programma_item blok (matcht ook de detailed-view binnenin
  // — we de-dup later op slug).
  const itemRe = /<div[^>]*class="programma_item w-dyn-item"[^>]*>([\s\S]*?)(?=<div[^>]*class="programma_item w-dyn-item"|<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*<\/div>)/g;
  for (const m of html.matchAll(itemRe)) {
    const block = m[0];

    // Ticket-link + slug
    const ticketM = block.match(/<a[^>]*href="(\/events\/[a-z0-9-]+)"[^>]*class="[^"]*programma_ticket-button[^"]*"/)
      ?? block.match(/href="(\/events\/[a-z0-9-]+)"[^>]*class="[^"]*programma_ticket-button[^"]*"/);
    if (!ticketM) continue;
    const slug = ticketM[1].split('/').pop()!;
    if (!slug) continue;

    // Datum: "Fri" + "19.6.2026"
    const dateM = block.match(/<div class="display-inlineflex[^"]*">([A-Z][a-z]{2})<\/div><div class="display-inlineflex[^"]*">(\d{1,2})\.(\d{1,2})\.(\d{4})<\/div>/);
    if (!dateM) continue;
    const day = parseInt(dateM[2], 10);
    const month = parseInt(dateM[3], 10);
    const year = parseInt(dateM[4], 10);
    // Start-tijd niet in HTML → default 23:00 (club).
    const dst = month >= 3 && month <= 10;
    const off = dst ? '+02:00' : '+01:00';
    const startsAt = new Date(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T23:00:00${off}`);
    if (Number.isNaN(startsAt.getTime())) continue;

    // End-tijd uit hidden field "2026-06-20 5:00"
    let endsAt: Date | null = null;
    const endM = block.match(/<div class="event-date-time-hidden">(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})<\/div>/);
    if (endM) {
      const e = new Date(`${endM[1]}T${endM[2].padStart(2, '0')}:${endM[3]}:00${off}`);
      if (!Number.isNaN(e.getTime())) endsAt = e;
    }

    // Title in .programma_title-container (skip de logo-image div ervoor)
    const titleM = block.match(/<div class="programma_title-container">[\s\S]*?<div class="text-uppercase text-weight-bold[^"]*"[^>]*>([^<]+)<\/div>/);
    if (!titleM) continue;
    const title = decodeEntities(titleM[1]).trim();
    if (!title) continue;

    // Image (programma_img class)
    let imageUrl: string | null = null;
    const imgM = block.match(/<img[^>]*class="programma_img"[^>]*src="([^"]+)"/);
    if (imgM) {
      imageUrl = imgM[1].replace(/-p-\d+(\.(?:jpe?g|png|webp))$/i, '$1');
    }

    // Lineup uit .programma_artist-wrapper
    let lineup: string | null = null;
    const lineM = block.match(/<div class="programma_artist-wrapper">[\s\S]*?<div class="text-uppercase[^"]*"[^>]*>([^<]+)<\/div>/);
    if (lineM) {
      lineup = decodeEntities(stripTags(lineM[1])).trim();
    }

    // Dedup op slug — Webflow rendert standard-view én detailed-view per item.
    if (out.some((c) => c.slug === slug)) continue;
    out.push({ slug, title, startsAt, endsAt, imageUrl, lineup });
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
    return await uploadToBunny(`media/events/ll-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[levenslang] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type LevenslangResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeLevenslang(_options?: {
  venueIds?: string[];
}): Promise<LevenslangResult[]> {
  const result: LevenslangResult = {
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
      const eventId = `evt-ll-${card.slug}`;
      const occurrenceId = `occ-ll-${card.slug}`;

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
        const description = card.lineup ? `Line-up: ${card.lineup}` : null;

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
          enriched?.kind ?? 'show', card.startsAt, card.endsAt,
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
        const ticketUrl = `${SITE_BASE}/events/${card.slug}`;
        await db
          .insert(schema.occurrences)
          .values({
            id: occurrenceId,
            eventId,
            startsAt: card.startsAt,
            endsAt: card.endsAt,
            priceCents: null,
            priceNote: existing ? null : (enriched?.priceNote ?? null),
            ticketUrl,
            room: null,
            lineup: existing ? null : (enriched?.lineup ?? null),
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: { startsAt: card.startsAt, endsAt: card.endsAt, ticketUrl },
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
