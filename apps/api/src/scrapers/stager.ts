import { createHash } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';
import {
  fetchMediamaticContent,
  type MediamaticContent,
} from './_mediamatic-enrich.js';

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

/**
 * Stager-scraper. Voor venues die op stager.co tickets verkopen
 * (Radion, Cinetol, Mediamatic, Splendor, If I Can't Dance) — drie
 * publieke API-calls per venue:
 *
 *   1. POST  /shop/v1/session/new                        → JWT
 *   2. GET   /shop/v1/events                             → eventId-lijst
 *   3. GET   /shop/v1/events/{id}/publicity              → titel/desc/image
 *      GET   /shop/v1/events/{id}/tickets-overview       → prijs-tiers
 *
 * De config zit per venue in `venues.scraperConfig.stager`:
 *   { host: "radionamsterdam.stager.co", shopId: 92 }
 *
 * Idempotency: deterministische ids op basis van Stager's eventId.
 * Bij her-runs wordt het event NIET overschreven (curator-edits aan
 * titel/description blijven), maar de occurrence wordt wel ge-upsert
 * zodat prijs-changes en sold-out-status doorkomen.
 */

const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';

type StagerConfig = { host: string; shopId: number; shopHandle?: string };

type StagerEvent = {
  eventId: number;
  name: string;
  startsOn: string;
  endsOn: string;
  saleStartsSoon: boolean;
  soldOut: boolean;
};

type StagerPublicity = {
  eventId: number;
  name: string;
  defaultContactLocale: string;
  eventInfoTranslations: { locale: string; textHtml: string }[];
  startsAt: string;
  endsAt: string | null;
  imageUrl: string | null;
};

type StagerTicketsOverview = {
  ticketGroups: {
    ticketGroupId: number;
    name: string;
    priceInCents: number;
    feeInCents: number;
    soldOut: boolean;
    ticketsLeft: number;
  }[];
};

async function getJwt(host: string, shopId: number): Promise<string> {
  // De session POST vereist een `?shopId=...` query-param. Zonder krijg
  // je een default-shop in de JWT (bv. nachbar gaf shop=5088 i.p.v. de
  // gewenste 5352), waarna de events-listing leeg terugkomt.
  const r = await fetch(`https://${host}/shop/v1/session/new?shopId=${shopId}&locale=EN&hasOrderToken=false`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': UA,
      accept: 'application/json',
    },
    body: '{}',
  });
  if (!r.ok) throw new Error(`session/new ${host} → ${r.status}`);
  const j = (await r.json()) as { accessToken: { jwt: string } };
  return j.accessToken.jwt;
}

async function getJson<T>(url: string, jwt: string): Promise<T> {
  const r = await fetch(url, {
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: 'application/json',
      'user-agent': UA,
    },
  });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return (await r.json()) as T;
}

/** Mirror een externe image-URL naar Bunny CDN. Deterministisch pad op
 *  basis van Stager's shopId+eventId zodat her-runs dezelfde public-URL
 *  opleveren. Bij failure (onbereikbare bron, te groot, geen image)
 *  retourneert null — caller valt dan terug op de externe URL. */
async function mirrorImageToBunny(
  sourceUrl: string,
  shopId: number,
  stagerEventId: number
): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl);
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 8 * 1024 * 1024) return null;
    const ext = mime.includes('png')
      ? 'png'
      : mime.includes('webp')
        ? 'webp'
        : mime.includes('gif')
          ? 'gif'
          : mime.includes('avif')
            ? 'avif'
            : 'jpg';
    const path = `media/events/stager-${shopId}-${stagerEventId}.${ext}`;
    return await uploadToBunny(path, buf, mime);
  } catch (e) {
    console.warn(
      `[stager] mirror image ${sourceUrl} failed: ${(e as Error).message}`
    );
    return null;
  }
}

/** Light HTML-strip naar plain text. Stager events.publicity bewaart
 *  HTML in `textHtml`; we slaan plain text op zodat mobile-rendering
 *  geen onveilige HTML hoeft te interpreteren. */
function htmlToText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Eerste niet-uitverkochte tier; bij algehele sold-out de hoogste tier
 *  (zodat de "regular" prijs zichtbaar blijft). Fees worden bij de
 *  prijs opgeteld — wat de bezoeker daadwerkelijk afrekent. */
function pickPrice(tix: StagerTicketsOverview): {
  cents: number | null;
  tierName: string | null;
} {
  const groups = tix.ticketGroups ?? [];
  if (groups.length === 0) return { cents: null, tierName: null };
  const available = groups.find((g) => !g.soldOut);
  const target = available ?? groups[groups.length - 1];
  return {
    cents: target.priceInCents + (target.feeInCents ?? 0),
    tierName: target.name,
  };
}

