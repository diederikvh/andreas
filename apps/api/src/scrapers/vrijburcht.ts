import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';
import { loadVenueTitleMap, resolveEventId } from './_title-dedup.js';

/**
 * Podium Vrijburcht — buurttheater op IJburg (Vrijburchtstraat 2).
 * Custom WP-template (Divi-thema) zonder publieke event-CPT. Events
 * staan als `<article>` blokken op `/programma/?pno={1..N}` met alle
 * essentiële data inline (title, datetime-attr, image, link).
 *
 *   - `<time datetime="ISO">vrijdag 29 mei</time>` → startsAt
 *   - `<h1 class="entry-title"><a href="...">title</a></h1>`
 *   - `<img class="attachment-theater" src="...">`
 *   - `<div class="event-categories"><a>Film/Theater/...</a></div>`
 *   - `<div class="entry-content"><p>description</p></div>`
 *
 * Idempotency: `evt-vb-{slug-uit-url}`, `occ-vb-{slug-uit-url}` —
 * Vrijburcht is altijd één voorstelling per slug (geen multi-night
 * structures gezien).
 */

const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const BASE = 'https://theatervrijburcht.nl';

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

type RawEvent = {
  url: string;
  slug: string;
  canonicalSlug: string;
  title: string;
  startsAt: Date;
  category: string | null;
  imageUrl: string | null;
  description: string | null;
};

/** Strip een `-YYYY-MM-DD` suffix uit een slug zodat recurring shows
 *  (Vrijburcht's "kindervoorstelling-2-2026-06-14" t/m "-2026-12-13")
 *  onder één canonical-slug groeperen — één event met N occurrences
 *  i.p.v. N losse events. */
function canonicalizeSlug(slug: string): string {
  return slug.replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

function parseListing(html: string): RawEvent[] {
  const out: RawEvent[] = [];
  // `<article id="event-{ID}" class="event hentry row-fluid">` ...
  // `</article>` blokken — niet-greedy match.
  const articleRe = /<article id="event-\d+"[^>]*class="event[^"]*"[\s\S]*?<\/article>/g;
  for (const m of html.matchAll(articleRe)) {
    const block = m[0];
    const linkM = block.match(/<h1 class="entry-title"><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h1>/);
    if (!linkM) continue;
    const url = linkM[1];
    const title = decodeEntities(stripTags(linkM[2]));
    if (!title) continue;
    const slug = url.replace(/\/$/, '').split('/').pop() || '';
    if (!slug) continue;
    const canonicalSlug = canonicalizeSlug(slug);
    const dtM = block.match(/<time class="entry-date" datetime="([^"]+)"/);
    if (!dtM) continue;
    const startsAt = new Date(dtM[1]);
    if (Number.isNaN(startsAt.getTime())) continue;
    const catM = block.match(/<div class="event-categories">[\s\S]*?<a[^>]*>([^<]+)<\/a>/);
    const category = catM ? decodeEntities(catM[1].trim()) : null;
    // <img>-attributes komen in willekeurige volgorde (src vóór of na
    // class). Eerst hele img-tag pakken, dan src eruit.
    const imgTagM = block.match(/<img[^>]*class="attachment-theater[^"]*"[^>]*>/)
      ?? block.match(/<img[^>]*class="[^"]*attachment-theater[^"]*"[^>]*>/);
    let imageUrl: string | null = null;
    if (imgTagM) {
      const srcM = imgTagM[0].match(/\ssrc="([^"]+)"/);
      if (srcM) {
        // Listing-image is 522x348; strip die suffix voor hogere res.
        imageUrl = srcM[1].replace(/-\d+x\d+(\.(?:jpe?g|png|webp))$/i, '$1');
      }
    }
    const descM = block.match(/<div class="entry-content">\s*<p>([\s\S]*?)<\/p>/);
    const description = descM ? decodeEntities(stripTags(descM[1])).slice(0, 800) : null;
    out.push({ url, slug, canonicalSlug, title, startsAt, category, imageUrl, description });
  }
  return out;
}

