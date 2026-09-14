/**
 * Parsers voor Doornroosje, Nijmegen (inclusief hun tweede zaal Merleyn
 * aan de Hertogstraat — die staat in hetzelfde programma en komt hier
 * als `room` binnen).
 *
 * De homepage ís de agenda: 211 server-rendered permalinks, geen
 * paginatie, geen load-more. Hun events-sitemap heeft er 962, maar dat
 * zijn de 211 komende plus 751 afgelopen.
 *
 * Per detailpagina komt het uit twee bronnen:
 *  - JSON-LD `Event`: titel, datum, eindtijd, zaal, status.
 *  - de HTML ernaast: prijs, genre-tags en de volledige tekst. De
 *    `description` in de JSON-LD is één teaserregel ("Indrukwekkende,
 *    zware progressieve metal uit België"); het echte verhaal staat in
 *    de body.
 *
 * **De offset in hun startDate liegt.** Er staat `+00:00`, maar de tijd
 * ernaast is de wandklok die de pagina zelf toont: "2026-11-05T22:00:00
 * +00:00" hoort bij "start: 22:00 uur", niet bij 23:00 lokaal. Nagemeten
 * op elf events verspreid over zomer- en wintertijd, allemaal `+00:00`
 * en allemaal gelijk aan de getoonde tijd. We negeren de offset dus
 * bewust en lezen de tijd als Amsterdamse wandklok — dat is precies wat
 * parseAmsterdamLocal doet, want die matcht alleen de datum en tijd en
 * kijkt niet naar wat erachter staat.
 */

import { parseAmsterdamLocal } from './_amsterdam-tz.js';
import { decodeHtmlEntities } from './_jsonld-parser.js';

export type DoornroosjeEvent = {
  slug: string;
  url: string;
  title: string;
  description: string | null;
  startsAt: Date;
  endsAt: Date | null;
  imageUrl: string | null;
  ticketUrl: string | null;
  room: string | null;
  genres: string[];
  priceCents: number | null;
  cancelled: boolean;
};

const LINK_RE = /href="(https:\/\/www\.doornroosje\.nl\/event\/[^"\/#?]+\/)"/g;

export function parseDoornroosjeLinks(html: string): string[] {
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

export function slugVanUrl(url: string): string | null {
  return url.match(/\/event\/([^/]+)\/?$/)?.[1] ?? null;
}

/** Zichtbare tekstregels, in leesvolgorde. De pagina hangt aan vaste
    labels ("locatie:", "start:", "genre"), dus dat is een betrouwbaarder
    anker dan hun class-namen. */
export function zichtbareRegels(html: string): string[] {
  const body = html.slice(Math.max(0, html.indexOf('<body')));
  const zonderScripts = body.replace(
    /<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi,
    ''
  );
  return decodeHtmlEntities(zonderScripts.replace(/<[^>]+>/g, '\n'))
    .split('\n')
    .map((r) => r.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** Waarde direct ná een label, of null. */
function naLabel(regels: string[], label: string): string | null {
  const i = regels.indexOf(label);
  return i >= 0 && i + 1 < regels.length ? regels[i + 1]! : null;
}

/**
 * Laagste bedrag uit het kopblok — dat loopt van de titel tot "locatie:".
 * Daar staat de entreeprijs, en soms een groepsticket ernaast
 * ("€ 21,50 · Groepsticket 4x: € 82"); dat laatste is geen entreeprijs.
 * Zij schrijven decimalen met een komma óf met een punt.
 */
export function prijsCents(regels: string[]): number | null {
  const eind = regels.indexOf('locatie:');
  const blok = (eind > 0 ? regels.slice(0, eind) : regels.slice(0, 12)).join(' ');
  const bedragen: number[] = [];
  for (const m of blok.matchAll(/€\s*(\d{1,4})(?:[.,](\d{2})|,-)?/g)) {
    bedragen.push(parseInt(m[1]!, 10) * 100 + (m[2] ? parseInt(m[2], 10) : 0));
  }
  if (!bedragen.length) return /\bgratis\b/i.test(blok) ? 0 : null;
  return Math.min(...bedragen);
}

/** Hun eigen genre-regel: "metal, progressive metal, sludge metal". */
export function parseGenres(regels: string[]): string[] {
  const regel = naLabel(regels, 'genre');
  if (!regel || regel.includes(':')) return [];
  return regel
    .split(',')
    .map((g) => g.trim().toLowerCase())
    .filter((g) => g && g.length < 40);
}

/**
 * De alinea's tussen het tijdenblok en "route & bezoek". Alles ervóór is
 * meta (prijs, zaal, datum, tijden), alles erna is vaste voetregel
 * (routebeschrijving, genre, nieuwsbrief).
 */
export function parseBeschrijving(regels: string[]): string | null {
  const LABELS = ['einde:', 'deuren sluiten:', 'start:', 'zaal open:', 'datum:'];
  let begin = -1;
  for (const label of LABELS) {
    const i = regels.indexOf(label);
    // +2: het label zelf en z'n waarde overslaan.
    if (i >= 0 && i + 2 > begin) begin = i + 2;
  }
  if (begin < 0) return null;
  let eind = regels.indexOf('route & bezoek', begin);
  if (eind < 0) eind = regels.indexOf('genre', begin);
  if (eind < 0) eind = Math.min(begin + 12, regels.length);
  const alineas = regels
    .slice(begin, eind)
    // Losse woorden zijn knoppen en labels, geen tekst.
    .filter((r) => r.length > 40);
  return alineas.length ? alineas.join('\n\n') : null;
}

function eventNode(html: string): Record<string, unknown> | null {
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
      if (node['@type'] === 'Event' && typeof node.startDate === 'string') {
        return node;
      }
    }
  }
  return null;
}

export function parseDoornroosjePage(
  html: string,
  url: string
): DoornroosjeEvent | null {
  const node = eventNode(html);
  const slug = slugVanUrl(url);
  if (!node || !slug) return null;

  const title = decodeHtmlEntities(String(node.name ?? '')).trim();
  // Offset genegeerd — zie de toelichting bovenaan.
  const startsAt = parseAmsterdamLocal(node.startDate as string);
  if (!title || isNaN(startsAt.getTime())) return null;

  const eind =
    typeof node.endDate === 'string' ? parseAmsterdamLocal(node.endDate) : null;
  const status =
    typeof node.eventStatus === 'string' ? node.eventStatus : '';
  const zaal = (node.location as { name?: unknown } | undefined)?.name;
  const regels = zichtbareRegels(html);

  const teaser =
    typeof node.description === 'string'
      ? decodeHtmlEntities(node.description).trim() || null
      : null;

  return {
    slug,
    url,
    title,
    description: parseBeschrijving(regels) ?? teaser,
    startsAt,
    endsAt: eind && !isNaN(eind.getTime()) && eind > startsAt ? eind : null,
    imageUrl:
      html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i)?.[1] ??
      null,
    ticketUrl:
      html.match(
        /href="(https:\/\/(?:order|ticketshop)\.doornroosje\.nl\/[^"]+)"/i
      )?.[1] ?? null,
    room: typeof zaal === 'string' ? decodeHtmlEntities(zaal).trim() || null : null,
    genres: parseGenres(regels),
    priceCents: prijsCents(regels),
    cancelled: /cancelled|postponed/i.test(status),
  };
}
