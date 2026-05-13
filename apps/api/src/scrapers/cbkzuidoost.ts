import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';
import { extractJsonLdEvents } from './_jsonld-parser.js';

/**
 * CBK Zuidoost (Centrum voor Beeldende Kunst Zuidoost) scraper.
 *
 * Twee-staps WordPress-site:
 *   1. `/tentoonstellingen/nu-en-verwacht/` listing — bevat alleen
 *      links naar individuele tentoonstellings-pagina's, geen events
 *      JSON-LD op de listing zelf.
 *   2. Per detail-pagina staat een Yoast-genereerde
 *      `<script type="application/ld+json">` met `@type:Event`,
 *      startDate, endDate, name, description, image — exact wat we
 *      nodig hebben.
 *
 * Kind: altijd 'exhibition' (CBK toont uitsluitend tentoonstellingen
 * op deze listing — geen losse lezingen). Time-component clamped naar
 * 00:00–23:59 op de start/eind-datum; API normaliseert dat verder
 * zodat de mobile-UI 'Hele dag' toont.
 *
 * Idempotency: event-id op slug uit de detail-URL.
 */

const VENUE_ID = 'cbk-zuidoost';
const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const LISTING_URL =
  'https://www.cbkzuidoost.nl/tentoonstellingen/nu-en-verwacht/';
const BASE = 'https://www.cbkzuidoost.nl';

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

function extractDetailLinks(html: string): Array<{ url: string; slug: string }> {
  const found = new Map<string, string>();
  const re =
    /href="(https:\/\/www\.cbkzuidoost\.nl\/tentoonstellingen\/nu-en-verwacht\/([^"\/]+)\/?)"/g;
  for (const m of html.matchAll(re)) {
    const url = m[1];
    const slug = m[2];
    // Listing-zelf heeft geen slug — daar ontbreekt het laatste pad-deel.
    if (!slug || slug === 'nu-en-verwacht') continue;
    if (!found.has(slug)) found.set(slug, url);
  }
  return Array.from(found, ([slug, url]) => ({ slug, url }));
}

function shiftToLocalEdge(
  iso: string,
  edge: 'start' | 'end'
): Date | null {
  // CBK levert datums als `YYYY-MM-DD` (date-only) of volledige ISO.
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) {
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10) - 1;
  const d = parseInt(m[3], 10);
  const h = edge === 'start' ? 0 : 23;
  const mi = edge === 'start' ? 0 : 59;
  // Construct in Amsterdam local time → naar UTC.
  const tentative = new Date(Date.UTC(y, mo, d, h, mi, 0));
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Amsterdam',
    timeZoneName: 'longOffset',
  });
  const off = dtf
    .formatToParts(tentative)
    .find((p) => p.type === 'timeZoneName')?.value;
  const off2 = off?.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  const sign = off2 && off2[1] === '+' ? 1 : -1;
  const oh = off2 ? parseInt(off2[2], 10) : 0;
  const om = off2 ? parseInt(off2[3] ?? '0', 10) : 0;
  return new Date(tentative.getTime() - sign * (oh * 60 + om) * 60_000);
}

async function mirrorImage(
  sourceUrl: string,
  slug: string
): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 8 * 1024 * 1024) return null;
    const ext = mime.includes('png')
      ? 'png'
      : mime.includes('webp')
        ? 'webp'
        : 'jpg';
    return await uploadToBunny(
      `media/events/cbkzuidoost-${slug}.${ext}`,
      buf,
      mime
    );
  } catch (e) {
    console.warn(
      `[cbkzuidoost] mirror image failed: ${(e as Error).message}`
    );
    return null;
  }
}

