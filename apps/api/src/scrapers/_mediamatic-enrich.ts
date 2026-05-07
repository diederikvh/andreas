/**
 * Mediamatic-website enrichment. Stager geeft voor mediamatic.stager.co
 * alleen de schedule (eventId, name, startsOn, endsOn) — geen
 * description, geen image. Mediamatic houdt al die rijke content op
 * z'n eigen site (mediamatic.net) en linkt vanuit elke detail-pagina
 * naar de bijbehorende Stager events via een "Tickets"-knop.
 *
 * Strategie:
 *   1. Crawl een handjevol overzichtspagina's voor detail-URLs
 *   2. Per detail-pagina: fetch HTML, extract og:title/description/image
 *      én alle Stager event-ids uit de "Tickets"-links
 *   3. Bouw een map stagerEventId → { content, sourceUrl }
 *
 * Dit laat de Stager-scraper zien welke events bij dezelfde Mediamatic-
 * pagina horen → recurring grouping per parent-page.
 */

const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const BASE = 'https://www.mediamatic.net';

const LIST_PAGES = [
  '/en/events',
  '/en/workshopcalendar',
  '/en/exhibitions-to-see',
];

export type MediamaticContent = {
  title: string;
  description: string | null;
  imageUrl: string | null;
  sourceUrl: string;
};

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name] ?? m);
}

function extractOg(html: string, prop: string): string | null {
  const re = new RegExp(
    `<meta[^>]*property=["']og:${prop}["'][^>]*content=["']([^"']+)["']`,
    'i'
  );
  const m = html.match(re);
  return m ? decodeEntities(m[1]) : null;
}

function extractStagerEventIds(html: string): number[] {
  const re = /stager\.co\/shop\/default\/events\/(\d+)/g;
  const ids = new Set<number>();
  for (const m of html.matchAll(re)) {
    ids.add(parseInt(m[1], 10));
  }
  return Array.from(ids);
}

/** Probeer de hoofdtekst uit de page-body te extracten — `<div
 *  class="summary">` op Mediamatic bevat de richer description (1-3
 *  paragrafen) i.p.v. de 150-char og:description. Strip tags + de
 *  trailing "Tickets"-link tekst. */
function extractBody(html: string): string | null {
  const m = html.match(/<div class="summary">([\s\S]+?)<\/div>\s*<\/div>/);
  if (!m) return null;
  // Vervang <p>, <br> door newlines voor paragraph-breaks
  let body = m[1]
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n');
  // Strip alle overige tags
  body = body.replace(/<[^>]+>/g, ' ');
  body = decodeEntities(body);
  // Multi-space + leading/trailing
  body = body.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  // Verwijder "Tickets" boilerplate aan het eind
  body = body.replace(/\s*Tickets\s*$/i, '').trim();
  return body || null;
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

async function discoverDetailUrls(): Promise<string[]> {
  const urls = new Set<string>();
  for (const path of LIST_PAGES) {
    const html = await fetchHtml(BASE + path);
    if (!html) continue;
    for (const m of html.matchAll(/href="(\/en\/page\/\d+\/[^"]+)"/g)) {
      // Filter nav-pagina's met overduidelijke generieke slugs
      const slug = m[1];
      if (
        slug.endsWith('/about-mediamatic') ||
        slug.endsWith('/colofon') ||
        slug.endsWith('/people') ||
        slug.includes('/jobs')
      ) {
        continue;
      }
      urls.add(BASE + slug);
    }
  }
  return Array.from(urls);
}

/**
 * Bouw de map stagerEventId → MediamaticContent. Pages zonder Stager-
 * link (info-pagina's, oude exhibitions) worden geskipt.
 */
export async function fetchMediamaticContent(): Promise<
  Map<number, MediamaticContent>
> {
  const detailUrls = await discoverDetailUrls();
  const result = new Map<number, MediamaticContent>();

  for (const url of detailUrls) {
    const html = await fetchHtml(url);
    if (!html) continue;
    const stagerIds = extractStagerEventIds(html);
    if (stagerIds.length === 0) continue;

    const title = extractOg(html, 'title')?.replace(/ - Mediamatic$/, '') ?? '';
    const description = extractBody(html) ?? extractOg(html, 'description');
    const imageUrl = extractOg(html, 'image');

    const content: MediamaticContent = {
      title,
      description,
      imageUrl,
      sourceUrl: url,
    };
    for (const sid of stagerIds) {
      // Eerste page wint — soms link je vanuit een lijst-pagina, maar
      // de detail-pagina heeft de actuele data.
      if (!result.has(sid)) result.set(sid, content);
    }
  }
  return result;
}
