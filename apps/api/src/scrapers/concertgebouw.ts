import { and, asc, eq, gt, inArray } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';
import { loadVenueTitleMap, resolveEventId } from './_title-dedup.js';

/**
 * Het Concertgebouw — via hun eigen agenda-API in plaats van de sitemap.
 *
 * Waarom niet via theater.ts: de sitemap somt élk concert ooit op, 4460
 * URLs voor ~740 komende voorstellingen. Daartussen zitten alias-pagina's
 * die de JSON-LD van een ánder concert tonen en dode entries die 404'en.
 * En erger: van de pagina's die er wél horen heeft twee derde geen
 * JSON-LD (HTTP 200, consistent over herhaalde pogingen — de structured
 * data staat er simpelweg niet). Gemeten gevolg: 251 van de 743 komende
 * voorstellingen ontbraken in onze DB, waaronder gewone avondconcerten.
 *
 * De agenda op hun site gebruikt een Craft/Elasticsearch-GraphQL die
 * precies geeft wat we nodig hebben, in één request:
 *
 *   POST https://cms.concertgebouw.nl/api
 *   Authorization: Bearer <publiek token uit de agenda-pagina>
 *   elasticSearch(site:"nlDefault", section:"event",
 *                 eventEndDateRange:"gte <nu>", orderBy:"eventDate ASC")
 *     { count hits(limit:1024){ id url title subtitle eventDate } }
 *
 * Introspectie staat uit, dus dit schema is afgekeken van de requests die
 * hun agenda zelf doet. Gevulde velden op `hits`: id, uri, url, slug,
 * title, subtitle, eventDate, postDate. Description en beeld zitten er
 * niet in — die halen we per nieuw event van de show-pagina.
 *
 * Idempotency: dezelfde vorm als theater.ts gebruikte —
 * `evt-th-het-concertgebouw-{slug}` / `occ-th-…-{ISO-datum}`. Bewust
 * niet een eigen prefix: er staan al honderden events onder deze ids, en
 * een nieuw schema zou ze allemaal dubbelen.
 */

const API_URL = 'https://cms.concertgebouw.nl/api';
/** Publiek token uit hun agenda-pagina (`elasticsearchGraphqlPublicToken`) —
    dezelfde sleutel die de site zelf in de browser meestuurt. */
const API_TOKEN = 'SVNNqbdCSqwqNVTmFbXEPJbN6MC6axVi';
const API_SITE = 'nlDefault';
const VENUE_ID = 'het-concertgebouw';
const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const FETCH_TIMEOUT_MS = 20_000;
/** hits(limit:1024) is een harde cap aan hun kant. */
const HITS_LIMIT = 1024;

export type ConcertgebouwResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  occurrencesPruned: number;
  skipped: number;
  errors: string[];
};

type ApiHit = {
  id?: number;
  url?: string;
  title?: string;
  subtitle?: string | null;
  eventDate?: string;
};

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
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

const stripTags = (s: string) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

