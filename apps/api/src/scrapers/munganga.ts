import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Teatro Munganga — Braziliaans cultureel centrum (1e Boerhaavestraat 4).
 * WP + WooCommerce: events zijn `product`s in `product_cat=actueel` (13).
 * Datum + tijd staan in de title:
 *
 *   "Sat 30 May 2026, 16hs - 20hs - Democreation, voices of ..."
 *   "Fri 04 Sep 2026 - 20:00 - Nirl Cano Trio, Jazz & ..."
 *   "Fri 25 Sep 2026, 20:00 - Mind Priority, ..."
 *   "Tue 26 May 2026, 18:30 - Sacred Streams, ..."
 *   "Sat 04 Jul 2026 - {title}"  ← geen tijd, default 20:00
 *
 * Non-event producten (zoals boeken) hebben geen datum-prefix en
 * worden door de regex-filter automatisch geskipt.
 *
 * Idempotency: `evt-mu-{productId}`, `occ-mu-{productId}`.
 */

const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const BASE = 'https://munganga.nl/wp-json/wp/v2/product';
const ACTUEEL_CAT = 13;

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

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, mei: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, okt: 9, nov: 10, dec: 11,
};

type ParsedTitle = {
  startsAt: Date;
  endsAt: Date | null;
  cleanTitle: string;
};

function parseTitleDate(raw: string): ParsedTitle | null {
  // Pattern: "{Weekday} {DD} {Mon} {YYYY}[, {HH}[:.]{MM}[hs]][- {HH2}[:.]{MM2}[hs]] - {Title}".
  // `&#8211;` decode't naar en-dash `–` (U+2013); separator-classes
  // moeten zowel ASCII-hyphen als en-dash bevatten.
  const SEP = '[,\\s\\-\\u2013]';
  const re = new RegExp(
    '^([A-Za-z]{3,})\\s+(\\d{1,2})\\s+([A-Za-z]{3,})\\s+(\\d{4})'
      + '(?:' + SEP + '+(\\d{1,2})(?:[:.](\\d{2}))?(?:hs)?'
      + '(?:\\s*[\\-\\u2013]\\s*(\\d{1,2})(?:[:.](\\d{2}))?(?:hs)?)?'
      + ')?'
      + '\\s*[\\-\\u2013]\\s*(.+)$',
  );
  const m = raw.match(re);
  if (!m) return null;
  const day = parseInt(m[2], 10);
  const monIdx = MONTHS[m[3].toLowerCase().slice(0, 3)];
  if (monIdx === undefined) return null;
  const year = parseInt(m[4], 10);
  const h1 = m[5] ? parseInt(m[5], 10) : 20;
  const m1 = m[6] ? parseInt(m[6], 10) : 0;
  // ISO met Amsterdam-offset; ECMAScript Date kan niet parsen met DST-
  // aware zone, dus we kiezen offset op basis van maand (mar-oct = +02,
  // anders +01). Marginaal verschil rond DST-grens accepteren we.
  const dstActive = monIdx >= 2 && monIdx <= 9;
  const off = dstActive ? '+02:00' : '+01:00';
  const iso = `${year}-${String(monIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(h1).padStart(2, '0')}:${String(m1).padStart(2, '0')}:00${off}`;
  const startsAt = new Date(iso);
  if (Number.isNaN(startsAt.getTime())) return null;

  let endsAt: Date | null = null;
  if (m[7]) {
    const h2 = parseInt(m[7], 10);
    const m2 = m[8] ? parseInt(m[8], 10) : 0;
    // Eind dezelfde dag; als eind-uur < start-uur (cross-midnight),
    // shift +1 dag.
    let endHour = h2;
    let endDay = day;
    if (h2 < h1) { endDay += 1; }
    const isoE = `${year}-${String(monIdx + 1).padStart(2, '0')}-${String(endDay).padStart(2, '0')}T${String(endHour).padStart(2, '0')}:${String(m2).padStart(2, '0')}:00${off}`;
    const e = new Date(isoE);
    if (!Number.isNaN(e.getTime())) endsAt = e;
  }

  const cleanTitle = decodeEntities(m[9]).trim();
  return { startsAt, endsAt, cleanTitle };
}

type Category = 'Muziek' | 'Theater' | 'Literatuur' | 'Film' | 'Kunst' | 'Lezing';

