import { createHash } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';
import { extractJsonLdEvents } from './_jsonld-parser.js';

/**
 * JSON-LD (Schema.org) scraper. Voor venues die hun agenda renderen met
 * `<script type="application/ld+json">`-blocks (filmtheaters via
 * tickets-platforms, kunstinstellingen met SEO-georiënteerde theming).
 *
 * Config in `venues.scraperConfig.jsonld`:
 *   { url: "https://kriterion.nl/programma-vandaag" }
 *
 * Idempotency: deterministisch event-id op sha256(uid). Image alleen
 * gemirrord bij eerste keer; occurrence-velden upserten zodat
 * datum/ticket/status-changes doorkomen.
 */

const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const MAX_BYTES = 8 * 1024 * 1024;

type JsonLdConfig = { url: string };

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

async function mirrorImageToBunny(
  sourceUrl: string,
  venueId: string,
  uidHash: string
): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return null;
    const ext = mime.includes('png')
      ? 'png'
      : mime.includes('webp')
        ? 'webp'
        : mime.includes('gif')
          ? 'gif'
          : mime.includes('avif')
            ? 'avif'
            : 'jpg';
    const path = `media/events/jsonld-${venueId}-${uidHash}.${ext}`;
    return await uploadToBunny(path, buf, mime);
  } catch (e) {
    console.warn(
      `[jsonld] mirror image ${sourceUrl} failed: ${(e as Error).message}`
    );
    return null;
  }
}

export type JsonLdVenueResult = {
  venueId: string;
  venueName: string;
  url: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

/** Heuristiek: een schema.org-image die clearly de venue-logo of favicon
 *  is, willen we niet mirroren — dan toon je hetzelfde plaatje bij elk
 *  event. Skip URLs die `logo`, `favicon` of `icon` bevatten. */
function looksLikeLogo(url: string): boolean {
  const u = url.toLowerCase();
  return /\b(logo|favicon|icon)\b/.test(u);
}

/** Default-uur in Europe/Amsterdam voor date-only events per venue-type.
 *  Voor date-only `startDate: "2026-05-08"` zonder tijd: kies een
 *  plausibele avond-tijd zodat de event niet als 02:00 NL eindigt. */
function defaultStartHourForVenueType(type: string | null): number {
  switch (type) {
    case 'club':
      return 23;
    case 'podium':
    case 'film':
      return 20;
    case 'museum':
    case 'galerie':
      return 11;
    default:
      return 20;
  }
}

/** Default duur (in uren) voor date-only events. Conservatief gekozen
 *  zodat de "tot ~05:00 club"-vibe duidelijk is, maar niet zo lang dat
 *  het event op de volgende dag in agenda's blijft hangen.
 *  Resultaat = endsAt zodat de detail-page een "23:00 – 05:00"-range
 *  kan tonen i.p.v. alleen "Aanvang 23:00". */
function defaultDurationHoursForVenueType(type: string | null): number {
  switch (type) {
    case 'club':
      return 6; // typische club-nacht: 23:00 → 05:00
    case 'podium':
      return 3;
    case 'film':
      return 2;
    case 'museum':
    case 'galerie':
      return 8; // open van 11:00 t/m 19:00
    default:
      return 3;
  }
}

/** Verschuif een UTC-midnight Date naar de lokale `hour:minute` in
 *  Europe/Amsterdam. Voor `2026-05-08T00:00:00Z` met hour=23, minute=0
 *  → `2026-05-08T21:00:00Z` (= 23:00 NL zomertijd). Houdt rekening
 *  met DST. */
function shiftToLocalTime(
  utcMidnight: Date,
  hour: number,
  minute: number = 0
): Date {
  // Bouw een lokale tijd in Europe/Amsterdam, vraag de offset, corrigeer.
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Amsterdam',
    timeZoneName: 'longOffset',
  });
  const tzNamePart = dtf
    .formatToParts(utcMidnight)
    .find((p) => p.type === 'timeZoneName');
  const m = tzNamePart?.value.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  const sign = m && m[1] === '+' ? 1 : -1;
  const offsetH = m ? parseInt(m[2], 10) : 0;
  const offsetMin = m ? parseInt(m[3] ?? '0', 10) : 0;
  const offsetMinutes = sign * (offsetH * 60 + offsetMin);
  // utcMidnight = UTC start of day. Local hour 23 = UTC (23 - offsetH).
  // Add hours+minutes to UTC, subtract offset to keep "local time" interpretation.
  const utcMinuteEquivalent = hour * 60 + minute - offsetMinutes;
  return new Date(utcMidnight.getTime() + utcMinuteEquivalent * 60_000);
}