async function fetchHits(): Promise<{ hits: ApiHit[]; count: number } | { error: string }> {
  const query =
    'query($site:[String],$d:[String]){ elasticSearch(site:$site, section:"event", ' +
    `eventEndDateRange:$d, orderBy:"eventDate ASC"){ count hits(limit:${HITS_LIMIT})` +
    '{ id url title subtitle eventDate } } }';
  try {
    const r = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({
        query,
        variables: { site: API_SITE, d: `gte ${new Date().toISOString()}` },
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) return { error: `API HTTP ${r.status}` };
    const j = (await r.json()) as {
      data?: { elasticSearch?: { count?: number; hits?: ApiHit[] } };
      errors?: unknown;
    };
    const hits = j.data?.elasticSearch?.hits ?? [];
    if (!hits.length) {
      return { error: `API leeg${j.errors ? `: ${JSON.stringify(j.errors).slice(0, 200)}` : ''}` };
    }
    return { hits, count: j.data?.elasticSearch?.count ?? hits.length };
  } catch (e) {
    return { error: `API: ${(e as Error).message}` };
  }
}

/** Description + beeld van de show-pagina. Alleen nodig bij een nieuw
    event; de API heeft ze niet. Twee derde van de pagina's heeft geen
    JSON-LD, dus og:-tags als terugval. */
async function fetchPageDetails(
  url: string
): Promise<{ description: string | null; imageUrl: string | null }> {
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) return { description: null, imageUrl: null };
    const html = await r.text();

    let description: string | null = null;
    let imageUrl: string | null = null;
    for (const m of html.matchAll(
      /<script[^>]*application\/ld\+json[^>]*>([\s\S]+?)<\/script>/g
    )) {
      try {
        const d = JSON.parse(m[1].trim()) as unknown;
        const items = Array.isArray(d)
          ? d
          : (d as Record<string, unknown>)?.['@graph']
            ? ((d as Record<string, unknown>)['@graph'] as unknown[])
            : [d];
        for (const x of items) {
          const node = x as Record<string, unknown>;
          if (!node || !/Event/i.test(String(node['@type']))) continue;
          if (!description && typeof node.description === 'string') {
            description = decodeEntities(stripTags(node.description)).slice(0, 2000) || null;
          }
          if (!imageUrl) {
            const img = node.image;
            if (typeof img === 'string') imageUrl = img;
            else if (Array.isArray(img) && typeof img[0] === 'string') imageUrl = img[0];
          }
        }
      } catch {
        continue;
      }
    }
    const og = (prop: string) =>
      html.match(new RegExp(`<meta[^>]+property=["']og:${prop}["'][^>]+content=["']([^"']+)`, 'i'))?.[1] ??
      null;
    if (!description) {
      const d = og('description');
      description = d ? decodeEntities(stripTags(d)).slice(0, 2000) || null : null;
    }
    if (!imageUrl) imageUrl = og('image');
    return { description, imageUrl };
  } catch {
    return { description: null, imageUrl: null };
  }
}

async function mirrorImage(sourceUrl: string, slug: string): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, {
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 8 * 1024 * 1024) return null;
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    return await uploadToBunny(`media/events/cg-${slug}.${ext}`, buf, mime);
  } catch {
    return null;
  }
}