function mapCategory(productCats: number[], subCatSlugs: string[]): Category {
  // 689=munganga-concert, 802=casa-feest, 691=munganga-tango → Muziek
  // 687=munganga-kinderen → Theater
  // 690=munganga-salon → Lezing/Theater (talks)
  // 692=munganga-workshop → Kunst (workshops zijn participatief, niet
  // echt 'show', maar Andreas heeft geen workshop-cat — default).
  if (productCats.includes(689) || productCats.includes(802) || productCats.includes(691)) {
    return 'Muziek';
  }
  if (productCats.includes(687)) return 'Theater';
  if (productCats.includes(690)) return 'Lezing';
  if (subCatSlugs.some((s) => s.includes('concert'))) return 'Muziek';
  if (subCatSlugs.some((s) => s.includes('theater') || s.includes('kinder'))) return 'Theater';
  return 'Muziek';
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
    return await uploadToBunny(`media/events/mu-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[munganga] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

type WpProduct = {
  id: number;
  slug: string;
  link: string;
  title: { rendered: string };
  excerpt?: { rendered?: string };
  content?: { rendered?: string };
  featured_media?: number;
  product_cat?: number[];
  _embedded?: {
    'wp:featuredmedia'?: Array<{ source_url?: string }>;
    'wp:term'?: Array<Array<{ slug?: string; taxonomy?: string }>>;
  };
};

async function fetchActueel(): Promise<WpProduct[]> {
  const all: WpProduct[] = [];
  for (let page = 1; page <= 5; page++) {
    const u = `${BASE}?product_cat=${ACTUEEL_CAT}&per_page=50&page=${page}&_embed=wp:featuredmedia,wp:term`;
    try {
      const r = await fetch(u, { headers: { 'user-agent': UA, accept: 'application/json' } });
      if (!r.ok) break;
      const items = (await r.json()) as WpProduct[];
      if (!Array.isArray(items) || items.length === 0) break;
      all.push(...items);
      if (items.length < 50) break;
    } catch {
      break;
    }
  }
  return all;
}

export type MungangaResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeMunganga(_options?: {
  venueIds?: string[];
}): Promise<MungangaResult[]> {
  const venueId = 'aa-teatro-munganga';
  const result: MungangaResult = {
    venueId, fetched: 0, inserted: 0,
    occurrencesUpserted: 0, skipped: 0, errors: [],
  };

  const [venue] = await db
    .select()
    .from(schema.venues)
    .where(eq(schema.venues.id, venueId))
    .limit(1);
  if (!venue) {
    result.errors.push(`venue ${venueId} bestaat niet`);
    return [result];
  }

  const products = await fetchActueel();
  result.fetched = products.length;

  const cutoff = Date.now() - 6 * 60 * 60 * 1000;

  for (const p of products) {
    try {
      const rawTitle = decodeEntities(p.title.rendered);
      const parsed = parseTitleDate(rawTitle);
      if (!parsed) {
        // Geen datum in titel = geen event (waarschijnlijk een boek
        // of donatie-product). Skip stil.
        result.skipped++;
        continue;
      }
      if (parsed.startsAt.getTime() < cutoff) {
        result.skipped++;
        continue;
      }

      const eventId = `evt-mu-${p.id}`;
      const occurrenceId = `occ-mu-${p.id}`;

      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;

      const subCatSlugs = (p._embedded?.['wp:term'] ?? [])
        .flat()
        .filter((t) => t.taxonomy === 'product_cat' && t.slug)
        .map((t) => t.slug!);
      const mappedCategory = mapCategory(p.product_cat ?? [], subCatSlugs);

      if (!existing) {
        const fm = p._embedded?.['wp:featuredmedia']?.[0];
        const sourceImg = fm?.source_url ?? null;
        let imageUrl: string | null = null;
        if (sourceImg) {
          imageUrl = (await mirrorImage(sourceImg, String(p.id))) ?? sourceImg;
        }
        // Excerpt is meestal alleen "Starts 20:00 - Door open 19:30" —
        // de echte tekst zit in `content`. Strip iframes (YouTube
        // embeds) en HTML, neem eerste 800 chars na "Starts/Door"-regel.
        const rawContent = p.content?.rendered ?? '';
        const withoutIframes = rawContent.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
        const text = decodeEntities(stripTags(withoutIframes));
        // Strip de openings-tijd-regel die anders elke description
        // start ("Starts 20:00 - Door open 19:30").
        const description = text
          .replace(/^\s*(?:Starts?(?:\s+at)?\s+\d{1,2}[:.]?\d{0,2}(?:\s*[-–]\s*Doors?\s+open\s+(?:at\s+)?\d{1,2}[:.]?\d{0,2})?)\s*/i, '')
          .trim()
          .slice(0, 800) || null;

        try {
          enriched = await enrichEvent({
            title: parsed.cleanTitle,
            description,
            venueName: venue.name,
            venueCategory: mappedCategory,
          });
        } catch (e) {
          result.errors.push(`enrich ${parsed.cleanTitle}: ${(e as Error).message}`);
        }

        const eventKind = refineKindByDuration(
          enriched?.kind ?? 'show', parsed.startsAt, parsed.endsAt,
        );

        try {
          await db.insert(schema.events).values({
            id: eventId,
            venueId,
            title: parsed.cleanTitle,
            description: enriched?.cleanedDescription ?? description,
            kind: eventKind,
            imageUrl,
            category: enriched?.category ?? mappedCategory,
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
            startsAt: parsed.startsAt,
            endsAt: parsed.endsAt,
            priceCents: null,
            priceNote: existing ? null : (enriched?.priceNote ?? null),
            ticketUrl: p.link,
            room: null,
            lineup: existing ? null : (enriched?.lineup ?? null),
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: {
              startsAt: parsed.startsAt,
              endsAt: parsed.endsAt,
              ticketUrl: p.link,
            },
          });
        result.occurrencesUpserted++;
      } catch (e) {
        result.errors.push(`occurrence ${p.id}: ${(e as Error).message}`);
        result.skipped++;
      }
    } catch (e) {
      result.errors.push(`product ${p.id}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