export type StagerVenueResult = {
  venueId: string;
  venueName: string;
  shopId: number;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

async function scrapeOneVenue(
  venue: typeof schema.venues.$inferSelect,
  cfg: StagerConfig
): Promise<StagerVenueResult> {
  const result: StagerVenueResult = {
    venueId: venue.id,
    venueName: venue.name,
    shopId: cfg.shopId,
    fetched: 0,
    inserted: 0,
    occurrencesUpserted: 0,
    skipped: 0,
    errors: [],
  };

  let jwt: string;
  try {
    jwt = await getJwt(cfg.host, cfg.shopId);
  } catch (e) {
    result.errors.push(`session: ${(e as Error).message}`);
    return result;
  }

  // Stager's events-endpoint geeft default 10 events terug en kapt de
  // limit hard af op 20 — alles erboven returnt vreemde response (1
  // item). Pagineer met limit=20 en oplopende offset tot we minder
  // dan 20 of 0 events terugkrijgen.
  const PAGE_SIZE = 20;
  let events: StagerEvent[] = [];
  try {
    let offset = 0;
    while (true) {
      const page = await getJson<StagerEvent[]>(
        `https://${cfg.host}/shop/v1/events?offset=${offset}&limit=${PAGE_SIZE}`,
        jwt
      );
      events.push(...page);
      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
      if (offset > 500) break; // safety brake
    }
  } catch (e) {
    result.errors.push(`events-list: ${(e as Error).message}`);
    return result;
  }
  result.fetched = events.length;

  // Pak categorie van de venue (bv. Radion → "Muziek"). Veel venues
  // hebben er meerdere; we kiezen de eerste — de admin kan 'm later
  // overrulen.
  const venueCategory = venue.categories?.[0] ?? 'Muziek';

  // Filter voorbije events weg — Stager geeft historie ook terug.
  // Cutoff = nu, niet startsAt zelf, want late-night clubs lopen na
  // middernacht door en moeten op hun avond nog zichtbaar zijn.
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  const upcoming = events.filter(
    (e) => new Date(e.endsOn ?? e.startsOn).getTime() > cutoff
  );

  // Mediamatic-enrich: hun Stager-publicity is leeg — content + image
  // staan op mediamatic.net. Map stagerEventId → MediamaticContent.
  // Levert ook de groep-sleutel (sourceUrl) zodat recurring workshops
  // (6× "Distilling a Citrus Bouquet") als 1 event met N occurrences
  // worden opgeslagen.
  let mediamaticContent: Map<number, MediamaticContent> | null = null;
  if (venue.slug === 'mediamatic') {
    try {
      mediamaticContent = await fetchMediamaticContent();
      console.log(
        `[stager] mediamatic enrich: ${mediamaticContent.size} events linked`
      );
    } catch (e) {
      result.errors.push(`mediamatic-enrich: ${(e as Error).message}`);
    }
  }

  // Groepeer events. Voor mediamatic: per genormaliseerde titel —
  // recurring workshops ("Distilling a Citrus Bouquet" 6×) krijgen
  // elke instance een eigen Stager-eventId én een eigen Mediamatic-
  // detail-pagina, dus URL-grouping helpt niet. Titel-grouping wel.
  // Andere Stager venues krijgen geen grouping (1 event per groep) —
  // die hebben geen recurring-pattern in hun feed.
  const groups = new Map<string, StagerEvent[]>();
  for (const ev of upcoming) {
    const key =
      venue.slug === 'mediamatic'
        ? `title:${ev.name.trim().toLowerCase()}`
        : `eid:${ev.eventId}`;
    const arr = groups.get(key) ?? [];
    arr.push(ev);
    groups.set(key, arr);
  }
  const isGrouped = venue.slug === 'mediamatic';

  for (const [groupKey, instances] of groups) {
    instances.sort(
      (a, b) =>
        new Date(a.startsOn).getTime() - new Date(b.startsOn).getTime()
    );
    const first = instances[0];

    try {
      const eventId = isGrouped
        ? `evt-stg-${cfg.shopId}-${shortHash(groupKey)}`
        : `evt-stg-${cfg.shopId}-${first.eventId}`;

      // Vroege existing-check: spaart publicity-fetch + Claude voor
      // bestaande events. Tix-fetch per instance blijft (prijs kan
      // wijzigen) en occurrence-upsert ook.
      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      if (existing) {
        // Alleen occurrences syncen — sold-out, prijs en tijd kunnen
        // wijzigen tussen runs.
        for (const inst of instances) {
          let cents: number | null = null;
          try {
            const tix = await getJson<StagerTicketsOverview>(
              `https://${cfg.host}/shop/v1/events/${inst.eventId}/tickets-overview`,
              jwt
            );
            cents = pickPrice(tix).cents;
          } catch {
            // tix-call kan falen bij gratis events; cents blijft null
          }
          const occurrenceId = isGrouped
            ? `occ-stg-${cfg.shopId}-${shortHash(`${groupKey}|${inst.startsOn}`)}`
            : `occ-stg-${cfg.shopId}-${inst.eventId}`;
          const instTicketUrl = `https://${cfg.host}/shop/${cfg.shopHandle ?? 'default'}/events/${inst.eventId}`;
          const instStatus: 'scheduled' | 'cancelled' | 'sold_out' =
            inst.soldOut ? 'sold_out' : 'scheduled';
          await db
            .insert(schema.occurrences)
            .values({
              id: occurrenceId,
              eventId,
              startsAt: new Date(inst.startsOn),
              endsAt: new Date(inst.endsOn),
              priceCents: cents,
              priceNote: null,
              ticketUrl: instTicketUrl,
              room: null,
              lineup: null,
              status: instStatus,
            })
            .onConflictDoUpdate({
              target: schema.occurrences.id,
              set: {
                startsAt: new Date(inst.startsOn),
                endsAt: new Date(inst.endsOn),
                priceCents: cents,
                ticketUrl: instTicketUrl,
                status: instStatus,
              },
            });
          result.occurrencesUpserted++;
        }
        continue;
      }

      // Nieuw event — publicity-fetch + Claude + image-mirror.
      const pub = await getJson<StagerPublicity>(
        `https://${cfg.host}/shop/v1/events/${first.eventId}/publicity`,
        jwt
      );

      const content = mediamaticContent?.get(first.eventId);

      const dutch =
        pub.eventInfoTranslations.find((t) => t.locale === 'NL') ??
        pub.eventInfoTranslations[0];
      const stagerDescription = dutch?.textHtml
        ? htmlToText(dutch.textHtml)
        : null;
      const rawDescription = content?.description ?? stagerDescription;
      const sourceImageUrl = content?.imageUrl ?? pub.imageUrl;
      const title = content?.title?.trim() || pub.name || first.name;

      const enriched = await enrichEvent({
        title,
        description: rawDescription,
        venueName: venue.name,
        venueCategory,
      });

      let imageUrl: string | null = null;
      if (sourceImageUrl) {
        imageUrl =
          (await mirrorImageToBunny(
            sourceImageUrl,
            cfg.shopId,
            first.eventId
          )) ?? sourceImageUrl;
      }

      const firstStart = new Date(first.startsOn);
      const firstEnd = first.endsOn ? new Date(first.endsOn) : null;
      const refinedKind = refineKindByDuration(enriched.kind, firstStart, firstEnd);

      await db.transaction(async (tx) => {
        await tx.insert(schema.events).values({
          id: eventId,
          venueId: venue.id,
          title,
          description: enriched.cleanedDescription ?? rawDescription,
          kind: refinedKind,
          imageUrl,
          category: enriched.category ?? venueCategory,
          featured: false,
          genres: enriched.genres,
          published: true,
        });
        result.inserted++;

        for (const inst of instances) {
          let cents: number | null = null;
          try {
            const tix = await getJson<StagerTicketsOverview>(
              `https://${cfg.host}/shop/v1/events/${inst.eventId}/tickets-overview`,
              jwt
            );
            cents = pickPrice(tix).cents;
          } catch {
            // tix-call kan falen bij gratis events / waitlist; cents blijft null
          }

          const occurrenceId = isGrouped
            ? `occ-stg-${cfg.shopId}-${shortHash(`${groupKey}|${inst.startsOn}`)}`
            : `occ-stg-${cfg.shopId}-${inst.eventId}`;
          const instTicketUrl = `https://${cfg.host}/shop/${cfg.shopHandle ?? 'default'}/events/${inst.eventId}`;
          const instStatus: 'scheduled' | 'cancelled' | 'sold_out' =
            inst.soldOut ? 'sold_out' : 'scheduled';

          await tx
            .insert(schema.occurrences)
            .values({
              id: occurrenceId,
              eventId,
              startsAt: new Date(inst.startsOn),
              endsAt: new Date(inst.endsOn),
              priceCents: cents,
              priceNote: enriched.priceNote,
              ticketUrl: instTicketUrl,
              room: enriched.room,
              lineup: enriched.lineup,
              status: instStatus,
            })
            .onConflictDoUpdate({
              target: schema.occurrences.id,
              set: {
                startsAt: new Date(inst.startsOn),
                endsAt: new Date(inst.endsOn),
                priceCents: cents,
                priceNote: enriched.priceNote,
                ticketUrl: instTicketUrl,
                room: enriched.room,
                lineup: enriched.lineup,
                status: instStatus,
              },
            });
          result.occurrencesUpserted++;
        }
      });
    } catch (e) {
      result.errors.push(`group ${groupKey}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return result;
}

/** Run de scraper voor alle venues met een Stager-config. */
export async function scrapeStager(options?: {
  venueIds?: string[];
}): Promise<StagerVenueResult[]> {
  const all = await db.select().from(schema.venues);
  const targets = all.filter((v) => {
    const cfg = v.scraperConfig?.stager;
    if (!cfg?.host || !cfg.shopId) return false;
    if (options?.venueIds && !options.venueIds.includes(v.id)) return false;
    return true;
  });

  const results: StagerVenueResult[] = [];
  for (const v of targets) {
    const cfg = v.scraperConfig!.stager!;
    results.push(await scrapeOneVenue(v, cfg));
  }
  return results;
}
