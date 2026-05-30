import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Amsterdamse Bostheater — WP-site, custom theme. Programma op
 * /ons-programma/ met `?sf_paged=N` pagination, 6 events per page.
 *
 * Elke `<article class="event-card">` heeft:
 *   - <span class="event-card-terms__type">Concert/Theater</span>
 *   - <span class="event-card-terms__genre-name">Musical/Muziek/...</span>+
 *   - <h3 class="event-card-title">title</h3>
 *   - <div class="event-card-description"><p>…</p></div>
 *   - <time datetime="YYYY-MM-DD" class="…from">…</time>
 *     [optional <time datetime="YYYY-MM-DD" class="…end">]
 *   - <img class="event-card__img" src="...">
 *   - <a class="add-to-cart" href="https://www.eventim.nl/…">tickets</a>
 *   - <a href="https://bostheater.nl/events/{slug}/">Meer informatie</a>
 *
 * Geen start-tijd op listing → default 20:00 (theater-avond). Multi-day
 * festivals krijgen één event met `endsAt` = einddatum 23:59 lokaal.
 *
 * Idempotency: `evt-bos-{slug}`, `occ-bos-{slug}-{ISO-from-date}`.
 */

const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const BASE = 'https://bostheater.nl';
const VENUE_ID = 'bostheater';

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

type Card = {
  slug: string;
  detailUrl: string;
  title: string;
  type: string | null;
  genres: string[];
  description: string | null;
  startsAt: Date;
  endsAt: Date | null;
  imageUrl: string | null;
  ticketUrl: string | null;
};

/** Detail-page heeft `<time datetime="YYYY-MM-DD HH:MM">` voor elke
 *  voorstelling. Listing geeft alleen de datum; default 20:00 is fout
 *  voor venues die om 20:15 of 19:30 starten. */
