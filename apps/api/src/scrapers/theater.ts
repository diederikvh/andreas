import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { parseAmsterdamLocal, parseIsoFlexible } from './_amsterdam-tz.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';
import { loadVenueTitleMap, resolveEventId } from './_title-dedup.js';

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
 *  - eventId       = `evt-th-{venueId}-{showSlug}`, tenzij deze venue al
 *    een `evt-th-`-event met dezelfde genormaliseerde titel heeft — dan
 *    wint dat event. De bron-slug is muteerbaar (typo-correcties) en
 *    niet uniek per voorstelling (alias-URLs), de titel is stabieler.
 *  - occurrenceId  = `occ-th-{venueId}-{showSlug}-{ISO-date}`, afgeleid
 *    van het opgeloste eventId zodat alias-URLs geen dubbele
 *    occurrences op dezelfde dag maken.
 */

const UA_BOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const UA_REG = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';

// Concurrency voor de show-URL loop per venue. Concertgebouw heeft
// ~4000 /concerten/-pagina's; sequentieel × ~200ms/fetch = >13 min
// per venue, wat in productie de curl-timeout van 25 min vol vrat.
// Met 8 parallel zakt dat naar ~1-2 min. Een venue-server overrompelen
// we niet — 8 concurrent is standaard browser-niveau.
const SHOW_FETCH_CONCURRENCY = 8;

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const idx = next++;
      await fn(items[idx]);
    }
  }
  const n = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
}

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

// Per-fetch timeout zodat één hangende venue niet de hele
// theater-scraper-run blokkeert (curl-side timeout was 540s; we
// gaven die op met >20 venues × meerdere URLs). 30s is ruim voor
// een gezonde response, maar kort genoeg om een hang snel op te
// geven en door te gaan met de volgende URL.
//
// BELANGRIJK: AbortController moet de hele request inclusief
// body-stream lezen afdekken. Een naïeve wrapper die alleen
// `fetch()` (= connect + headers) wraps laat `r.text()` /
// `r.arrayBuffer()` oneindig hangen op slow-loris servers.
// Dat was de oorzaak van de "0 bytes in 25 min" prod-hang.
const FETCH_TIMEOUT_MS = 30_000;

async function fetchTextWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<string | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => {
    console.warn(`[theater] fetch timeout (${timeoutMs}ms) ${url}`);
    ctl.abort();
  }, timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBytesWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<{ buf: ArrayBuffer; mime: string } | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => {
    console.warn(`[theater] image-fetch timeout (${timeoutMs}ms) ${url}`);
    ctl.abort();
  }, timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    const buf = await r.arrayBuffer();
    return { buf, mime };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHtml(url: string, useBot: boolean): Promise<string | null> {
  return fetchTextWithTimeout(url, {
    headers: { 'user-agent': useBot ? UA_BOT : UA_REG },
  });
}

type SitemapEntry = { loc: string; lastmod: Date | null };

// Sub-sitemaps en show-URLs met een `<lastmod>` ouder dan dit window
// slaan we over: een pagina die in >12 maanden niet is aangeraakt is
// vrijwel zeker een historische show. Conservatief gekozen want
// theaters publiceren seizoens-programma's tot ~9 maanden vooruit;
// 365 dagen vangt 2023/2024-historie van Concertgebouw zonder
// risico op missen van de huidige programmering.
const SITEMAP_STALE_MS = 365 * 24 * 60 * 60 * 1000;

