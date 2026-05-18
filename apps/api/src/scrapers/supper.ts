import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Supper Club Amsterdam — events worden gerenderd als Elementor cards
 * op `/club/`. Elke card-container heeft:
 *   - `<img>` (event-image, WEBSITE-CLUB-N.webp)
 *   - `<p>May 21, 2026 23:00 – 04:00</p>` (datum + tijd-range)
 *   - `<h3><a>title</a></h3>` (event-naam)
 *   - `<p>CLUB</p>` (category-label)
 *   - `<p>LINE UP: artist, artist, …</p>`
 *   - `<a class="elementor-button" href="...">Get your tickets</a>`
 *
 * De ticket-URLs zijn divers (ticketapp.com, shop.weeztix.com, ...);
 * we slaan ze raw op zonder verdere parsing. WhatsApp-VIP-buttons
 * skippen we (wa.me links).
 *
 * Idempotency: `evt-supper-{title-slug}`, `occ-supper-{title-slug}-{ISO-date}`.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const PAGE_URL = 'https://supper.nl/club/';
const VENUE_ID = 'supper';

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(parseInt(c, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, c) => String.fromCodePoint(parseInt(c, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, mei: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, okt: 9, nov: 10, november: 10, dec: 11, december: 11,
};

type ParsedCard = {
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  imageUrl: string | null;
  lineup: string | null;
  ticketUrl: string | null;
};

/** Parse "May 21, 2026 23:00 – 04:00" → start/end Date in Amsterdam-tz. */
function parseDateTime(text: string): { startsAt: Date; endsAt: Date | null } | null {
  // Match: Month DD, YYYY HH:MM(–HH:MM)?
  const m = text.match(
    /([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2})[:.](\d{2})(?:\s*[-–]\s*(\d{1,2})[:.](\d{2}))?/,
  );
  if (!m) return null;
  const monIdx = MONTHS[m[1].toLowerCase().slice(0, 3)];
  if (monIdx === undefined) return null;
  const day = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  const startH = parseInt(m[4], 10);
  const startMin = parseInt(m[5], 10);
  // DST grof: mar-oct = +02, anders +01.
  const dst = monIdx >= 2 && monIdx <= 9;
  const off = dst ? '+02:00' : '+01:00';
  const datePart = `${year}-${String(monIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const startsAt = new Date(`${datePart}T${String(startH).padStart(2, '0')}:${String(startMin).padStart(2, '0')}:00${off}`);
  if (Number.isNaN(startsAt.getTime())) return null;

  let endsAt: Date | null = null;
  if (m[6]) {
    const endH = parseInt(m[6], 10);
    const endMin = parseInt(m[7], 10);
    // Cross-midnight (23:00 – 04:00) → end op volgende dag
    let endDate = datePart;
    if (endH < startH || (endH === startH && endMin < startMin)) {
      const d = new Date(`${datePart}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      endDate = d.toISOString().slice(0, 10);
    }
    const e = new Date(`${endDate}T${String(endH).padStart(2, '0')}:${String(endMin).padStart(2, '0')}:00${off}`);
    if (!Number.isNaN(e.getTime())) endsAt = e;
  }
  return { startsAt, endsAt };
}

function parseCards(html: string): ParsedCard[] {
  const out: ParsedCard[] = [];
  // Anchor op date-paragraaf "<p>May 21, 2026 23:00 – 04:00</p>". Voor
  // elke match nemen we een window van ±5000 chars en pluken daar
  // image (vóór), titel/lineup/button (na).
  const dateBlockRe = /<p>\s*([A-Z][a-z]+\s+\d{1,2},\s+\d{4}\s+\d{1,2}[:.]\d{2}(?:\s*[-–]\s*\d{1,2}[:.]\d{2})?)\s*<\/p>/g;
  for (const m of html.matchAll(dateBlockRe)) {
    const idx = m.index ?? 0;
    const parsed = parseDateTime(m[1]);
    if (!parsed) continue;

    const before = html.slice(Math.max(0, idx - 5000), idx);
    const after = html.slice(idx + m[0].length, idx + m[0].length + 6000);

    // Image staat vóór de datum (Elementor render-order: image → text)
    // Pak de laatste img-tag vóór de datum.
    const imgs = [...before.matchAll(/<img[^>]+src="(https:\/\/supper\.nl\/wp-content\/uploads\/[^"]+\.(?:jpe?g|png|webp))"/g)];
    let imageUrl: string | null = null;
    if (imgs.length > 0) {
      imageUrl = imgs[imgs.length - 1][1]
        .replace(/-\d+x\d+(\.(?:jpe?g|png|webp))$/i, '$1');
    }

    // Titel: eerstvolgende h3.elementor-heading-title NA de datum
    let title: string | null = null;
    const h3M = after.match(/<h3[^>]*class="elementor-heading-title[^"]*"[^>]*>([\s\S]{1,400}?)<\/h3>/);
    if (h3M) {
      title = decodeEntities(stripTags(h3M[1])).trim();
    }
    if (!title) continue;

    // Line-up: eerstvolgende <p>LINE UP: …</p>
    let lineup: string | null = null;
    const lineM = after.match(/<p>\s*LINE\s*UP:\s*([^<]+)<\/p>/i);
    if (lineM) {
      lineup = decodeEntities(lineM[1]).trim();
    }

    // Ticket-URL: eerste elementor-button NA datum, niet naar wa.me
    let ticketUrl: string | null = null;
    for (const b of after.matchAll(/<a class="elementor-button[^"]*" href="([^"]+)"/g)) {
      if (b[1].startsWith('https://wa.me/')) continue;
      ticketUrl = b[1];
      break;
    }

    out.push({
      title,
      startsAt: parsed.startsAt,
      endsAt: parsed.endsAt,
      imageUrl,
      lineup,
      ticketUrl,
    });
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
    return await uploadToBunny(`media/events/supper-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[supper] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type SupperResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeSupper(_options?: {
  venueIds?: string[];
}): Promise<SupperResult[]> {
  const result: SupperResult = {
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

  // Decode entities globaal vóór regex-parsing — Elementor codeert
  // `–` als `&#8211;` en `'` als `&#8217;`. We willen één keer
  // beslissen i.p.v. in elke deelregex.
  html = decodeEntities(html);

  const cards = parseCards(html);
  result.fetched = cards.length;

  const cutoff = Date.now() - 6 * 60 * 60 * 1000;

  for (const card of cards) {
    try {
      if (card.startsAt.getTime() < cutoff) {
        result.skipped++;
        continue;
      }
      const titleSlug = slugify(card.title);
      if (!titleSlug) {
        result.skipped++;
        continue;
      }
      const isoDate = card.startsAt.toISOString().slice(0, 10);
      const eventId = `evt-supper-${titleSlug}`;
      const occurrenceId = `occ-supper-${titleSlug}-${isoDate}`;

      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;

      if (!existing) {
        let imageUrl: string | null = null;
        if (card.imageUrl) {
          imageUrl = (await mirrorImage(card.imageUrl, titleSlug)) ?? card.imageUrl;
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
        const ticketUrl = card.ticketUrl ?? PAGE_URL;
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
        result.errors.push(`occurrence ${occurrenceId}: ${(e as Error).message}`);
        result.skipped++;
      }
    } catch (e) {
      result.errors.push(`card ${card.title}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