async function fetchBostheaterStartTime(
  detailUrl: string,
): Promise<{ hour: number; minute: number } | null> {
  try {
    const r = await fetch(detailUrl, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const html = await r.text();
    const m = html.match(/datetime="\d{4}-\d{2}-\d{2}\s+(\d{1,2}):(\d{2})"/);
    if (!m) return null;
    return { hour: parseInt(m[1], 10), minute: parseInt(m[2], 10) };
  } catch {
    return null;
  }
}

function parseCards(html: string): Card[] {
  const out: Card[] = [];
  const articleRe = /<article class="event-card[^"]*">([\s\S]*?)<\/article>/g;
  for (const m of html.matchAll(articleRe)) {
    const block = m[1];

    // Detail-link → slug
    const linkM = block.match(/<a class="btn btn--secondary[^"]*" href="(https:\/\/bostheater\.nl\/events\/([a-z0-9-]+)\/?)"/);
    if (!linkM) continue;
    const detailUrl = linkM[1];
    const slug = linkM[2];

    // Title
    const titleM = block.match(/<h3 class="heading-4 event-card-title">\s*([^<]+?)\s*<\/h3>/);
    if (!titleM) continue;
    const title = decodeEntities(titleM[1]).trim();

    // Type ("Concert"/"Theater"/…)
    let type: string | null = null;
    const typeM = block.match(/<span class="event-card-terms__type">\s*([^<]+?)\s*<\/span>/);
    if (typeM) type = decodeEntities(typeM[1]).trim();

    // Genres (kan meerdere zijn)
    const genres: string[] = [];
    for (const g of block.matchAll(/<span class="event-card-terms__genre-name">\s*([^<]+?)\s*<\/span>/g)) {
      const v = decodeEntities(g[1]).trim();
      if (v) genres.push(v);
    }

    // Description
    let description: string | null = null;
    const descM = block.match(/<div class="event-card-description">\s*<p>([\s\S]*?)<\/p>\s*<\/div>/);
    if (descM) description = decodeEntities(stripTags(descM[1])).slice(0, 800) || null;

    // Datums: from + optionally end
    const fromM = block.match(/<time class="event-card-date__datetime event-card-date__from"[^>]+datetime="(\d{4}-\d{2}-\d{2})"/);
    if (!fromM) continue;
    const fromDate = fromM[1];
    const endM = block.match(/<time class="event-card-date__datetime event-card-date__end"[^>]+datetime="(\d{4}-\d{2}-\d{2})"/);
    const endDate = endM ? endM[1] : null;

    // DST grof: mar-oct = +02, anders +01.
    const month = parseInt(fromDate.slice(5, 7), 10);
    const dst = month >= 3 && month <= 10;
    const off = dst ? '+02:00' : '+01:00';
    const startsAt = new Date(`${fromDate}T20:00:00${off}`);
    if (Number.isNaN(startsAt.getTime())) continue;

    let endsAt: Date | null = null;
    if (endDate) {
      const endMonth = parseInt(endDate.slice(5, 7), 10);
      const endDst = endMonth >= 3 && endMonth <= 10;
      const endOff = endDst ? '+02:00' : '+01:00';
      const e = new Date(`${endDate}T23:59:00${endOff}`);
      if (!Number.isNaN(e.getTime())) endsAt = e;
    }

    // Image (i0.wp.com proxied; pak de raw bostheater.nl URL).
    // src en class kunnen in willekeurige volgorde — eerst hele img-tag,
    // dan src eruit.
    let imageUrl: string | null = null;
    const imgTagM = block.match(/<img[^>]*class="[^"]*event-card__img[^"]*"[^>]*>/);
    if (imgTagM) {
      const srcM = imgTagM[0].match(/\ssrc="(https?:\/\/[^"]+)"/);
      if (srcM) {
        // i0.wp.com\/bostheater.nl\/wp-content\/... → bostheater.nl\/wp-content\/...
        imageUrl = srcM[1]
          .replace(/^https:\/\/i\d\.wp\.com\//, 'https://')
          .replace(/\?[^"]*$/, '')
          .replace(/&amp;/g, '&');
      }
    }

    // Ticket-URL (add-to-cart button)
    let ticketUrl: string | null = null;
    const ticketM = block.match(/<a[^>]*class="btn btn--primary add-to-cart[^"]*"[^>]*href="([^"]+)"/);
    if (ticketM) ticketUrl = decodeEntities(ticketM[1]);

    out.push({
      slug, detailUrl, title, type, genres,
      description, startsAt, endsAt, imageUrl, ticketUrl,
    });
  }
  return out;
}

async function fetchPage(page: number): Promise<Card[]> {
  const url = page === 1
    ? `${BASE}/ons-programma/`
    : `${BASE}/ons-programma/?sf_paged=${page}`;
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA } });
    if (!r.ok) return [];
    return parseCards(await r.text());
  } catch {
    return [];
  }
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
    return await uploadToBunny(`media/events/bos-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[bostheater] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

type Category = 'Muziek' | 'Theater' | 'Literatuur' | 'Film' | 'Kunst' | 'Lezing';

function mapCategory(type: string | null, genres: string[]): Category {
  const t = (type ?? '').toLowerCase();
  const g = genres.map((x) => x.toLowerCase());
  if (t.includes('film') || g.some((x) => x.includes('film'))) return 'Film';
  if (t.includes('concert') || g.some((x) => x.includes('muziek') || x.includes('concert'))) {
    return 'Muziek';
  }
  if (g.some((x) => x.includes('expo') || x.includes('beeld'))) return 'Kunst';
  if (g.some((x) => x.includes('lezing') || x.includes('talk'))) return 'Lezing';
  // Theater/Musical/Toneel/Muziektheater/Dans → Theater
  return 'Theater';
}

export type BostheaterResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeBostheater(_options?: {
  venueIds?: string[];
}): Promise<BostheaterResult[]> {
  const result: BostheaterResult = {
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

  const all: Card[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= 10; page++) {
    const cards = await fetchPage(page);
    if (cards.length === 0) break;
    let added = 0;
    for (const c of cards) {
      if (seen.has(c.slug)) continue;
      seen.add(c.slug);
      all.push(c);
      added++;
    }
    if (added === 0) break;
  }
  result.fetched = all.length;

  const cutoff = Date.now() - 6 * 60 * 60 * 1000;

  // Cache start-time per slug; detail-page kost één fetch maar geeft
  // de echte tijd (vaak 20:15 ipv 20:00 default).
  const timeCache = new Map<string, { hour: number; minute: number } | null>();

  for (const card of all) {
    try {
      if (card.startsAt.getTime() < cutoff) {
        result.skipped++;
        continue;
      }
      // Override de listing's default 20:00 met de echte tijd uit
      // de detail-page: `<time datetime="YYYY-MM-DD HH:MM">`.
      if (!timeCache.has(card.slug)) {
        timeCache.set(card.slug, await fetchBostheaterStartTime(card.detailUrl));
      }
      const realTime = timeCache.get(card.slug) ?? null;
      if (realTime) {
        const parts = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Europe/Amsterdam',
          year: 'numeric', month: '2-digit', day: '2-digit',
        }).formatToParts(card.startsAt);
        const get = (t: string) => parts.find((p) => p.type === t)!.value;
        const m = parseInt(get('month'), 10);
        const dst = m >= 3 && m <= 10;
        const off = dst ? '+02:00' : '+01:00';
        const hh = String(realTime.hour).padStart(2, '0');
        const mm = String(realTime.minute).padStart(2, '0');
        card.startsAt = new Date(`${get('year')}-${get('month')}-${get('day')}T${hh}:${mm}:00${off}`);
      }
      const isoDate = card.startsAt.toISOString().slice(0, 10);
      const eventId = `evt-bos-${card.slug}`;
      const occurrenceId = `occ-bos-${card.slug}-${isoDate}`;

      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      const mappedCategory = mapCategory(card.type, card.genres);
      let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;

      if (!existing) {
        let imageUrl: string | null = null;
        if (card.imageUrl) {
          imageUrl = (await mirrorImage(card.imageUrl, card.slug)) ?? card.imageUrl;
        }
        try {
          enriched = await enrichEvent({
            title: card.title,
            description: card.description,
            venueName: venue.name,
            venueCategory: mappedCategory,
          });
        } catch (e) {
          result.errors.push(`enrich ${card.title}: ${(e as Error).message}`);
        }

        const eventKind = refineKindByDuration(
          enriched?.kind ?? 'show', card.startsAt, card.endsAt,
        );

        // Merge venue-genres met enriched genres (venue-genres zijn
        // "Musical/Toneel/Concert" — beschrijvend, niet muzieksubgenre)
        const finalGenres = enriched?.genres && enriched.genres.length > 0
          ? enriched.genres
          : card.genres.map((g) => g.toLowerCase());

        try {
          await db.insert(schema.events).values({
            id: eventId,
            venueId: VENUE_ID,
            title: card.title,
            description: enriched?.cleanedDescription ?? card.description,
            kind: eventKind,
            imageUrl,
            category: enriched?.category ?? mappedCategory,
            featured: false,
            genres: finalGenres,
            published: true,
          });
          result.inserted++;
        } catch (e) {
          result.errors.push(`insert event ${eventId}: ${(e as Error).message}`);
          continue;
        }
      }

      try {
        const ticketUrl = card.ticketUrl ?? card.detailUrl;
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
