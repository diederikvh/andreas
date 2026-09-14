/**
 * Parsers voor Amare, Den Haag — het huis van het Residentie Orkest, het
 * Nederlands Dans Theater en het Koninklijk Conservatorium.
 *
 * `/nl/agenda?page=N` geeft vijftien tegels per pagina; bij de laatste
 * pagina houdt het vanzelf op (19 pagina's bij de eerste meting). De
 * tegels dragen alleen een permalink.
 *
 * Op de detailpagina staat per speeldatum een eigen JSON-LD `Event` —
 * "Gouwe Ouwe" heeft er twee, 15 september en 14 december. Dat is
 * precies ons model: één event met meerdere occurrences. De `startDate`
 * draagt een echte offset, dus `new Date()` klopt hier.
 *
 * Prijs en ticketlink staan niet in de statische HTML; hun kaartverkoop
 * draait op een apart systeem dat pas na JS laadt. De omschrijving in de
 * JSON-LD is afgekapt met een `…`, dus de volle tekst komt uit de body.
 */

import { extractJsonLdEvents } from './_jsonld-parser.js';
import { decodeHtmlEntities } from './_jsonld-parser.js';

export type AmareMoment = {
  startsAt: Date;
  endsAt: Date | null;
  room: string | null;
};

export type AmareEvent = {
  slug: string;
  url: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  momenten: AmareMoment[];
};

const LINK_RE = /href="(\/nl\/agenda\/[^"\/#?]+)"/g;
const BASIS = 'https://www.amare.nl';

export function parseAmareLinks(html: string): string[] {
  const uit: string[] = [];
  const gezien = new Set<string>();
  for (const m of html.matchAll(LINK_RE)) {
    const url = `${BASIS}${m[1]!}`;
    if (gezien.has(url)) continue;
    gezien.add(url);
    uit.push(url);
  }
  return uit;
}

export function slugVanUrl(url: string): string | null {
  return url.match(/\/agenda\/([^/?#]+)/)?.[1] ?? null;
}

/** Vaste regels die op elke pagina staan. Amare's cookiemuur is lang en
    komt in de body terecht; die mag niet in de omschrijving belanden. */
const BOILERPLATE =
  /cookie|winkelmandje|nieuwsbrief|privacy|voorwaarden|inloggen|toegankelijkheid|bereikbaarheid/i;

/** De alinea's uit de body. De JSON-LD-omschrijving is afgekapt, dus
    hier staat het echte verhaal. */
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

/** De zaal per Event-node. `extractJsonLdEvents` neemt `location` niet
    mee, dus die halen we er los bij — in dezelfde volgorde als de
    events, zodat een meerdaagse reeks per datum z'n eigen zaal houdt. */
function zalen(html: string): (string | null)[] {
  const uit: (string | null)[] = [];
  const re =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    let blok: unknown;
    try {
      blok = JSON.parse(m[1]!.trim());
    } catch {
      continue;
    }
    const lijst = Array.isArray(blok)
      ? blok
      : ((blok as { '@graph'?: unknown })['@graph'] as unknown[]) ?? [blok];
    for (const n of lijst) {
      const node = n as Record<string, unknown>;
      if (node['@type'] !== 'Event') continue;
      const naam = (node.location as { name?: unknown } | undefined)?.name;
      uit.push(
        typeof naam === 'string' && naam.trim()
          ? decodeHtmlEntities(naam).trim()
          : null
      );
    }
  }
  return uit;
}

export function parseAmarePage(html: string, url: string): AmareEvent | null {
  const slug = slugVanUrl(url);
  const events = extractJsonLdEvents(html);
  if (!slug || !events.length) return null;

  const perZaal = zalen(html);
  const momenten: AmareMoment[] = [];
  const gezien = new Set<number>();
  events.forEach((ev, i) => {
    const tijd = ev.startsAt.getTime();
    if (gezien.has(tijd)) return;
    gezien.add(tijd);
    momenten.push({
      startsAt: ev.startsAt,
      endsAt: ev.endsAt && ev.endsAt > ev.startsAt ? ev.endsAt : null,
      room: perZaal[i] ?? null,
    });
  });
  if (!momenten.length) return null;

  return {
    slug,
    url,
    title: events[0]!.name,
    description: parseBeschrijving(html) ?? events[0]!.description,
    imageUrl: events[0]!.imageUrl,
    momenten,
  };
}
