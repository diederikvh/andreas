import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Generic scraper voor theater-venues met een eigen agenda achter
 * een SPA. Pattern: sitemap.xml geeft de complete lijst show-URLs;
 * per show-URL fetchen we (eventueel met Googlebot UA om prerender
 * te triggeren) en pluken `Event` JSON-LD blokken eruit. Multi-night
 * shows hebben meerdere blokken (Carré Cats: 12; Meervaart GRIMM: 3)
 * die we groeperen op title-slug naar één event met N occurrences.
 *
 * Voor venues waar JSON-LD alleen één Event-range geeft (DeLaMar
 * heeft startDate=eerste avond, endDate=laatste avond, en de
 * individuele datums in `data-date="YYYY-MM-DD"` attrs), zetten we
 * `useDataDateAttrs: true` in scraperConfig.theater.
 *
 * Idempotency:
 *  - eventId       = `evt-th-{venueId}-{showSlug}`
 *  - occurrenceId  = `occ-th-{venueId}-{showSlug}-{ISO-date}`
 */

const UA_BOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const UA_REG = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';

type SchemaOrgEvent = {
  '@type': string;
  name?: string;
  startDate?: string;
  endDate?: string;
  description?: string;
  image?: string | { url?: string } | Array<string | { url?: string }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
};

function pickImageUrl(image: SchemaOrgEvent['image']): string | null {
  if (!image) return null;
  if (typeof image === 'string') return image;
  if (Array.isArray(image)) {
    for (const x of image) {
      const u = typeof x === 'string' ? x : x?.url;
      if (u) return u;
    }
    return null;
  }
  return image.url ?? null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(parseInt(c, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, c) => String.fromCodePoint(parseInt(c, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
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

async function fetchHtml(url: string, useBot: boolean): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { 'user-agent': useBot ? UA_BOT : UA_REG } });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

async function fetchSitemap(url: string, depth = 0): Promise<string[]> {
  if (depth > 3) return [];
  const r = await fetch(url, { headers: { 'user-agent': UA_REG } });
  if (!r.ok) return [];
  const xml = await r.text();
  const isIndex = /<sitemapindex\b/.test(xml);
  const out: string[] = [];
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    out.push(m[1]);
  }
  if (!isIndex) return out;
  // Sitemap-index: recursive volgens alle sub-sitemaps. Concertgebouw,
  // Bimhuis e.d. splitsen hun sitemap in `sitemap_sections_*.xml` of
  // `event-sitemap{N}.xml`.
  const all: string[] = [];
  for (const sub of out) {
    const subUrls = await fetchSitemap(sub, depth + 1);
    all.push(...subUrls);
  }
  return all;
}

function extractEvents(html: string): SchemaOrgEvent[] {
  const out: SchemaOrgEvent[] = [];
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]+?)<\/script>/g)) {
    const s = m[1].trim();
    if (!s) continue;
    try {
      const d = JSON.parse(s);
      const items: unknown[] = Array.isArray(d) ? d : d?.['@graph'] ? d['@graph'] : [d];
      for (const x of items) {
        if (x && typeof x === 'object' && /Event/i.test(String((x as SchemaOrgEvent)['@type']))) {
          out.push(x as SchemaOrgEvent);
        }
      }
    } catch {
      continue;
    }
  }
  return out;
}

function extractDataDates(html: string): string[] {
  const set = new Set<string>();
  for (const m of html.matchAll(/data-date="(\d{4}-\d{2}-\d{2})"/g)) {
    set.add(m[1]);
  }
  return Array.from(set);
}