async function fetchPage(p: number): Promise<RawEvent[]> {
  const url = p === 1 ? `${BASE}/programma/` : `${BASE}/programma/?pno=${p}`;
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA } });
    if (!r.ok) return [];
    return parseListing(await r.text());
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
    return await uploadToBunny(`media/events/vb-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[vrijburcht] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

type Category = 'Muziek' | 'Theater' | 'Literatuur' | 'Film' | 'Kunst' | 'Lezing';

function mapCategory(label: string | null): Category | null {
  if (!label) return null;
  const lower = label.toLowerCase();
  if (lower.includes('film')) return 'Film';
  if (lower.includes('concert') || lower.includes('muziek')) return 'Muziek';
  if (lower.includes('lezing')) return 'Lezing';
  if (lower.includes('expo') || lower.includes('tentoonstelling')) return 'Kunst';
  // Familievoorstelling, jeugd, voorstelling, cabaret → Theater
  return 'Theater';
}

export type VrijburchtResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeVrijburcht(_options?: {
  venueIds?: string[];
}): Promise<VrijburchtResult[]> {
  const venueId = 'podium-vrijburcht';
  const result: VrijburchtResult = {
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
  const venueCategory: Category = (venue.categories?.[0] as Category) ?? 'Theater';

  // Loop tot empty page (max 10 voor safety).
  const all: RawEvent[] = [];
  const seen = new Set<string>();
  for (let p = 1; p <= 10; p++) {
    const items = await fetchPage(p);
    if (items.length === 0) break;
    for (const it of items) {
      if (seen.has(it.slug)) continue;
      seen.add(it.slug);
      all.push(it);
    }
  }
  result.fetched = all.length;

  // Group by canonicalSlug — recurring shows (kindervoorstelling-2-…)
  // merging naar één event met meerdere occurrences.
  const groups = new Map<string, RawEvent[]>();
  for (const it of all) {
    const arr = groups.get(it.canonicalSlug) ?? [];
    arr.push(it);
    groups.set(it.canonicalSlug, arr);
  }

  const cutoff = Date.now() - 6 * 60 * 60 * 1000;

  const byTitle = await loadVenueTitleMap(venueId, 'evt-vb-');

  for (const [canonicalSlug, group] of groups) {
    try {
      const fresh = group.filter((it) => it.startsAt.getTime() > cutoff);
      if (fresh.length === 0) {
        result.skipped++;
        continue;
      }
      // Pak het earliest-fresh-item als head (voor titel/image/desc).
      fresh.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
      const head = fresh[0];

      // head heeft titel, datum en description al — beide signalen gratis.
      const { eventId } = resolveEventId(
        byTitle,
        head.title,
        `evt-vb-${canonicalSlug}`,
        { startsAt: head.startsAt, description: head.description }
      );
      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;
      const mappedCategory = mapCategory(head.category) ?? venueCategory;

      if (!existing) {
        let imageUrl: string | null = null;
        if (head.imageUrl) {
          imageUrl = (await mirrorImage(head.imageUrl, canonicalSlug)) ?? head.imageUrl;
        }
        try {
          enriched = await enrichEvent({
            title: head.title,
            description: head.description,
            venueName: venue.name,
            venueCategory: mappedCategory,
          });
        } catch (e) {
          result.errors.push(`enrich ${head.title}: ${(e as Error).message}`);
        }

        const eventKind = refineKindByDuration(
          enriched?.kind ?? 'show', head.startsAt, null,
        );

        try {
          await db.insert(schema.events).values({
            id: eventId,
            venueId,
            title: head.title,
            description: enriched?.cleanedDescription ?? head.description,
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

      for (const ev of fresh) {
        try {
          const occurrenceId = `occ-vb-${ev.slug}`;
          await db
            .insert(schema.occurrences)
            .values({
              id: occurrenceId,
              eventId,
              startsAt: ev.startsAt,
              endsAt: null,
              priceCents: null,
              priceNote: existing ? null : (enriched?.priceNote ?? null),
              ticketUrl: ev.url,
              room: null,
              lineup: existing ? null : (enriched?.lineup ?? null),
              status: 'scheduled',
            })
            .onConflictDoUpdate({
              target: schema.occurrences.id,
              // eventId meenemen: occurrences die nog aan een losse
              // groep hingen verhuizen zo zelf mee.
              set: { eventId, startsAt: ev.startsAt, ticketUrl: ev.url },
            });
          result.occurrencesUpserted++;
        } catch (e) {
          result.errors.push(`occurrence ${ev.slug}: ${(e as Error).message}`);
          result.skipped++;
        }
      }
    } catch (e) {
      result.errors.push(`group ${canonicalSlug}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
