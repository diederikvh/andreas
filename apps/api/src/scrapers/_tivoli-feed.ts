/**
 * Parser voor de agenda-feed van TivoliVredenburg.
 *
 * Hun HTML zit achter een Cloudflare-challenge: Node's fetch krijgt 403
 * ("Just a moment..."), zowel lokaal als vanaf Fly, terwijl python en
 * een echte browser er wél doorheen komen. Dat is TLS-fingerprinting,
 * niet het IP — andere headers helpen niet.
 *
 * Eén route is niet afgeschermd: `/agenda/feed/`. Dat is de WordPress
 * RSS-feed, tien items per pagina, door te bladeren met `?paged=N`. En
 * die feed is rijker dan de pagina zelf: elk item draagt in
 * `content:encoded` de volledige productie-JSON uit hun CMS — titel,
 * begin- en eindtijd in UTC, zalen, genre, omschrijving, prijs,
 * ticketlink en beelden. Detailpagina's zijn dus niet nodig, en die
 * zouden ook 403 geven.
 *
 * Twee eigenaardigheden van die JSON:
 *  - er staat staarttekst ná het object ("Het bericht ... verscheen
 *    eerst op TivoliVredenburg"), dus knippen op de accolades;
 *  - het CMS laat rauwe stuurtekens in de omschrijving staan, en daar
 *    struikelt JSON.parse over.
 */

export type TivoliEvent = {
  /** `displayId` uit het CMS; stabiel per voorstelling. */
  id: string;
  url: string;
  title: string;
  subtitle: string | null;
  /** ISO met Z — het CMS levert UTC. */
  startUtc: string;
  endUtc: string | null;
  description: string | null;
  imageUrl: string | null;
  room: string | null;
  genre: string | null;
  priceCents: number | null;
  ticketUrl: string | null;
  soldOut: boolean;
  cancelled: boolean;
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function tekst(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = decodeEntities(v.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return t || null;
}

/** Knip het JSON-object uit de CDATA en maak het parsebaar. */
export function extractProductionJson(encoded: string): Record<string, unknown> | null {
  const zonderTags = decodeEntities(encoded.replace(/<[^>]+>/g, ''));
  const start = zonderTags.indexOf('{"production"');
  if (start < 0) return null;
  // Accolades tellen tot het object sluit; er staat staarttekst achter.
  let diepte = 0;
  let inString = false;
  let escaped = false;
  let eind = -1;
  for (let i = start; i < zonderTags.length; i++) {
    const c = zonderTags[i]!;
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') diepte++;
    else if (c === '}') { diepte--; if (diepte === 0) { eind = i + 1; break; } }
  }
  if (eind < 0) return null;
  // Rauwe stuurtekens binnen strings escapen.
  const schoon = zonderTags
    .slice(start, eind)
    .replace(/[\u0000-\u001f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  try {
    const j = JSON.parse(schoon) as { production?: Record<string, unknown> };
    return j.production ?? null;
  } catch {
    return null;
  }
}

function zaalVan(p: Record<string, unknown>): string | null {
  const locs = p.locations as { name?: string; showOnWebsite?: boolean }[] | undefined;
  if (!Array.isArray(locs)) return null;
  // Alleen zalen die ze zelf tonen; de rest is interne administratie
  // ("Buitenwereld", "K.F. Hein Foyer").
  // Ontdubbelen: dezelfde zaal staat er soms twee keer in, een keer als
  // VenueRoom en een keer als ExternalLocation.
  const zichtbaar = [
    ...new Set(locs.filter((l) => l?.showOnWebsite && l.name).map((l) => l.name!.trim())),
  ];
  if (!zichtbaar.length) return null;
  return zichtbaar.join(', ').slice(0, 80);
}

function beeldVan(p: Record<string, unknown>): string | null {
  const asset = (p.defaultDigitalAsset ?? (p.digitalAssets as unknown[])?.[0]) as
    | { urls?: Record<string, string>; sourceUrl?: string }
    | undefined;
  return asset?.urls?.landscape_large ?? asset?.urls?.landscape_extralarge ?? asset?.sourceUrl ?? null;
}

export function parseTivoliFeed(xml: string): TivoliEvent[] {
  const uit: TivoliEvent[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = m[1]!;
    const link = item.match(/<link>([^<]+)<\/link>/)?.[1]?.trim();
    const enc = item.match(/<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/)?.[1];
    if (!link || !enc) continue;
    const p = extractProductionJson(enc);
    if (!p) continue;

    const id = typeof p.displayId === 'string' ? p.displayId : null;
    const start = typeof p.startDatetime === 'string' ? p.startDatetime : null;
    const title = tekst(p.publicTitleWebsite) ?? tekst(p.publicTitle) ?? tekst(p.name);
    if (!id || !start || !title) continue;
    // publishToWebsite=false zijn interne producties (zaalverhuur,
    // crew-dagen) die ze zelf ook niet tonen.
    if (p.publishToWebsite === false) continue;

    const prijs = typeof p.priceOverride === 'number' ? p.priceOverride : NaN;
    const status = String(p.ticketStatus ?? '');
    uit.push({
      id,
      url: link,
      title,
      subtitle: tekst(p.subTitle),
      startUtc: start,
      endUtc: typeof p.endDatetime === 'string' ? p.endDatetime : null,
      description: tekst(p.mainContent),
      imageUrl: beeldVan(p),
      room: zaalVan(p),
      genre: tekst(p.publicGenre),
      priceCents: Number.isFinite(prijs) ? Math.round(prijs * 100) : null,
      ticketUrl: typeof p.externalTicketLink === 'string' ? p.externalTicketLink : null,
      soldOut: /sold\s*out|uitverkocht/i.test(status),
      cancelled: /cancel|geannuleerd/i.test(status),
    });
  }
  return uit;
}


/**
 * Hun `publicGenre` naar onze categorie. Scheelt een enrich-call per
 * event, en bij 873 events is dat het verschil tussen een uur en een
 * paar minuten. Hun indeling is bovendien betrouwbaarder dan wat een
 * model uit een titel afleidt.
 */
export function categorieVanGenre(genre: string | null): 'Muziek' | 'Theater' | 'Lezing' {
  const g = (genre ?? '').toLowerCase();
  if (/comedy|familie/.test(g)) return 'Theater';
  if (/kennis|debat|zakelijk/.test(g)) return 'Lezing';
  // Pop / Rock, Klassiek, Jazz, Dance / By Night, Global, Anders en
  // leeg vallen onder Muziek — dit is in de eerste plaats een
  // concertzaal.
  return 'Muziek';
}