async function mirrorImage(sourceUrl: string, slug: string): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, { headers: { 'user-agent': UA_REG } });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 8 * 1024 * 1024) return null;
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    return await uploadToBunny(`media/events/th-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[theater] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type TheaterVenueResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeTheater(options?: {
  venueIds?: string[];
}): Promise<TheaterVenueResult[]> {
  const allVenues = await db.select().from(schema.venues);
  const targets = allVenues.filter((v) => {
    if (options?.venueIds && !options.venueIds.includes(v.id)) return false;
    return Boolean(v.scraperConfig?.theater?.sitemapUrl);
  });

  const results: TheaterVenueResult[] = [];

  for (const venue of targets) {
    const cfg = venue.scraperConfig!.theater!;
    const result: TheaterVenueResult = {
      venueId: venue.id,
      fetched: 0,
      inserted: 0,
      occurrencesUpserted: 0,
      skipped: 0,
      errors: [],
    };

    const venueCategory = venue.categories?.[0] ?? 'Theater';
    const showRe = new RegExp(cfg.showUrlPattern);
    const stripRe = cfg.showSlugStripPattern
      ? new RegExp(cfg.showSlugStripPattern)
      : null;

    const allUrls = await fetchSitemap(cfg.sitemapUrl);
    const showUrls = Array.from(new Set(allUrls.filter((u) => showRe.test(u))));
    result.fetched = showUrls.length;

    for (const url of showUrls) {
      try {
        const html = await fetchHtml(url, !!cfg.useGooglebotUA);
        if (!html) { result.skipped++; continue; }

        const evs = extractEvents(html);
        if (evs.length === 0) { result.skipped++; continue; }

        // Title komt uit het eerste Event blok. Slug uit de URL voor
        // stable IDs (titel kan kleine wijzigingen hebben tussen runs).
        // Als JSON-LD een eigen `url` heeft (= de canonieke event-URL,
        // bv. Concertgebouw waar `babyconcert-0-t-m-18-maanden` een
        // alias is voor `loes-luca-the-ramblers`), gebruiken we die
        // voor de slug zodat alle alias-pages naar één event mergen.
        const head = evs[0];
        const title = head.name?.trim();
        if (!title) { result.skipped++; continue; }
        const canonicalUrl =
          typeof head.url === 'string' && head.url.length > 0 ? head.url : url;
        let showSlug = canonicalUrl
          .replace(/\/$/, '')
          .split('/')
          .pop()!
          .toLowerCase();
        // Strip optioneel een venue-specifiek prefix (bv. Concert-
        // gebouw geeft elke voorstelling een eigen `{numericId}-`
        // prefix — zonder strip wordt elke avond een eigen event).
        if (stripRe) showSlug = showSlug.replace(stripRe, '');
        const titleSlug = slugify(showSlug || title);
        if (!titleSlug) { result.skipped++; continue; }

        const eventId = `evt-th-${venue.id}-${titleSlug}`;

        const [existing] = await db
          .select({ id: schema.events.id })
          .from(schema.events)
          .where(eq(schema.events.id, eventId))
          .limit(1);

        let imageUrl: string | null = null;
        let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;
        let description: string | null = null;
        let eventKind: 'show' | 'exhibition' = 'show';

        // Bouw occurrence-list eerst — voor venues met grote sitemap
        // (Concertgebouw: ~4000 historische concerten) skippen we de
        // dure ops als alle slots al voorbij zijn.
        type Slot = { startsAt: Date; endsAt: Date | null };
        const slots: Slot[] = [];

        if (cfg.useDataDateAttrs) {
          const dates = extractDataDates(html);
          for (const d of dates) {
            const startsAt = new Date(`${d}T20:00:00+02:00`);
            if (!isNaN(startsAt.getTime())) slots.push({ startsAt, endsAt: null });
          }
        } else {
          for (const ev of evs) {
            if (!ev.startDate) continue;
            const startsAt = new Date(ev.startDate);
            if (isNaN(startsAt.getTime())) continue;
            const endsAt = ev.endDate ? new Date(ev.endDate) : null;
            slots.push({ startsAt, endsAt });
          }
        }

        const cutoff = Date.now() - 6 * 60 * 60 * 1000;
        const fresh = slots.filter((s) => (s.endsAt ?? s.startsAt).getTime() > cutoff);
        if (fresh.length === 0) { result.skipped++; continue; }

        if (!existing) {
          description = head.description ? decodeEntities(head.description) : null;
          try {
            enriched = await enrichEvent({
              title,
              description,
              venueName: venue.name,
              venueCategory,
            });
          } catch (e) {
            result.errors.push(`enrich ${title}: ${(e as Error).message}`);
          }

          const sourceImg = pickImageUrl(head.image);
          if (sourceImg) {
            imageUrl = (await mirrorImage(sourceImg, `${venue.id}-${titleSlug}`)) ?? sourceImg;
          }

          const headStart = fresh[0]?.startsAt ?? new Date();
          const headEnd = fresh[0]?.endsAt ?? null;
          eventKind = refineKindByDuration(enriched?.kind ?? 'show', headStart, headEnd);

          try {
            await db.insert(schema.events).values({
              id: eventId,
              venueId: venue.id,
              title,
              description: enriched?.cleanedDescription ?? description,
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

        for (const slot of fresh) {
          try {
            const isoDate = slot.startsAt.toISOString().slice(0, 10);
            const occurrenceId = `occ-th-${venue.id}-${titleSlug}-${isoDate}`;
            await db
              .insert(schema.occurrences)
              .values({
                id: occurrenceId,
                eventId,
                startsAt: slot.startsAt,
                endsAt: slot.endsAt,
                priceCents: null,
                priceNote: existing ? null : (enriched?.priceNote ?? null),
                ticketUrl: url,
                room: existing ? null : (enriched?.room ?? null),
                lineup: existing ? null : (enriched?.lineup ?? null),
                status: 'scheduled',
              })
              .onConflictDoUpdate({
                target: schema.occurrences.id,
                set: {
                  startsAt: slot.startsAt,
                  endsAt: slot.endsAt,
                  ticketUrl: url,
                },
              });
            result.occurrencesUpserted++;
          } catch (e) {
            result.errors.push(`occurrence ${url} ${slot.startsAt.toISOString()}: ${(e as Error).message}`);
            result.skipped++;
          }
        }
      } catch (e) {
        result.errors.push(`show ${url}: ${(e as Error).message}`);
        result.skipped++;
      }
    }

    results.push(result);
  }

  return results;
}