export type CbkZuidoostResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeCbkZuidoost(options?: {
  venueIds?: string[];
}): Promise<CbkZuidoostResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: CbkZuidoostResult = {
    venueId: VENUE_ID,
    fetched: 0,
    inserted: 0,
    occurrencesUpserted: 0,
    skipped: 0,
    errors: [],
  };

  const [venue] = await db
    .select()
    .from(schema.venues)
    .where(eq(schema.venues.id, VENUE_ID));
  if (!venue) {
    result.errors.push('venue niet in DB');
    return [result];
  }

  const listingHtml = await fetchHtml(LISTING_URL);
  if (!listingHtml) {
    result.errors.push('listing niet bereikbaar');
    return [result];
  }

  const detailLinks = extractDetailLinks(listingHtml);
  result.fetched = detailLinks.length;

  const venueCategory = venue.categories?.[0] ?? 'Kunst';

  for (const { url, slug } of detailLinks) {
    try {
      const eventId = `evt-cbkzuidoost-${slug}`;
      const occurrenceId = `occ-cbkzuidoost-${slug}`;

      const detailHtml = await fetchHtml(url);
      if (!detailHtml) {
        result.skipped++;
        result.errors.push(`${slug}: detail niet bereikbaar`);
        continue;
      }
      const events = extractJsonLdEvents(detailHtml);
      const ev = events[0];
      if (!ev) {
        result.skipped++;
        result.errors.push(`${slug}: geen JSON-LD Event op detail-pagina`);
        continue;
      }

      // Yoast plaatst de hero-image niet op het Event-object zelf
      // (alleen op WebPage). Val daarom terug op og:image als de
      // JSON-LD Event geen image-veld bevat.
      let imageSrc = ev.imageUrl;
      if (!imageSrc) {
        const og = detailHtml.match(
          /<meta\s+property="og:image"\s+content="([^"]+)"/
        );
        if (og) imageSrc = og[1];
      }

      // Clamp naar dag-edges; API normaliseert dat verder voor de mobile
      // UI als 'Hele dag'.
      const startsAt =
        shiftToLocalEdge(
          (ev as unknown as { startsAt: Date }).startsAt.toISOString(),
          'start'
        ) ?? (ev as unknown as { startsAt: Date }).startsAt;
      const endsAt = ev.endsAt
        ? shiftToLocalEdge(ev.endsAt.toISOString(), 'end')
        : null;

      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      if (existing) {
        await db
          .insert(schema.occurrences)
          .values({
            id: occurrenceId,
            eventId,
            startsAt,
            endsAt,
            priceCents: null,
            priceNote: null,
            ticketUrl: url,
            room: null,
            lineup: null,
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: { startsAt, endsAt, ticketUrl: url },
          });
        result.occurrencesUpserted++;
        continue;
      }

      const enriched = await enrichEvent({
        title: ev.name,
        description: ev.description,
        venueName: venue.name,
        venueCategory,
      });

      let imageUrl: string | null = null;
      if (imageSrc) {
        imageUrl = (await mirrorImage(imageSrc, slug)) ?? imageSrc;
      }

      // CBK is een tentoonstellings-instelling — forceer 'exhibition'.
      // refineKindByDuration zou ook tot dezelfde conclusie komen
      // gezien de multi-day range, maar expliciet is veiliger.
      const initialKind: 'exhibition' = 'exhibition';
      const refinedKind = refineKindByDuration(initialKind, startsAt, endsAt);

      await db.transaction(async (tx) => {
        await tx.insert(schema.events).values({
          id: eventId,
          venueId: venue.id,
          title: ev.name,
          description: enriched.cleanedDescription ?? ev.description,
          kind: refinedKind,
          imageUrl,
          category: enriched.category ?? venueCategory,
          featured: false,
          genres: enriched.genres,
          published: true,
        });
        result.inserted++;

        await tx
          .insert(schema.occurrences)
          .values({
            id: occurrenceId,
            eventId,
            startsAt,
            endsAt,
            priceCents: null,
            priceNote: enriched.priceNote,
            ticketUrl: url,
            room: enriched.room,
            lineup: enriched.lineup,
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: {
              startsAt,
              endsAt,
              priceNote: enriched.priceNote,
              ticketUrl: url,
              room: enriched.room,
              lineup: enriched.lineup,
            },
          });
        result.occurrencesUpserted++;
      });
    } catch (e) {
      result.errors.push(`${slug}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
