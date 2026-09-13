/**
 * Parsers voor PAARD, Den Haag.
 *
 * Zelfde vorm als 013: `/event/` is één server-rendered archief met het
 * hele komende programma (geen paginatie — `/event/page/2/` geeft 404),
 * en elke detailpagina draagt een JSON-LD `Event` met datum, eindtijd,
 * zaal, beeld, omschrijving en ticketlink.
 *
 * Twee dingen die 013 niet had:
 *  - Hun `startDate` is wandkloktijd zónder offset ("2026-09-12T20:00").
 *    `new Date()` leest dat als lokale tijd van de machine, wat op Fly
 *    (UTC) twee uur scheelt. Vandaar parseAmsterdamLocal en niet de
 *    generieke JSON-LD-extractor.
 *  - De genre-tags staan in de HTML (`tickets-intro__tags`), niet in de
 *    JSON-LD. Hun eigen indeling is beter dan wat een model uit een
 *    titel afleidt.
 */

import { parseAmsterdamLocal } from './_amsterdam-tz.js';
import { decodeHtmlEntities } from './_jsonld-parser.js';

export type PaardEvent = {
  /** De slug uit de permalink — PAARD heeft geen numeriek id. */
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
  soldOut: boolean;
};

/** `/en/event/…` valt af: dezelfde events, Engelse titels. */
const LINK_RE = /href="(https:\/\/www\.paard\.nl\/event\/[^"\/#?]+\/)"/g;

export function parsePaardLinks(html: string): string[] {
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

/**
 * De omschrijving komt uit hun CMS met aanhalingstekens eromheen en
 * rijen lege regels ertussen — een artikel dat via de WYSIWYG is
 * geplakt. Aanhalingstekens eraf, hoogstens één witregel.
 */
export function schoneTekst(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const tekst = decodeHtmlEntities(raw)
    .replace(/<[^>]+>/g, '')
    .replace(/\r/g, '')
    .replace(/^\s*"+|"+\s*$/g, '')
    .split('\n')
    .map((r) => r.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return tekst || null;
}

/** `<span>`s in de tag-strip: genre plus soms een leeftijdsgrens. Die
    laatste is geen genre — "18+" zegt iets over de deur, niet over de
    muziek. */
export function parseTags(html: string): string[] {
  const blok = html.match(
    /class="tickets-intro__tags"[^>]*>([\s\S]*?)<\/div>/i
  )?.[1];
  if (!blok) return [];
  return [...blok.matchAll(/<span[^>]*>([^<]+)<\/span>/gi)]
    .map((m) => decodeHtmlEntities(m[1]!).trim())
    .filter((t) => t && !/^\d{1,2}\+$/.test(t))
    .map((t) => t.toLowerCase());
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

export function parsePaardPage(html: string, url: string): PaardEvent | null {
  const node = eventNode(html);
  const slug = slugVanUrl(url);
  if (!node || !slug) return null;

  const title = decodeHtmlEntities(String(node.name ?? '')).trim();
  const startsAt = parseAmsterdamLocal(node.startDate as string);
  if (!title || isNaN(startsAt.getTime())) return null;

  const eind =
    typeof node.endDate === 'string' ? parseAmsterdamLocal(node.endDate) : null;
  const offers = node.offers as
    | { url?: unknown; availability?: unknown }
    | undefined;
  const beschikbaar =
    typeof offers?.availability === 'string' ? offers.availability : '';
  const zaal = (node.location as { name?: unknown } | undefined)?.name;

  return {
    slug,
    url,
    title,
    description: schoneTekst(node.description),
    startsAt,
    endsAt: eind && !isNaN(eind.getTime()) && eind > startsAt ? eind : null,
    imageUrl: typeof node.image === 'string' ? node.image : null,
    ticketUrl: typeof offers?.url === 'string' ? offers.url : null,
    room: typeof zaal === 'string' ? decodeHtmlEntities(zaal).trim() || null : null,
    genres: parseTags(html),
    soldOut: /outofstock|soldout/i.test(beschikbaar),
  };
}