async function fetchSitemap(url: string, depth = 0): Promise<SitemapEntry[]> {
  if (depth > 3) return [];
  const xml = await fetchTextWithTimeout(url, {
    headers: { 'user-agent': UA_REG },
  });
  if (!xml) return [];
  const isIndex = /<sitemapindex\b/.test(xml);

  const entries: SitemapEntry[] = [];
  const blockRe = isIndex
    ? /<sitemap[\s>][\s\S]*?<\/sitemap>/g
    : /<url[\s>][\s\S]*?<\/url>/g;
  for (const m of xml.matchAll(blockRe)) {
    const locM = m[0].match(/<loc>\s*([^<\s]+)\s*<\/loc>/);
    if (!locM) continue;
    const lastmodM = m[0].match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/);
    const lm = lastmodM ? new Date(lastmodM[1]) : null;
    entries.push({
      loc: locM[1],
      lastmod: lm && !isNaN(lm.getTime()) ? lm : null,
    });
  }
  if (!isIndex) return entries;

  // Sitemap-index: recursive volgens alle sub-sitemaps. Concertgebouw,
  // Bimhuis e.d. splitsen hun sitemap in `sitemap_sections_*.xml` of
  // `event-sitemap{N}.xml`. Skip sub-sitemaps die >365 dagen niet
  // gewijzigd zijn — die bevatten alleen oude programma's.
  const cutoff = Date.now() - SITEMAP_STALE_MS;
  const all: SitemapEntry[] = [];
  for (const sub of entries) {
    if (sub.lastmod && sub.lastmod.getTime() < cutoff) continue;
    const subEntries = await fetchSitemap(sub.loc, depth + 1);
    all.push(...subEntries);
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

/** Detecteer of een DeLaMar voorstelling als "Afgelopen" gemarkeerd is.
 *  De page rendert dan een `<div class="genre genre--large">Afgelopen</div>`
 *  badge en de tekst "Deze voorstelling is afgelopen". Voor zulke shows
 *  laten we het event verwijderen i.p.v. te laten staan zonder occurrences. */
function isAfgelopen(html: string): boolean {
  return /class="genre genre--large">\s*Afgelopen\s*</i.test(html)
    || /Deze voorstelling is afgelopen/i.test(html);
}

async function mirrorImage(sourceUrl: string, slug: string): Promise<string | null> {
  const r = await fetchBytesWithTimeout(sourceUrl, { headers: { 'user-agent': UA_REG } });
  if (!r) return null;
  if (!r.mime.startsWith('image/')) return null;
  if (r.buf.byteLength > 8 * 1024 * 1024) return null;
  const ext = r.mime.includes('png') ? 'png' : r.mime.includes('webp') ? 'webp' : 'jpg';
  try {
    return await uploadToBunny(`media/events/th-${slug}.${ext}`, r.buf, r.mime);
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
    const venueStart = Date.now();
    console.log(`[theater] start ${venue.slug} (${cfg.sitemapUrl})`);
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

    // Titel-map voor deze venue. De slug-gebaseerde id alleen is niet
    // genoeg: Frascati publiceert per show twee sitemap-URLs (titel +
    // tagline) en corrigeerde een typo in een slug, Bijlmer wisselt het
    // suffix, Meervaart heeft twee URLs per voorstelling. De titel is
    // in al die gevallen wél identiek. Zie _title-dedup.ts.
    const byTitle = await loadVenueTitleMap(venue.id, 'evt-th-');

    const allEntries = await fetchSitemap(cfg.sitemapUrl);
    const urlCutoff = Date.now() - SITEMAP_STALE_MS;
    const matching = allEntries.filter((e) => {
      if (!showRe.test(e.loc)) return false;
      // Show-URL met lastmod ouder dan window = vrijwel zeker
      // historisch. Geen lastmod = doorgaan (oude scrapers leveren
      // er geen, en we willen niet per ongeluk alles overslaan).
      if (e.lastmod && e.lastmod.getTime() < urlCutoff) return false;
      return true;
    });
    const showUrls = Array.from(new Set(matching.map((e) => e.loc)));
    result.fetched = showUrls.length;

    // Concertgebouw levert hier ~4460 URLs waarvan er per run maar ~400
    // een toekomstige datum blijken te hebben; de rest halen we op en
    // gooien we weg. Dat is de duurste post in deze scraper (~6 min) en
    // het was de directe aanleiding voor de OOM op de 512mb VM.
    //
    // Geprobeerd op 2026-08-23: nieuwste-eerst crawlen op de numerieke
    // id in de slug (die loopt op in de tijd) en stoppen zodra het droog
    // wordt. Werkte qua winst — 4460 → 2000 URLs, 353s → 118s — maar
    // NIET qua dekking. De toekomstige occurrences liggen zo:
    //
    //     positie    0- 399 : 311        positie 2000-2399 : 4
    //     positie  400- 799 : 232        positie 2400-2799 : 6
    //     positie  800-1199 :  12        positie 2800-3199 : 5
    //     positie 1200-1599 :  11        positie 3200-3599 : 4
    //     positie 1600-1999 :   9        positie 4000-4399 : 9
    //
    // 88% zit in de bovenste 800, maar de staart loopt dun dóór tot het
    // einde: stoppen bij 2000 kostte ~32 komende concerten. En een
    // ruimere marge helpt niet — die staart reset de dry-teller telkens,
    // dus dan crawl je alsnog alles. Er is geen veilig stoppunt.
    //
    // Wat wél kan, als dit weer gaat knellen: de bovenste ~800 elke dag
    // en de staart één vaste weekdag. Max 7 dagen vertraging op ~70
    // occurrences, en 80% minder fetches per nacht.

    // Head-vandaag / staart-wekelijks. Zie de meting in het comment
    // hierboven: stoppen-zodra-droog kan niet, maar de staart bestaat
    // vrijwel alleen uit oude pagina's waarvan de datums niet meer
    // wijzigen. Een nieuw aangekondigd concert krijgt juist een hoge id
    // en zit dus altijd in de head.
    let toCrawl = showUrls;
    if (cfg.headUrls && cfg.tailWeekday !== undefined && showUrls.length > cfg.headUrls) {
      const idOf = (u: string) =>
        Number(u.split('/').pop()?.match(/^(\d+)/)?.[1] ?? 0);
      const ordered = [...showUrls].sort((a, b) => idOf(b) - idOf(a));
      // Weekdag in Amsterdamse tijd, niet UTC: de cron staat op 02:00
      // UTC en dat is hier al de volgende ochtend.
      const weekday = new Date(
        new Date().toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' })
      ).getDay();
      const fullSweep = weekday === cfg.tailWeekday;
      toCrawl = fullSweep ? ordered : ordered.slice(0, cfg.headUrls);
      // Niet stil afkappen: elke run zegt wat hij overslaat.
      console.log(
        `[theater] ${venue.id}: ${fullSweep ? 'volledige sweep' : `head-only, ${toCrawl.length} van ${ordered.length}`}` +
          ` (weekdag ${weekday}, staart op ${cfg.tailWeekday})`
      );
      result.fetched = toCrawl.length;
    }

    await runWithConcurrency(toCrawl, SHOW_FETCH_CONCURRENCY, async (url) => {
      try {
        const html = await fetchHtml(url, !!cfg.useGooglebotUA);
        if (!html) { result.skipped++; return; }

        // Skip non-NL pagina's. Concertgebouw (en mogelijk andere
        // venues) exposeert dezelfde voorstelling op zowel
        // `/concerten/<nl-slug>` als `/concerten/<en-slug>` — beide
        // passen het URL-pattern, dus we filteren hier op
        // `<html lang>`. Geen lang-attribuut? Doorgaan (default).
        const langMatch = html.match(/<html[^>]*\slang=["']([^"']+)["']/i);
        const lang = langMatch ? langMatch[1].toLowerCase() : null;
        if (lang && !lang.startsWith('nl')) { result.skipped++; return; }

        const evs = extractEvents(html);
        if (evs.length === 0) { result.skipped++; return; }

        // Title komt uit het eerste Event blok. Slug uit de URL voor
        // stable IDs (titel kan kleine wijzigingen hebben tussen runs).
        // Als JSON-LD een eigen `url` heeft (= de canonieke event-URL,
        // bv. Concertgebouw waar `babyconcert-0-t-m-18-maanden` een
        // alias is voor `loes-luca-the-ramblers`), gebruiken we die
        // voor de slug zodat alle alias-pages naar één event mergen.
        const head = evs[0];
        const title = head.name ? decodeEntities(head.name).trim() : '';
        if (!title) { result.skipped++; return; }
        // Peppered SaaS theaters (De Omval, mogelijk anderen) exposen
        // ticketing-flows als "/voorstellingen/tafel-reserveren-…" met
        // JSON-LD Event — niet een echte voorstelling maar een restaurant-
        // reservering. Skip op title-prefix; URL-pattern verfijnen per
        // venue is fragieler.
        if (/^tafel\s*reserveren\b/i.test(title)) { result.skipped++; return; }
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
        if (!titleSlug) { result.skipped++; return; }

        // Slug-id blijft de identiteit voor nieuwe shows; een bestaand
        // event met dezelfde titel wint. Reserveren gebeurt synchroon
        // (geen await tussen get en set) omdat runWithConcurrency
        // meerdere pagina's parallel draait — anders inserten twee
        // alias-URLs van dezelfde show alsnog beide.
        // `owns` is false bij een alias-URL die naar een ander event
        // mapt; het delete-pad hieronder mag dan niet vuren, want de
        // eigenaar-pagina heeft nog datums.
        const { eventId, owns: ownsEvent } = resolveEventId(
          byTitle,
          title,
          `evt-th-${venue.id}-${titleSlug}`,
          // De datums (slots) worden hieronder pas opgebouwd; de
          // description uit het JSON-LD-blok is hier al beschikbaar.
          { description: head.description ? decodeEntities(head.description) : null }
        );

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
            // 20:00 Amsterdam-local — DST-aware via shared helper.
            const startsAt = parseAmsterdamLocal(`${d}T20:00:00`);
            if (!isNaN(startsAt.getTime())) slots.push({ startsAt, endsAt: null });
          }
        } else {
          for (const ev of evs) {
            if (!ev.startDate) continue;
            // JSON-LD conventie verschilt per venue:
            //  - Meervaart publiceert correct UTC ("...17:00:00Z")
            //  - NDSM publiceert naive Amsterdam-local ("...19:30:00")
            // parseIsoFlexible kiest per string: respect Z/offset waar
            // aanwezig, anders Ams-local interpreteren.
            const startsAt = parseIsoFlexible(ev.startDate);
            if (isNaN(startsAt.getTime())) continue;
            const endsAt = ev.endDate ? parseIsoFlexible(ev.endDate) : null;
            slots.push({ startsAt, endsAt });
          }
        }

        const cutoff = Date.now() - 6 * 60 * 60 * 1000;
        const fresh = slots.filter((s) => (s.endsAt ?? s.startsAt).getTime() > cutoff);
        if (fresh.length === 0) {
          // Als de show als "Afgelopen" gemarkeerd is en het event al
          // bestaat, verwijderen we hem (occurrences cascaden mee). Zo
          // blijft de DB schoon van afgelopen voorstellingen die anders
          // als orphan-events met 0 occurrences blijven hangen.
          if (existing && ownsEvent && cfg.useDataDateAttrs && isAfgelopen(html)) {
            await db.delete(schema.events).where(eq(schema.events.id, eventId));
            result.skipped++;
            return;
          }
          result.skipped++;
          return;
        }

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
            return;
          }
        }

        for (const slot of fresh) {
          try {
            const isoDate = slot.startsAt.toISOString().slice(0, 10);
            // Afgeleid van het *opgeloste* eventId, niet van de slug:
            // anders krijgt dezelfde datum onder twee alias-slugs twee
            // occurrences op hetzelfde event. Voor een niet-geremapte
            // show levert dit exact de oude id op, dus backwards
            // compatible met wat er in de DB staat.
            const occurrenceId = `${eventId.replace(/^evt-th-/, 'occ-th-')}-${isoDate}`;
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
    });

    const tookMs = Date.now() - venueStart;
    console.log(
      `[theater] done ${venue.slug} in ${tookMs}ms — fetched=${result.fetched} inserted=${result.inserted} occ=${result.occurrencesUpserted} skipped=${result.skipped} errors=${result.errors.length}`
    );
    results.push(result);
  }

  return results;
}