export async function scrapeConcertgebouw(options?: {
  venueIds?: string[];
}): Promise<ConcertgebouwResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: ConcertgebouwResult = {
    venueId: VENUE_ID,
    fetched: 0,
    inserted: 0,
    occurrencesUpserted: 0,
    occurrencesPruned: 0,
    skipped: 0,
    errors: [],
  };

  const [venue] = await db
    .select()
    .from(schema.venues)
    .where(eq(schema.venues.id, VENUE_ID));
  if (!venue) {
    result.errors.push(`venue ${VENUE_ID} bestaat niet`);
    return [result];
  }

  const res = await fetchHits();
  if ('error' in res) {
    result.errors.push(res.error);
    return [result];
  }
  // Niet stil afkappen als hun limiet bereikt is.
  if (res.count > res.hits.length) {
    result.errors.push(`${res.hits.length} van ${res.count} hits (limit ${HITS_LIMIT})`);
  }

  // Eén pagina kan meerdere voorstellingen huisvesten (591 urls voor 743
  // hits), dus groeperen op url: dat is één show met N datums.
  const byUrl = new Map<string, { title: string; subtitle: string | null; dates: Date[] }>();
  for (const h of res.hits) {
    if (!h.url || !h.title || !h.eventDate) {
      result.skipped++;
      continue;
    }
    const d = new Date(h.eventDate);
    if (isNaN(d.getTime())) {
      result.skipped++;
      continue;
    }
    const cur = byUrl.get(h.url);
    if (cur) cur.dates.push(d);
    else byUrl.set(h.url, { title: h.title.trim(), subtitle: h.subtitle ?? null, dates: [d] });
  }
  result.fetched = byUrl.size;
  console.log(
    `[concertgebouw] ${res.hits.length} voorstellingen op ${byUrl.size} pagina's via de agenda-API`
  );

  const byTitle = await loadVenueTitleMap(VENUE_ID, 'evt-th-');
  const venueCategory = venue.categories?.[0] ?? 'Muziek';
  /** Per event welke occurrence-ids de bron deze run opsomde — input voor
      de prune onderaan. */
  const seenOcc = new Map<string, Set<string>>();
  /** Per event per dag hoeveel voorstellingen we al hebben gezien. Moet op
      run-niveau: twee pagina's met dezelfde titel worden door de
      titel-dedup één event, en met een teller per pagina botsten hun
      occurrence-ids alsnog. */
  const perDayByEvent = new Map<string, Map<string, number>>();

  for (const [url, show] of [...byUrl].sort((a, b) => a[0].localeCompare(b[0]))) {
    try {
      show.dates.sort((a, b) => a.getTime() - b.getTime());
      const lastSegment = url.replace(/\/$/, '').split('/').pop() ?? '';
      // Het numerieke prefix is per voorstelling, niet per show — strippen,
      // anders wordt elke avond een eigen event.
      const slug = slugify(lastSegment.replace(/^\d+-/, ''));
      if (!slug) {
        result.skipped++;
        continue;
      }

      // Subtitle als description-signaal: de enige tekst die de API geeft.
      const { eventId } = resolveEventId(byTitle, show.title, `evt-th-${VENUE_ID}-${slug}`, {
        startsAt: show.dates[0],
        description: show.subtitle,
      });

      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;

      if (!existing) {
        // Alleen voor nieuwe events de pagina ophalen — dat is het enige
        // waarvoor we hem nog nodig hebben.
        const details = await fetchPageDetails(url);
        const description = details.description ?? show.subtitle;
        let imageUrl: string | null = null;
        if (details.imageUrl) {
          imageUrl = (await mirrorImage(details.imageUrl, slug)) ?? details.imageUrl;
        }
        try {
          enriched = await enrichEvent({
            title: show.title,
            description,
            venueName: venue.name,
            venueCategory,
          });
        } catch (e) {
          result.errors.push(`enrich ${show.title}: ${(e as Error).message}`);
        }
        const kind = refineKindByDuration(enriched?.kind ?? 'show', show.dates[0], null);
        try {
          await db.insert(schema.events).values({
            id: eventId,
            venueId: VENUE_ID,
            title: show.title,
            description: enriched?.cleanedDescription ?? description,
            kind,
            imageUrl,
            category: enriched?.category ?? venueCategory,
            featured: false,
            genres: enriched?.genres ?? [],
            published: true,
          });
          result.inserted++;
        } catch (e) {
          result.errors.push(`insert ${eventId}: ${(e as Error).message}`);
          continue;
        }
      }

      // Occurrence-ids: afgeleid van het opgeloste eventId, zoals
      // theater.ts deed. Maar één show kan meerdere voorstellingen op
      // dezelfde dag hebben — de babyconcerten draaien 09:30, 10:30 en
      // 11:30 — en met alleen de datum in de id overschrijven die elkaar.
      // Dat kostte 127 van de 743 voorstellingen.
      //
      // De eerste van een dag houdt de datum-only id, zodat de honderden
      // bestaande occurrences hun id houden; de volgende krijgen er de
      // tijd bij. Datums zijn gesorteerd, dus dat is stabiel tussen runs.
      const perDay = perDayByEvent.get(eventId) ?? new Map<string, number>();
      perDayByEvent.set(eventId, perDay);
      for (const startsAt of show.dates) {
        const isoDate = startsAt.toISOString().slice(0, 10);
        const n = perDay.get(isoDate) ?? 0;
        perDay.set(isoDate, n + 1);
        const suffix = n === 0
          ? isoDate
          : `${isoDate}-${startsAt.toISOString().slice(11, 16).replace(':', '')}`;
        const occurrenceId = `${eventId.replace(/^evt-th-/, 'occ-th-')}-${suffix}`;
        try {
          await db
            .insert(schema.occurrences)
            .values({
              id: occurrenceId,
              eventId,
              // venueId expliciet: theater.ts liet dit veld leeg, waardoor
              // queries die per venue op occurrences filteren niets vonden.
              venueId: VENUE_ID,
              startsAt,
              endsAt: null,
              priceCents: null,
              priceNote: existing ? null : (enriched?.priceNote ?? null),
              ticketUrl: url,
              room: existing ? null : (enriched?.room ?? null),
              lineup: existing ? null : (enriched?.lineup ?? null),
              status: 'scheduled',
            })
            .onConflictDoUpdate({
              target: schema.occurrences.id,
              set: { eventId, venueId: VENUE_ID, startsAt, ticketUrl: url },
            });
          result.occurrencesUpserted++;
          const seen = seenOcc.get(eventId) ?? new Set<string>();
          seen.add(occurrenceId);
          seenOcc.set(eventId, seen);
        } catch (e) {
          result.errors.push(`occurrence ${occurrenceId}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      result.errors.push(`show ${url}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  // Prune, met dezelfde klemmen als theater.ts: alleen events die deze run
  // een bevestigde datum hadden, en occurrences met een save blijven staan.
  const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000);
  for (const [eventId, keep] of seenOcc) {
    try {
      const rows = await db
        .select({ id: schema.occurrences.id })
        .from(schema.occurrences)
        .where(
          and(eq(schema.occurrences.eventId, eventId), gt(schema.occurrences.startsAt, cutoff))
        )
        .orderBy(asc(schema.occurrences.id));
      const drop = rows.map((r) => r.id).filter((id) => !keep.has(id));
      if (!drop.length) continue;
      const saved = await db
        .select({ occurrenceId: schema.saves.occurrenceId })
        .from(schema.saves)
        .where(inArray(schema.saves.occurrenceId, drop));
      const savedIds = new Set(saved.map((s) => s.occurrenceId));
      const finalDrop = drop.filter((id) => !savedIds.has(id));
      if (!finalDrop.length) continue;
      await db.delete(schema.occurrences).where(inArray(schema.occurrences.id, finalDrop));
      result.occurrencesPruned += finalDrop.length;
    } catch (e) {
      result.errors.push(`prune ${eventId}: ${(e as Error).message}`);
    }
  }

  // Venue-brede sweep, bovenop de prune hierboven. De API geeft de
  // complete komende programmering (count == hits, geen limiet geraakt),
  // dus een toekomstige occurrence die daar niet in staat is verlopen —
  // ook als 'ie aan een event hangt dat we deze run niet zagen. Dat zijn
  // de restanten van de alias-pagina's uit de sitemap-tijd: concerten die
  // Concertgebouw niet meer aanbiedt maar die wij nog toonden.
  //
  // Alleen als de lijst compleet is: bij een geraakte hits-limiet weten
  // we niet wat er mist en zou dit goede rijen weggooien.
  if (res.count === res.hits.length) {
    try {
      // Op occurrence-id vergelijken, niet op moment: met 743 concerten
      // over ~400 dagen staat bijna alles om 20:00, dus een moment-set
      // matcht ook verlopen rijen en dan ruimt de sweep niets op. De ids
      // die we deze run schreven zijn de exacte maatstaf.
      const wanted = new Set<string>();
      for (const ids of seenOcc.values()) for (const id of ids) wanted.add(id);
      const ourEvents = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.venueId, VENUE_ID));
      const rows = ourEvents.length
        ? await db
            .select({ id: schema.occurrences.id, startsAt: schema.occurrences.startsAt })
            .from(schema.occurrences)
            .where(
              and(
                inArray(schema.occurrences.eventId, ourEvents.map((e) => e.id)),
                gt(schema.occurrences.startsAt, cutoff)
              )
            )
        : [];
      const orphaned = rows.filter((r) => !wanted.has(r.id)).map((r) => r.id);
      if (orphaned.length) {
        const saved = await db
          .select({ occurrenceId: schema.saves.occurrenceId })
          .from(schema.saves)
          .where(inArray(schema.saves.occurrenceId, orphaned));
        const savedIds = new Set(saved.map((x) => x.occurrenceId));
        const drop = orphaned.filter((id) => !savedIds.has(id));
        if (drop.length) {
          await db.delete(schema.occurrences).where(inArray(schema.occurrences.id, drop));
          result.occurrencesPruned += drop.length;
          console.log(
            `[concertgebouw] ${drop.length} verlopen toekomstige occurrences opgeruimd ` +
              `(niet meer in de programmering)`
          );
        }
      }
    } catch (e) {
      result.errors.push(`sweep: ${(e as Error).message}`);
    }
  }

  console.log(
    `[concertgebouw] done — shows=${result.fetched} inserted=${result.inserted} ` +
      `occ=${result.occurrencesUpserted} pruned=${result.occurrencesPruned} ` +
      `skipped=${result.skipped} errors=${result.errors.length}`
  );
  return [result];
}
