/**
 * Parsers voor Effenaar, Eindhoven.
 *
 * Next.js met alles in `__NEXT_DATA__`; er is geen losse API achter (de
 * server haalt het CMS zelf op en bakt het in de pagina). Dat geeft twee
 * bronnen:
 *
 *  - `/agenda` draagt de volledige Algolia-collectie mee — 130 hits in
 *    één response, `nbPages: 1`, dus zonder ooit Algolia zelf aan te
 *    roepen. Daarin staat per event de dag, de zaal, de genres, het
 *    beeld en de verkoopstatus.
 *  - de detailpagina heeft de starttijd, en die staat níet in de
 *    collectie: hun `date` is een timestamp op 12:00 UTC, alleen de dag.
 *
 * Detailpagina's zijn 1,6 MB per stuk, dus de scraper haalt ze alleen op
 * voor events die hij nog niet kent of waarvan de dag verschoven is. Al
 * het andere — uitverkocht, afgelast, zaal, genre — komt uit die ene
 * collectie-fetch en blijft dus elke nacht bijgewerkt.
 *
 * Let op bij de detailpagina: er staan tientallen `AgendaDetail-*`
 * queries in (gerelateerde events, carrousels). Welke bij de pagina zélf
 * hoort staat in `pageProps.queryParams.queryKey` — de eerste pakken
 * geeft voor élke pagina hetzelfde event.
 */

import { parseAmsterdamLocal } from './_amsterdam-tz.js';
import { decodeHtmlEntities } from './_jsonld-parser.js';

export type EffenaarTegel = {
  /** Drupal-node-id uit `search_api_id` ("entity:node/2002:nl"). Stabieler
      dan de slug, die per editie wisselt ("ronde-18okt"). */
  nid: string;
  url: string;
  title: string;
  subtitle: string | null;
  teaser: string | null;
  /** YYYY-MM-DD in Amsterdamse tijd. */
  dagIso: string;
  room: string | null;
  genres: string[];
  imageUrl: string | null;
  soldOut: boolean;
  cancelled: boolean;
};

export type EffenaarDetail = {
  dagIso: string | null;
  startLokaal: string | null;
  eindLokaal: string | null;
  priceCents: number | null;
  ticketUrl: string | null;
  description: string | null;
  room: string | null;
  genres: string[];
};

const BASIS = 'https://www.effenaar.nl';

