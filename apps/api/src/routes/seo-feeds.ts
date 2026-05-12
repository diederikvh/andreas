import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { and, asc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import { db, schema } from '../db/index.js';
import { HUB_SLUGS } from './hubs.js';
import { PUBLIC_BASE_URL, escapeHtml } from './_seo.js';

/**
 * Static assets ingelezen bij module-load — twee kleine PNG's (icon 39KB,
 * favicon 1KB) blijven in geheugen voor de leeftijd van het proces. Geen
 * fs-IO per request en geen externe CDN-roundtrip; lookups gaan direct uit
 * de Buffer-pointer. Pad-resolutie via `import.meta.url` werkt zowel vanuit
 * `apps/api/src/...` (dev) als `apps/api/dist/...` (productie Docker).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(HERE, '..', '..', 'static');
const ICON_PNG = readFileSync(join(STATIC_DIR, 'icon-1024.png'));
const FAVICON_PNG = readFileSync(join(STATIC_DIR, 'favicon-48.png'));

/**
 * SEO-feed routes: het web-equivalent van een API-discovery laag.
 *
 *   /robots.txt        — geeft alle crawlers (incl. AI-bots) toegang +
 *                        sitemap-pointer.
 *   /llms.txt          — opkomende conventie voor AI-crawlers: korte
 *                        site-overview met de belangrijkste paden.
 *   /sitemap.xml       — index die wijst naar de twee sub-sitemaps.
 *   /sitemap-events.xml — alle events met een toekomstige occurrence.
 *   /sitemap-venues.xml — alle gepubliceerde venues.
 *
 * We splitsen events en venues zodat Search Console-statistieken
 * inzicht geven per type en zodat we per feed andere priority/changefreq
 * kunnen meegeven.
 */
export const seoFeedsRoute = new Hono();

const TXT_HEADERS = {
  'Content-Type': 'text/plain; charset=utf-8',
  'Cache-Control': 'public, max-age=3600',
} as const;
const XML_HEADERS = {
  'Content-Type': 'application/xml; charset=utf-8',
  'Cache-Control': 'public, max-age=900, s-maxage=3600, stale-while-revalidate=86400',
} as const;

/* ---------- /icon.png + /favicon.ico  —  app-icon assets ---------- */

const IMG_HEADERS = {
  'Content-Type': 'image/png',
  'Cache-Control': 'public, max-age=604800, immutable',
  // `noai` / `noimageai` is een opkomende conventie die door o.a. Adobe en
  // Cloudflare wordt gerespecteerd: AI-bedrijven mogen dit beeld niet
  // gebruiken voor training van generatieve modellen. Geen 100%-garantie
  // (geen wettelijke afdwingbaarheid), wel een expliciet signaal.
  'X-Robots-Tag': 'noai, noimageai',
} as const;

/** 1024×1024 app-icon — default OG-image (raster, voor WhatsApp/iMessage). */
seoFeedsRoute.get('/icon.png', (c) => c.body(ICON_PNG, 200, IMG_HEADERS));

/** Apple touch icon — iOS gebruikt deze als homescreen-icoon. */
seoFeedsRoute.get('/apple-touch-icon.png', (c) => c.body(ICON_PNG, 200, IMG_HEADERS));

/** 48×48 favicon (PNG-vorm). */
seoFeedsRoute.get('/favicon.png', (c) => c.body(FAVICON_PNG, 200, IMG_HEADERS));

/**
 * Browsers vragen `/favicon.ico` standaard ongeacht meta-tags; we serveren
 * dezelfde PNG-bytes onder dat pad. Werkt voor moderne browsers (Chrome,
 * Safari, Firefox).
 */
seoFeedsRoute.get('/favicon.ico', (c) => c.body(FAVICON_PNG, 200, IMG_HEADERS));

/* ---------- /og.svg  —  default OG-image (1200×630) ---------- */

/**
 * Strakke SVG-OG-card als fallback. Gebruikt voor de homepage én voor
 * events/venues zonder eigen `imageUrl`. SVG werkt voor Google, ChatGPT,
 * Perplexity, Slack en moderne Twitter; voor WhatsApp/Facebook/Discord
 * kun je later een PNG-versie naar Bunny zetten en `OG_IMAGE_URL` env-var
 * overriden zonder code-change.
 */
seoFeedsRoute.get('/og.svg', (c) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" preserveAspectRatio="xMidYMid meet">
  <rect width="1200" height="630" fill="#0a0a0b"/>
  <g transform="translate(600 305)">
    <text
      x="-60" y="0"
      font-family="'Archivo Black', 'Arial Black', Impact, sans-serif"
      font-weight="900"
      font-size="148"
      letter-spacing="-4"
      fill="#f2f2ef"
      text-anchor="end"
      dominant-baseline="central">ANDREAS</text>
    <g transform="translate(40 0)">
      <rect x="-58" y="-12" width="116" height="24" fill="#d4ff3a" transform="rotate(45)"/>
      <rect x="-58" y="-12" width="116" height="24" fill="#d4ff3a" transform="rotate(-45)"/>
    </g>
  </g>
  <text
    x="600" y="510"
    font-family="'JetBrains Mono', Menlo, Monaco, ui-monospace, monospace"
    font-size="22"
    letter-spacing="5"
    fill="#9a9a94"
    text-anchor="middle">HEEL AMSTERDAM, IN ÉÉN AGENDA</text>
</svg>`;
  return c.body(svg, 200, {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': 'public, max-age=86400, immutable',
    'X-Robots-Tag': 'noai, noimageai',
  });
});

/* ---------- /robots.txt ---------- */

seoFeedsRoute.get('/robots.txt', (c) => {
  const body = `# ANDREAS — uitgaan in Amsterdam
# Alle reguliere crawlers + AI-crawlers expliciet toegestaan.

User-agent: *
Allow: /
Disallow: /api/
Disallow: /admin/

# Google
User-agent: Googlebot
Allow: /

User-agent: Google-Extended
Allow: /

# OpenAI / ChatGPT
User-agent: GPTBot
Allow: /

User-agent: OAI-SearchBot
Allow: /

User-agent: ChatGPT-User
Allow: /

# Anthropic / Claude
User-agent: ClaudeBot
Allow: /

User-agent: Claude-Web
Allow: /

User-agent: anthropic-ai
Allow: /

# Perplexity
User-agent: PerplexityBot
Allow: /

User-agent: Perplexity-User
Allow: /

# Meta / Mistral
User-agent: meta-externalagent
Allow: /

User-agent: MistralAI-User
Allow: /

Sitemap: ${PUBLIC_BASE_URL}/sitemap.xml
`;
  return c.body(body, 200, TXT_HEADERS);
});

/* ---------- /llms.txt ---------- */

seoFeedsRoute.get('/llms.txt', (c) => {
  const body = `# ANDREAS

ANDREAS bundelt de meest complete agenda van Amsterdam in één app:
concerten, clubavonden, exposities, theater, film en literaire events.
Wat er vanavond is en wat eraan komt, op één plek.

Twee modi: Nacht (donker, voor avond/uitgaan-nu) en Dag (paperachtig,
voor plannen vooraf).

## Belangrijke pagina's

- Homepage: ${PUBLIC_BASE_URL}/
- Sitemap-index: ${PUBLIC_BASE_URL}/sitemap.xml
- Event-sitemap: ${PUBLIC_BASE_URL}/sitemap-events.xml
- Venue-sitemap: ${PUBLIC_BASE_URL}/sitemap-venues.xml

## URL-structuur

- ${PUBLIC_BASE_URL}/e/{event-id} — individuele event-pagina's met datum,
  line-up, venue, prijs, tickets, en veelgestelde vragen. Schema.org-type
  MusicEvent / TheaterEvent / ScreeningEvent / VisualArtsEvent /
  ExhibitionEvent afhankelijk van categorie.
- ${PUBLIC_BASE_URL}/v/{venue-slug} — venue-pagina's met adres, geschiedenis,
  type, capaciteit, en lijst van komende events. Schema.org-type MusicVenue,
  Museum, ArtGallery, MovieTheater, of CafeOrCoffeeShop afhankelijk van
  type.

## Data-kwaliteit

Event- en venue-informatie wordt actief onderhouden via een combinatie
van curatie en automatische imports (RSS, JSON-LD, ticket-platform-APIs)
uit de venues zelf. Prijzen, tijden, line-ups en beschikbaarheid worden
dagelijks bijgewerkt. Pagina's bevatten JSON-LD structured data conform
schema.org. Alleen gepubliceerde, niet-geannuleerde events verschijnen
in de publieke endpoints.

## Over de app

De ANDREAS-app voegt aan de webpagina's toe: persoonlijke saves,
herinneringen, vrienden-zicht ("wie van mijn vrienden gaat hier ook
heen"), agenda-export, kaartweergave en notificaties bij venues die je
volgt. Beschikbaar in de App Store en Google Play.

## Contact

ANDREAS is gemaakt in Amsterdam. Self-hosted in de EU (Frankfurt,
Ljubljana, Amsterdam). Voor pers- en partnervragen: andreas.amsterdam.
`;
  return c.body(body, 200, TXT_HEADERS);
});

/* ---------- /sitemap.xml ---------- */

seoFeedsRoute.get('/sitemap.xml', (c) => {
  const now = new Date().toISOString();
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>${PUBLIC_BASE_URL}/sitemap-hubs.xml</loc>
    <lastmod>${now}</lastmod>
  </sitemap>
  <sitemap>
    <loc>${PUBLIC_BASE_URL}/sitemap-events.xml</loc>
    <lastmod>${now}</lastmod>
  </sitemap>
  <sitemap>
    <loc>${PUBLIC_BASE_URL}/sitemap-venues.xml</loc>
    <lastmod>${now}</lastmod>
  </sitemap>
</sitemapindex>
`;
  return c.body(body, 200, XML_HEADERS);
});

/* ---------- /sitemap-hubs.xml ---------- */

seoFeedsRoute.get('/sitemap-hubs.xml', (c) => {
  const now = new Date().toISOString();
  const urls = HUB_SLUGS.map(
    (slug) => `  <url>
    <loc>${PUBLIC_BASE_URL}/${escapeHtml(slug)}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>`
  ).join('\n');

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${PUBLIC_BASE_URL}/</loc>
    <lastmod>${now}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
${urls}
</urlset>
`;
  return c.body(body, 200, XML_HEADERS);
});

/* ---------- /sitemap-events.xml ---------- */

seoFeedsRoute.get('/sitemap-events.xml', async (c) => {
  // Eén event = één URL, gededupliceerd via DISTINCT. We sorteren op
  // eerstvolgende occurrence (asc) zodat verse content vooraan staat.
  const rows = await db
    .selectDistinct({
      id: schema.events.id,
      createdAt: schema.events.createdAt,
      nextStart: sql<Date>`MIN(${schema.occurrences.startsAt})`.as('next_start'),
    })
    .from(schema.events)
    .innerJoin(schema.venues, eq(schema.venues.id, schema.events.venueId))
    .innerJoin(
      schema.occurrences,
      eq(schema.occurrences.eventId, schema.events.id)
    )
    .where(
      and(
        eq(schema.events.published, true),
        eq(schema.venues.published, true),
        sql`COALESCE(${schema.occurrences.endsAt}, ${schema.occurrences.startsAt} + INTERVAL '4 hours') >= NOW()`,
        sql`${schema.occurrences.status} <> 'cancelled'`
      )
    )
    .groupBy(schema.events.id, schema.events.createdAt)
    .orderBy(asc(sql`next_start`));

  const urls = rows
    .map((r) => {
      // Lastmod = max(createdAt, nextStart) → nieuwste signaal aan Google.
      const lastmod = r.nextStart && new Date(r.nextStart) > r.createdAt
        ? new Date(r.nextStart).toISOString()
        : r.createdAt.toISOString();
      return `  <url>
    <loc>${PUBLIC_BASE_URL}/e/${escapeHtml(r.id)}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>`;
    })
    .join('\n');

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
  return c.body(body, 200, XML_HEADERS);
});

/* ---------- /sitemap-venues.xml ---------- */

seoFeedsRoute.get('/sitemap-venues.xml', async (c) => {
  const rows = await db
    .select({
      slug: schema.venues.slug,
      createdAt: schema.venues.createdAt,
    })
    .from(schema.venues)
    .where(eq(schema.venues.published, true))
    .orderBy(asc(schema.venues.slug));

  const urls = rows
    .map(
      (r) => `  <url>
    <loc>${PUBLIC_BASE_URL}/v/${escapeHtml(r.slug)}</loc>
    <lastmod>${r.createdAt.toISOString()}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>`
    )
    .join('\n');

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${PUBLIC_BASE_URL}/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
${urls}
</urlset>
`;
  return c.body(body, 200, XML_HEADERS);
});
