/**
 * Parsers voor SPOT Groningen — de organisatie achter De Oosterpoort en
 * de Stadsschouwburg (en twee kleinere plekken, De Machinefabriek en het
 * A-Theater).
 *
 * `/programma/` is één server-rendered pagina met het hele programma:
 * ruim zeshonderd permalinks, geen paginatie. De tegels dragen alleen
 * datum, titel en teaser — in welk gebouw iets speelt staat er niet bij,
 * dus de detailpagina is altijd nodig.
 *
 * Daar staat een JSON-LD `Event` met een échte offset in `startDate`
 * (+02:00 / +01:00), dus `new Date()` klopt hier gewoon. Het gebouw en
 * de zaal zitten in `location.address` — niet in `location.name`, want
 * die is voor alle vier de panden "SPOT Groningen".
 *
 * De omschrijving in de JSON-LD is één teaserregel; het echte verhaal
 * staat als losse alinea's in de HTML.
 */

import { extractJsonLdEvents } from './_jsonld-parser.js';
import { decodeHtmlEntities } from './_jsonld-parser.js';

export type SpotEvent = {
  slug: string;
  url: string;
  title: string;
  description: string | null;
  startsAt: Date;
  endsAt: Date | null;
  imageUrl: string | null;
  ticketUrl: string | null;
  /** "De Oosterpoort", "Stadsschouwburg", "De Machinefabriek", "A-Theater". */
  gebouw: string | null;
  /** "Grote zaal", "Kleine zaal" — niet elk pand heeft zaalnamen. */
  zaal: string | null;
  priceCents: number | null;
  soldOut: boolean;
};

const LINK_RE =
  /href="(https:\/\/www\.spotgroningen\.nl\/programma\/[^"\/#?]+\/)"/g;

/** Permalinks uit `/programma/`. `verzameling` is een rubriek en
    `abonnement…` een seizoenskaart; geen van beide is een voorstelling. */
export function parseSpotLinks(html: string): string[] {
  const uit: string[] = [];
  const gezien = new Set<string>();
  for (const m of html.matchAll(LINK_RE)) {
    const url = m[1]!;
    if (url.includes('/verzameling/') || /\/abonnement/.test(url)) continue;
    if (gezien.has(url)) continue;
    gezien.add(url);
    uit.push(url);
  }
  return uit;
}

export function slugVanUrl(url: string): string | null {
  return url.match(/\/programma\/([^/]+)\/?$/)?.[1] ?? null;
}

/**
 * "SPOT/De Oosterpoort, Kleine zaal / Trompsingel 27, 9724 DA Groningen"
 * → gebouw "De Oosterpoort", zaal "Kleine zaal".
 *
 * Het deel vóór de eerste " / " is het pand plus eventueel de zaal; wat
 * erna komt is het straatadres.
 */
export function pandUitAdres(adres: unknown): {
  gebouw: string | null;
  zaal: string | null;
} {
  if (typeof adres !== 'string' || !adres.trim()) return { gebouw: null, zaal: null };
  const kop = decodeHtmlEntities(adres.split(' / ')[0]!).trim();
  const zonderMerk = kop.replace(/^SPOT\s*\/\s*/i, '').trim();
  const delen = zonderMerk.split(',').map((d) => d.trim()).filter(Boolean);
  if (!delen.length) return { gebouw: null, zaal: null };
  // Een deel met een huisnummer is een straat, geen zaal.
  const zaal = delen[1] && !/\d/.test(delen[1]) ? delen[1] : null;
  return { gebouw: delen[0] ?? null, zaal };
}

/** "30.00" → 3000. */
export function prijsCents(raw: unknown): number | null {
  if (typeof raw === 'number') return Math.round(raw * 100);
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(/^(\d{1,4})(?:[.,](\d{1,2}))?$/);
  if (!m) return null;
  return parseInt(m[1]!, 10) * 100 + parseInt((m[2] ?? '0').padEnd(2, '0'), 10);
}

/** Regels die op elke pagina staan en niets over de voorstelling zeggen. */
const BOILERPLATE =
  /cookie|nieuwsbrief|privacy|voorwaarden|abonnement|inloggen|toegankelijk|parkeren|VIP-PAKKET IS/i;

/**
 * De alinea's uit de pagina. Er is geen content-container om op te
 * mikken — `event__content` bestaat alleen in hun CSS — dus we nemen de
 * zichtbare regels die lang genoeg zijn om een alinea te zijn en gooien
 * de vaste voetregels eruit. Getest op zeven pagina's: 600 tot 4000
 * tekens, geen navigatie of knoppen ertussen.
 */
export function parseBeschrijving(html: string): string | null {
  const body = html.slice(Math.max(0, html.indexOf('<body')));
  const zonder = body.replace(
    /<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi,
    ''
  );
  const alineas = decodeHtmlEntities(zonder.replace(/<[^>]+>/g, '\n'))
    .split('\n')
    .map((r) => r.replace(/\s+/g, ' ').trim())
    .filter((r) => r.length > 90 && !BOILERPLATE.test(r));
  return alineas.length ? alineas.join('\n\n') : null;
}

/** Adres, prijs en beschikbaarheid — wat de generieke JSON-LD-extractor
    niet meeneemt. */
function extras(html: string): {
  adres: unknown;
  price: unknown;
  availability: string;
} {
  const leeg = { adres: null, price: null, availability: '' };
  const re =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    let blok: unknown;
    try {
      blok = JSON.parse(m[1]!.trim());
    } catch {
      continue;
    }
    const graph = (blok as { '@graph'?: unknown })['@graph'];
    for (const n of Array.isArray(graph) ? graph : [blok]) {
      const node = n as Record<string, unknown>;
      if (node['@type'] !== 'Event') continue;
      const offers = Array.isArray(node.offers) ? node.offers[0] : node.offers;
      const o = (offers ?? {}) as Record<string, unknown>;
      return {
        adres: (node.location as { address?: unknown } | undefined)?.address,
        price: o.price,
        availability: typeof o.availability === 'string' ? o.availability : '',
      };
    }
  }
  return leeg;
}

export function parseSpotPage(html: string, url: string): SpotEvent | null {
  const [ev] = extractJsonLdEvents(html);
  const slug = slugVanUrl(url);
  if (!ev || !slug) return null;
  const extra = extras(html);
  const { gebouw, zaal } = pandUitAdres(extra.adres);
  return {
    slug,
    url,
    title: ev.name,
    description: parseBeschrijving(html) ?? ev.description,
    startsAt: ev.startsAt,
    endsAt: ev.endsAt && ev.endsAt > ev.startsAt ? ev.endsAt : null,
    imageUrl: ev.imageUrl,
    ticketUrl: ev.ticketUrl,
    gebouw,
    zaal,
    priceCents: prijsCents(extra.price),
    soldOut: /outofstock|soldout/i.test(extra.availability),
  };
}
