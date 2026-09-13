/**
 * Parsers voor 013, Tilburg.
 *
 * Twee bronnen, allebei server-rendered:
 *  - `/programma` — één pagina met álle komende events (geen paginatie,
 *    `?page=N` geeft steeds dezelfde 162 tegels terug). De tegels zelf
 *    dragen weinig; we gebruiken ze alleen voor de permalinks.
 *  - de detailpagina — JSON-LD `MusicEvent` met datum, eindtijd, zaal,
 *    beeld, omschrijving en ticketlink. Alles wat we nodig hebben.
 *
 * Let op: 013 zet z'n links absoluut (`https://www.013.nl/programma/…`)
 * en zeven slugs bevatten niet-ASCII (`axel-flóvent`, `käärijä`,
 * `queensrÿche`). Een tekenklasse-regex knipt die halverwege af en
 * levert een URL die 200 mét een lege pagina teruggeeft — vandaar dat
 * we op `href="…"` matchen en niet op het URL-patroon zelf.
 */

import { extractJsonLdEvents } from './_jsonld-parser.js';

export type Event013 = {
  /** `identifier` uit de JSON-LD — stabiel, ook als de slug wijzigt. */
  id: string;
  url: string;
  title: string;
  description: string | null;
  startsAt: Date;
  endsAt: Date | null;
  imageUrl: string | null;
  ticketUrl: string | null;
  room: string | null;
  priceCents: number | null;
  soldOut: boolean;
  /** 013 haalt een afgelaste show niet van de site: de pagina blijft
      staan met een schone titel en `eventStatus: EventCancelled`. Zonder
      dit veld zou de rij die we eerder schreven op `scheduled` blijven
      staan, want de scraper ziet 'm dan nooit meer. */
  cancelled: boolean;
};

const LINK_RE =
  /href="(https:\/\/www\.013\.nl\/programma\/\d+\/[^"#?]+)"/g;

/** Alle event-permalinks uit `/programma`, ontdubbeld en op volgorde. */
export function parseProgrammaLinks(html: string): string[] {
  const uit: string[] = [];
  const gezien = new Set<string>();
  for (const m of html.matchAll(LINK_RE)) {
    const url = m[1]!;
    if (gezien.has(url)) continue;
    gezien.add(url);
    uit.push(url);
  }
  return uit;
}

/** "Poppodium 013 - Main (seated)" → "Main (seated)". Zalen die niet
    onder de 013-vlag hangen ("Hall of Fame", "Cul de Sac") blijven heel. */
export function zaalVanLocatie(naam: unknown): string | null {
  if (typeof naam !== 'string') return null;
  const schoon = naam.replace(/^Poppodium\s*013\s*[-–]\s*/i, '').trim();
  return schoon || null;
}

/** De drie velden die de generieke JSON-LD-extractor niet meeneemt:
    het CMS-id, de zaal en of het uitverkocht is. */
function extraVelden(html: string): {
  id: string | null;
  room: string | null;
  soldOut: boolean;
} {
  const leeg = { id: null, room: null, soldOut: false };
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
    const nodes = Array.isArray(graph) ? graph : [blok];
    for (const n of nodes) {
      const node = n as Record<string, unknown>;
      // Alleen het volledige event-blok draagt een identifier; het
      // SEO-samenvattingsblok met hetzelfde @type heeft er geen.
      if (node.identifier === undefined || node.startDate === undefined) continue;
      const offers = node.offers as { availability?: unknown } | undefined;
      const beschikbaar =
        typeof offers?.availability === 'string' ? offers.availability : '';
      return {
        id: String(node.identifier),
        room: zaalVanLocatie((node.location as { name?: unknown } | undefined)?.name),
        soldOut: /outofstock|soldout/i.test(beschikbaar),
      };
    }
  }
  return leeg;
}

/**
 * Laagste prijs uit het ticket-blok, in centen. `Gratis` → 0, geen
 * bedrag → null.
 *
 * Waarom de laagste en niet de eerste: bij een zaalindeling met rangen
 * staat de duurste bovenaan ("€ 85,80 Premier · € 75,80 Rang 1 · …
 * € 55,80 Rang 3"). Wij tonen een vanaf-prijs, dus het minimum. Het
 * blok loopt van "Entree" tot "Datum" — de servicekosten-regel ertussen
 * noemt geen bedrag.
 */
export function prijsCents(html: string): number | null {
  const tekst = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const i = tekst.indexOf('Entree');
  if (i < 0) return null;
  const na = tekst.slice(i);
  const eind = na.search(/\bDatum\b/);
  const blok = eind > 0 ? na.slice(0, eind) : na.slice(0, 600);
  if (/\bgratis\b/i.test(blok)) return 0;
  const bedragen: number[] = [];
  for (const m of blok.matchAll(/€\s*(\d{1,4})(?:,(\d{2})|,-)?/g)) {
    bedragen.push(parseInt(m[1]!, 10) * 100 + (m[2] ? parseInt(m[2], 10) : 0));
  }
  return bedragen.length ? Math.min(...bedragen) : null;
}

/** `<p>`-grenzen worden witregels, `<br>` een enkele newline, de rest
    verdwijnt. Een generieke strip maakt van elke tag een spatie en dan
    plakken de alinea's aan elkaar. */
function tekstUitHtml(s: string): string {
  return s
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((r) => r.trim())
    .join('\n')
    .trim();
}

/**
 * Eén detailpagina → één event. Geeft null als de pagina geen bruikbare
 * JSON-LD heeft. Afgelaste shows komen wél terug, met `cancelled: true`
 * — zie de toelichting bij dat veld.
 */
export function parse013Page(html: string, url: string): Event013 | null {
  const [ev] = extractJsonLdEvents(html, { includeCancelled: true });
  if (!ev) return null;
  const extra = extraVelden(html);
  if (!extra.id) return null;
  return {
    id: extra.id,
    url,
    title: ev.name,
    description: ev.description ? tekstUitHtml(ev.description) || null : null,
    startsAt: ev.startsAt,
    endsAt: ev.endsAt && ev.endsAt > ev.startsAt ? ev.endsAt : null,
    imageUrl: ev.imageUrl,
    ticketUrl: ev.ticketUrl,
    room: extra.room,
    priceCents: prijsCents(html),
    soldOut: extra.soldOut,
    cancelled: ev.cancelled,
  };
}