function nextData(html: string): Record<string, unknown> | null {
  const m = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
  );
  if (!m) return null;
  try {
    return JSON.parse(m[1]!) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function pad(obj: unknown, ...sleutels: string[]): unknown {
  let huidig = obj;
  for (const s of sleutels) {
    if (!huidig || typeof huidig !== 'object') return undefined;
    huidig = (huidig as Record<string, unknown>)[s];
  }
  return huidig;
}

function tekstUitHtml(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const tekst = decodeHtmlEntities(
    raw
      .replace(/<\/p>|<\/div>|<\/li>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((r) => r.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return tekst || null;
}

function titels(lijst: unknown): string[] {
  if (!Array.isArray(lijst)) return [];
  return lijst
    .map((x) => (x as { title?: unknown })?.title)
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    .map((t) => decodeHtmlEntities(t).trim());
}

/** Beeld-URL uit hun image-object; `src` is het origineel, `sizes` de
    afgeleiden. We nemen het origineel en laten Bunny het verkleinen. */
function beeldUrl(...kandidaten: unknown[]): string | null {
  for (const k of kandidaten) {
    const src = pad(k, 'image', 'src');
    if (typeof src === 'string' && src.startsWith('http')) return src;
  }
  return null;
}

/** "31.00" → 3100. Hun veld is een string, soms null. */
export function prijsCents(raw: unknown): number | null {
  if (typeof raw === 'number') return Math.round(raw * 100);
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(/^(\d{1,4})(?:[.,](\d{1,2}))?$/);
  if (!m) return null;
  return parseInt(m[1]!, 10) * 100 + parseInt((m[2] ?? '0').padEnd(2, '0'), 10);
}

/** Hun `date` is een unix-timestamp op 12:00 UTC — dat is 13:00 of 14:00
    in Amsterdam, dus altijd dezelfde kalenderdag. Alleen de dag telt. */
export function dagUitTimestamp(ts: unknown): string | null {
  const n = typeof ts === 'string' ? parseInt(ts, 10) : typeof ts === 'number' ? ts : NaN;
  if (!Number.isFinite(n)) return null;
  const d = new Date(n * 1000);
  if (isNaN(d.getTime())) return null;
  const delen = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  return /^\d{4}-\d{2}-\d{2}$/.test(delen) ? delen : null;
}

/** Dag + wandkloktijd → een echt moment. */
export function momentVan(dagIso: string, tijd: string | null): Date | null {
  if (!tijd || !/^\d{1,2}:\d{2}$/.test(tijd)) return null;
  const d = parseAmsterdamLocal(`${dagIso}T${tijd.padStart(5, '0')}`);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * De eindtijd, met de dagovergang erin. Hun `ends_at` is een kale
 * wandklok op dezelfde dagregel: een avond die om 19:30 begint en
 * "00:00" als einde heeft, loopt tot middernacht ná die dag — niet tot
 * negentien uur vóór de aanvang. Ligt het einde op of vóór de start,
 * dan telt er een dag bij.
 *
 * Geeft null als er geen bruikbare eindtijd is, zodat de aanroeper het
 * veld gewoon leeg laat.
 */
export function eindMoment(
  dagIso: string,
  startLokaal: string | null,
  eindLokaal: string | null
): Date | null {
  const eind = momentVan(dagIso, eindLokaal);
  if (!eind) return null;
  const start = momentVan(dagIso, startLokaal);
  if (!start) return eind;
  if (eind.getTime() > start.getTime()) return eind;
  const volgende = new Date(`${dagIso}T12:00:00Z`);
  volgende.setUTCDate(volgende.getUTCDate() + 1);
  const volgendeDag = volgende.toISOString().slice(0, 10);
  const doorgerold = momentVan(volgendeDag, eindLokaal);
  // Alleen als het zo écht na de start ligt; anders is het veld onzin.
  return doorgerold && doorgerold.getTime() > start.getTime() ? doorgerold : null;
}

export function parseEffenaarCollectie(html: string): EffenaarTegel[] {
  const data = nextData(html);
  const queries = pad(data, 'props', 'pageProps', 'dehydrated', 'queries');
  if (!Array.isArray(queries)) return [];
  const collectie = queries.find(
    (q) => typeof (q as { queryKey?: unknown }).queryKey === 'string' &&
      ((q as { queryKey: string }).queryKey).startsWith('events-collection')
  );
  const hits = pad(
    collectie,
    'state', 'data', 'pageData', 'algolia', 'serverState', 'initialResults'
  );
  // De index heet production_events, maar we pakken 'm op vorm zodat een
  // hernoeming ons niet meteen op nul zet.
  const eerste = hits && typeof hits === 'object'
    ? Object.values(hits as Record<string, unknown>)[0]
    : undefined;
  const resultaten = pad(eerste, 'results');
  if (!Array.isArray(resultaten) || !resultaten.length) return [];
  const rauw = pad(resultaten[0], 'hits');
  if (!Array.isArray(rauw)) return [];

  const uit: EffenaarTegel[] = [];
  const gezien = new Set<string>();
  for (const h of rauw) {
    const hit = h as Record<string, unknown>;
    const nid = String(hit.search_api_id ?? '').match(/node\/(\d+)/)?.[1];
    const slug = typeof hit.slug === 'string' ? hit.slug : null;
    const title = decodeHtmlEntities(String(hit.title ?? '')).trim();
    const dagIso = dagUitTimestamp(hit.date);
    if (!nid || !slug || !title || !dagIso) continue;
    if (gezien.has(nid)) continue;
    gezien.add(nid);
    const state = typeof hit.state === 'string' ? hit.state : '';
    uit.push({
      nid,
      url: slug.startsWith('http') ? slug : `${BASIS}${slug}`,
      title,
      subtitle: typeof hit.subtitle === 'string' && hit.subtitle.trim()
        ? decodeHtmlEntities(hit.subtitle).trim()
        : null,
      teaser: tekstUitHtml(hit.introduction),
      dagIso,
      room: titels(hit.locations)[0] ?? null,
      genres: titels(hit.genres).map((g) => g.toLowerCase()),
      imageUrl: beeldUrl(hit.header_image, hit.thumbnail_image),
      soldOut: state === 'sold_out',
      // "moved" telt als afgelast: de datum die wij hebben klopt dan niet
      // meer, en zij zetten er zelf geen nieuwe bij.
      cancelled: state === 'cancelled' || state === 'moved',
    });
  }
  return uit;
}

export function parseEffenaarDetail(html: string): EffenaarDetail | null {
  const data = nextData(html);
  const pageProps = pad(data, 'props', 'pageProps');
  const sleutel = pad(pageProps, 'queryParams', 'queryKey');
  const queries = pad(pageProps, 'dehydrated', 'queries');
  if (typeof sleutel !== 'string' || !Array.isArray(queries)) return null;
  // Alleen de query die bij déze pagina hoort; er staan er tientallen in.
  const eigen = queries.find(
    (q) => (q as { queryKey?: unknown }).queryKey === sleutel
  );
  const pd = pad(eigen, 'state', 'data', 'pageData');
  if (!pd || typeof pd !== 'object') return null;
  const veld = pd as Record<string, unknown>;
  const tijd = (k: string) => {
    const v = pad(veld.times, k);
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };
  const machine = pad(veld.date, 'machine');
  return {
    dagIso:
      typeof machine === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(machine)
        ? machine
        : dagUitTimestamp(pad(veld.date, 'timestamp')),
    startLokaal: tijd('starts_at'),
    eindLokaal: tijd('ends_at'),
    priceCents: prijsCents(veld.ticket_price),
    ticketUrl: (() => {
      const uri = pad(veld.ticket_url, 'uri');
      return typeof uri === 'string' && uri.startsWith('http') ? uri : null;
    })(),
    description: tekstUitHtml(veld.content),
    room: titels(veld.locations)[0] ?? null,
    genres: titels(veld.genres).map((g) => g.toLowerCase()),
  };
}
