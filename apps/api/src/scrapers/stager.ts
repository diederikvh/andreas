import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent } from './enrich.js';

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

type StagerConfig = { host: string; shopId: number };

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

async function getJwt(host: string): Promise<string> {
  const r = await fetch(`https://${host}/shop/v1/session/new`, {
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
    jwt = await getJwt(cfg.host);
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

  for (const ev of upcoming) {
    try {
      const [pub, tix] = await Promise.all([
        getJson<StagerPublicity>(
          `https://${cfg.host}/shop/v1/events/${ev.eventId}/publicity`,
          jwt
        ),
        getJson<StagerTicketsOverview>(
          `https://${cfg.host}/shop/v1/events/${ev.eventId}/tickets-overview`,
          jwt
        ),
      ]);

      const eventId = `evt-stg-${cfg.shopId}-${ev.eventId}`;
      const occurrenceId = `occ-stg-${cfg.shopId}-${ev.eventId}`;
      const ticketUrl = `https://${cfg.host}/shop/default/events/${ev.eventId}`;
      const dutch =
        pub.eventInfoTranslations.find((t) => t.locale === 'NL') ??
        pub.eventInfoTranslations[0];
      const rawDescription = dutch?.textHtml ? htmlToText(dutch.textHtml) : null;
      const { cents } = pickPrice(tix);
      const startsAt = new Date(pub.startsAt);
      const endsAt = pub.endsAt ? new Date(pub.endsAt) : null;
      const status = ev.soldOut ? 'sold_out' : 'scheduled';

      // Claude-enrich: haalt lineup/genres/room/priceNote/kind uit de
      // description-tekst. Strict prompt — bij twijfel laat 'ie velden
      // null. Bij API-fout valt 'ie terug op een lege EnrichOutput
      // (description blijft behouden).
      const enriched = await enrichEvent({
        title: ev.name,
        description: rawDescription,
        venueName: venue.name,
        venueCategory,
      });

      // Image alleen bij eerste keer event zien naar Bunny mirroren —
      // her-runs hergebruiken dezelfde CDN-URL. Spaart bandwidth en
      // houdt onze CDN-cache stabiel.
      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      let imageUrl: string | null = null;
      if (!existing && pub.imageUrl) {
        imageUrl =
          (await mirrorImageToBunny(pub.imageUrl, cfg.shopId, ev.eventId)) ??
          pub.imageUrl;
      }

      await db.transaction(async (tx) => {
        if (!existing) {
          await tx.insert(schema.events).values({
            id: eventId,
            venueId: venue.id,
            title: ev.name,
            description: enriched.cleanedDescription ?? rawDescription,
            kind: enriched.kind,
            imageUrl,
            category: venueCategory,
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
            priceCents: cents,
            priceNote: enriched.priceNote,
            ticketUrl,
            room: enriched.room,
            lineup: enriched.lineup,
            status,
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: {
              startsAt,
              endsAt,
              priceCents: cents,
              priceNote: enriched.priceNote,
              ticketUrl,
              room: enriched.room,
              lineup: enriched.lineup,
              status,
            },
          });
        result.occurrencesUpserted++;
      });
    } catch (e) {
      result.errors.push(`event ${ev.eventId}: ${(e as Error).message}`);
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