async function scrapeOneVenue(
  venue: typeof schema.venues.$inferSelect,
  cfg: JsonLdConfig
): Promise<JsonLdVenueResult> {
  const result: JsonLdVenueResult = {
    venueId: venue.id,
    venueName: venue.name,
    url: cfg.url,
    fetched: 0,
    inserted: 0,
    occurrencesUpserted: 0,
    skipped: 0,
    errors: [],
  };

  let html: string;
  try {
    const r = await fetch(cfg.url, { headers: { 'user-agent': UA } });
    if (!r.ok) {
      result.errors.push(`fetch: HTTP ${r.status}`);
      return result;
    }
    html = await r.text();
  } catch (e) {
    result.errors.push(`fetch: ${(e as Error).message}`);
    return result;
  }

  const events = extractJsonLdEvents(html);
  result.fetched = events.length;

  // Filter voorbij events weg — cutoff = nu - 6u zodat avond-events die
  // tot 03:00 doorgaan op hun avond nog binnenkomen.
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  const upcoming = events.filter(
    (e) => (e.endsAt ?? e.startsAt).getTime() > cutoff
  );

  const venueCategory = venue.categories?.[0] ?? 'Muziek';

  for (const ev of upcoming) {
    try {
      const uidHash = shortHash(ev.uid);
      const eventId = `evt-jld-${venue.id}-${uidHash}`;
      const occurrenceId = `occ-jld-${venue.id}-${uidHash}`;

      // Date-only events (zoals Lofi's "2026-05-08" zonder tijd):
      // 1) Voorkeur: tijd-range gevonden in surrounding HTML
      //    ("14:00 – 05:00" naast het JSON-LD-script).
      // 2) Anders: venue-type default startuur + default-duur,
      //    zodat een club-avond niet om 02:00 NL begint en de
      //    detail-page een tijd-range kan tonen.
      let startsAt = ev.startsAt;
      let endsAt = ev.endsAt;
      if (ev.isDateOnly) {
        if (ev.htmlStartTime) {
          startsAt = shiftToLocalTime(
            ev.startsAt,
            ev.htmlStartTime.hour,
            ev.htmlStartTime.minute
          );
          if (ev.htmlEndTime) {
            // Eind-uur kleiner dan of gelijk aan start-uur betekent
            // over middernacht. Gelijk = 24h-event ("23:00 – 23:00"
            // bij Lofi's Ratherlost).
            const endIsNextDay =
              ev.htmlEndTime.hour < ev.htmlStartTime.hour ||
              (ev.htmlEndTime.hour === ev.htmlStartTime.hour &&
                ev.htmlEndTime.minute <= ev.htmlStartTime.minute);
            const baseDay = endIsNextDay
              ? new Date(ev.startsAt.getTime() + 24 * 60 * 60_000)
              : ev.startsAt;
            endsAt = shiftToLocalTime(
              baseDay,
              ev.htmlEndTime.hour,
              ev.htmlEndTime.minute
            );
          } else {
            endsAt = null;
          }
        } else {
          const hour = defaultStartHourForVenueType(venue.type);
          const durationH = defaultDurationHoursForVenueType(venue.type);
          startsAt = shiftToLocalTime(ev.startsAt, hour);
          endsAt = new Date(startsAt.getTime() + durationH * 60 * 60_000);
        }
      }

      const enriched = await enrichEvent({
        title: ev.name,
        description: ev.description,
        venueName: venue.name,
        venueCategory,
      });

      // Performers uit JSON-LD als lineup-fallback wanneer Claude er
      // geen heeft gevonden. Default rol = "act"; Claude's lineup
      // (met dj/headliner/support rollen) wint als die er is.
      const lineup =
        enriched.lineup && enriched.lineup.length > 0
          ? enriched.lineup
          : ev.performers.length > 0
            ? ev.performers.map((name) => ({ name }))
            : null;

      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      let imageUrl: string | null = null;
      if (!existing && ev.imageUrl && !looksLikeLogo(ev.imageUrl)) {
        imageUrl =
          (await mirrorImageToBunny(ev.imageUrl, venue.id, uidHash)) ??
          ev.imageUrl;
      }

      const status: 'scheduled' | 'cancelled' | 'sold_out' = 'scheduled';

      // Refine kind: lange all-day events → exhibition.
      const refinedKind = refineKindByDuration(enriched.kind, startsAt, endsAt);

      await db.transaction(async (tx) => {
        if (!existing) {
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
        }

        await tx
          .insert(schema.occurrences)
          .values({
            id: occurrenceId,
            eventId,
            startsAt,
            endsAt,
            priceCents: null,
            priceNote: enriched.priceNote,
            ticketUrl: ev.ticketUrl,
            room: enriched.room,
            lineup,
            status,
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: {
              startsAt,
              endsAt,
              priceNote: enriched.priceNote,
              ticketUrl: ev.ticketUrl,
              room: enriched.room,
              lineup,
              status,
            },
          });
        result.occurrencesUpserted++;
      });
    } catch (e) {
      result.errors.push(`event ${ev.uid}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return result;
}

export async function scrapeJsonLd(options?: {
  venueIds?: string[];
}): Promise<JsonLdVenueResult[]> {
  const all = await db.select().from(schema.venues);
  const targets = all.filter((v) => {
    const cfg = v.scraperConfig?.jsonld;
    if (!cfg?.url) return false;
    if (options?.venueIds && !options.venueIds.includes(v.id)) return false;
    return true;
  });

  const results: JsonLdVenueResult[] = [];
  for (const v of targets) {
    const cfg = v.scraperConfig!.jsonld!;
    results.push(await scrapeOneVenue(v, cfg));
  }
  return results;
}
