import { and, asc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import { db, schema } from '../db/index.js';
import {
  LIST_STYLES,
  OG_IMAGE_URL,
  PAGE_GRID_STYLES,
  PUBLIC_BASE_URL,
  SEO_STYLES,
  breadcrumbJsonLd,
  escapeHtml,
  eventSchemaType,
  formatShort,
  jsonLd,
  renderAppBanner,
  renderCtaCard,
  renderEventMeta,
  renderFeaturedCard,
  renderMobileStickyCta,
  renderSiteFooter,
  renderSiteScripts,
  renderThumb,
  venueTypeLabel,
} from './_seo.js';

/**
 * Hub-pagina's (topical landing pages) voor SEO/GEO. Doel: pakken
 * long-tail searches die niet door event-detail pagina's worden
 * bediend — "concerten amsterdam vanavond", "techno amsterdam",
 * "exposities deze week", "clubs amsterdam".
 *
 * Strategie:
 *   • Categorie-hubs (5) — `/muziek`, `/theater`, `/film`, `/kunst`,
 *     `/literatuur`. Filter op `events.category`.
 *   • Venue-type-hubs (5) — `/clubs`, `/musea`, `/podia`, `/filmhuizen`,
 *     `/galeries`. Filter op `venues.type`.
 *   • Tijd-hubs (2) — `/vandaag`, `/dit-weekend`. Filter op
 *     `occurrences.startsAt`-range.
 *
 * Elke hub heeft een eigen H1, intro-paragraaf en JSON-LD ItemList +
 * BreadcrumbList. Geen thin content. Lijst-styling is identiek aan
 * de homepage via `LIST_STYLES` — consistente UX over hubs heen.
 */
export const hubsRoute = new Hono();

/* ============================================================
 * Hub-configuratie
 * ============================================================ */

type HubKind = 'category' | 'venueType' | 'today' | 'weekend';

type HubConfig = {
  slug: string;
  /** Korte H1-titel. */
  title: string;
  /** `<title>` voor de browser-tab (max ~60 chars aanbevolen). */
  pageTitle: string;
  /** `<meta name="description">` (max 160 chars). */
  description: string;
  /** Intro-paragraaf onder de H1. HTML toegestaan (alleen `<strong>`). */
  intro: string;
  /**
   * H2 boven de venues-sectie. Specifiek per hub om de redundantie met
   * de h1 te vermijden én Google een extra keyword-signaal te geven
   * ("Musea & galeries in Amsterdam" als h2 ranked aparte queries).
   */
  venuesHeading: string;
  /** Bepaalt welke filter we toepassen op de events-query. */
  kind: HubKind;
  /** Voor kind=category: de event-categorie. */
  category?: 'Muziek' | 'Theater' | 'Literatuur' | 'Film' | 'Kunst' | 'Lezing';
  /** Voor kind=venueType: het venue-type. */
  venueType?: 'club' | 'museum' | 'podium' | 'film' | 'galerie';
  /** Optioneel: alleen events met deze kind. Default: alle. */
  eventKind?: 'show' | 'exhibition';
};

const HUBS: HubConfig[] = [
  // --- Categorie ---
  {
    slug: 'muziek',
    title: 'Muziek in Amsterdam',
    pageTitle: 'Muziek in Amsterdam — concerten, clubs, festivals | ANDREAS',
    description:
      'Concerten, clubavonden, festivals en livemuziek in Amsterdam. Komende events in Paradiso, Melkweg, OT301, OCCII, Concertgebouw, Bimhuis en meer.',
    intro:
      'Alle muziek-events in Amsterdam — van <strong>techno-nachten</strong> in OT301 tot <strong>klassieke concerten</strong> in het Concertgebouw, festivals in Paradiso en jazz in het Bimhuis. Iedere avond een keuze.',
    venuesHeading: 'Muziek-venues in Amsterdam',
    kind: 'category',
    category: 'Muziek',
  },
  {
    slug: 'theater',
    title: 'Theater in Amsterdam',
    pageTitle: 'Theater in Amsterdam — voorstellingen, dans, cabaret | ANDREAS',
    description:
      'Theatervoorstellingen, dans, cabaret en muziektheater in Amsterdam. Komende programma in Carré, DeLaMar, ITA, Meervaart, Frascati en meer.',
    intro:
      'Alle <strong>theater-voorstellingen</strong> in Amsterdam — toneel, dans, cabaret en muziektheater op de podia van Carré, DeLaMar, ITA, Frascati, de Meervaart en alle andere zalen van de stad.',
    venuesHeading: 'Theater-podia in Amsterdam',
    kind: 'category',
    category: 'Theater',
  },
  {
    slug: 'film',
    title: 'Film in Amsterdam',
    pageTitle: 'Film in Amsterdam — filmhuizen, premières, retrospectives | ANDREAS',
    description:
      'Filmvoorstellingen, premières en retrospectives in Amsterdamse filmhuizen. EYE, Lab111, FilmHallen, Kriterion, The Movies en meer.',
    intro:
      'Alle <strong>filmvoorstellingen</strong> in Amsterdam — premières, retrospectives en arthouse in EYE, FilmHallen, Lab111, Kriterion, The Movies en andere filmhuizen.',
    venuesHeading: 'Filmhuizen in Amsterdam',
    kind: 'category',
    category: 'Film',
  },
  {
    slug: 'kunst',
    title: 'Kunst in Amsterdam',
    pageTitle: 'Kunst in Amsterdam — exposities en openingen | ANDREAS',
    description:
      'Exposities, openingen en kunstevents in Amsterdam. Stedelijk Museum, Rijksmuseum, FOAM, W139, galeries en kunstenaarsinitiatieven.',
    intro:
      'Alle <strong>kunst-exposities</strong> en openingen in Amsterdam — van het Stedelijk, Rijksmuseum en FOAM tot W139, galeries en artist-run spaces in de hele stad.',
    venuesHeading: 'Musea & galeries in Amsterdam',
    kind: 'category',
    category: 'Kunst',
  },
  {
    slug: 'literatuur',
    title: 'Literatuur in Amsterdam',
    pageTitle: 'Literatuur in Amsterdam — boekpresentaties, lezingen | ANDREAS',
    description:
      'Boekpresentaties, lezingen, poëzieavonden en literaire events in Amsterdam. Spui25, Athenaeum, Perdu, De Roode Bioscoop en meer.',
    intro:
      'Alle <strong>literaire events</strong> in Amsterdam — boekpresentaties, lezingen, poëzieavonden en debatten bij Spui25, Perdu, Athenaeum en de andere literaire plekken van de stad.',
    venuesHeading: 'Literaire plekken in Amsterdam',
    kind: 'category',
    category: 'Literatuur',
  },
  // --- Venue-type ---
  {
    slug: 'clubs',
    title: 'Clubs in Amsterdam',
    pageTitle: 'Clubs in Amsterdam — komende avonden | ANDREAS',
    description:
      'Komende clubavonden in Amsterdam. Techno, house, hip-hop en disco in Shelter, RADION, BRET, Sissi\'s, Garage Noord, Skatecafe, OT301 en meer.',
    intro:
      'Komende <strong>clubavonden in Amsterdam</strong> — techno, house, hip-hop, disco en alles ertussen, in de clubs en kelders die de stad vannacht draaiend houden.',
    venuesHeading: 'Alle clubs in Amsterdam',
    kind: 'venueType',
    venueType: 'club',
    eventKind: 'show',
  },
  {
    slug: 'musea',
    title: 'Musea in Amsterdam',
    pageTitle: 'Musea in Amsterdam — lopende exposities | ANDREAS',
    description:
      'Lopende exposities in Amsterdamse musea. Stedelijk, Rijksmuseum, Van Gogh, FOAM, Stedelijk, Hermitage, Joods Museum en meer.',
    intro:
      'Lopende <strong>exposities in de Amsterdamse musea</strong> — Stedelijk, Rijksmuseum, Van Gogh, FOAM, Hermitage en alle andere grote en kleine musea die de stad rijk is.',
    venuesHeading: 'Alle musea in Amsterdam',
    kind: 'venueType',
    venueType: 'museum',
  },
  {
    slug: 'podia',
    title: 'Podia in Amsterdam',
    pageTitle: 'Podia in Amsterdam — concerten en voorstellingen | ANDREAS',
    description:
      'Komende concerten en voorstellingen op Amsterdamse podia. Paradiso, Melkweg, Concertgebouw, Bimhuis, Q-Factory, Sugarfactory en meer.',
    intro:
      'Komende <strong>concerten en voorstellingen op de Amsterdamse podia</strong> — van Paradiso en Melkweg tot Concertgebouw, Bimhuis, Q-Factory en Sugarfactory.',
    venuesHeading: 'Alle podia in Amsterdam',
    kind: 'venueType',
    venueType: 'podium',
    eventKind: 'show',
  },
  {
    slug: 'filmhuizen',
    title: 'Filmhuizen in Amsterdam',
    pageTitle: 'Filmhuizen in Amsterdam — komende screenings | ANDREAS',
    description:
      'Komende filmvoorstellingen in Amsterdamse filmhuizen. EYE, Lab111, FilmHallen, Kriterion, The Movies, De Uitkijk, Cinecenter.',
    intro:
      'Komende <strong>filmvoorstellingen in de Amsterdamse filmhuizen</strong> — EYE, FilmHallen, Lab111, Kriterion, The Movies, De Uitkijk en de andere arthouse-zalen.',
    venuesHeading: 'Alle filmhuizen in Amsterdam',
    kind: 'venueType',
    venueType: 'film',
    eventKind: 'show',
  },
  {
    slug: 'galeries',
    title: 'Galeries in Amsterdam',
    pageTitle: 'Galeries in Amsterdam — lopende exposities | ANDREAS',
    description:
      'Lopende exposities in Amsterdamse galeries. Annet Gelink, AKINCI, Andriesse Eyck, Tegenboschvanvreden en tientallen meer.',
    intro:
      'Lopende <strong>exposities in de Amsterdamse galeries</strong> — van gevestigde namen als Annet Gelink en AKINCI tot artist-run spaces en project spaces, de hele scene op één plek.',
    venuesHeading: 'Alle galeries in Amsterdam',
    kind: 'venueType',
    venueType: 'galerie',
  },
  // --- Tijd ---
  {
    slug: 'vandaag',
    title: 'Vandaag in Amsterdam',
    pageTitle: 'Vandaag in Amsterdam — wat te doen | ANDREAS',
    description:
      'Wat te doen vandaag in Amsterdam. Concerten, clubs, theater, film en exposities — alles wat vandaag in de stad gebeurt.',
    intro:
      'Alles wat <strong>vandaag in Amsterdam</strong> gebeurt — concerten, clubs, theater, film en openingen. Eén lijst van alle events die nu draaien of vannacht starten.',
    venuesHeading: 'Venues actief vandaag',
    kind: 'today',
  },
  {
    slug: 'dit-weekend',
    title: 'Dit weekend in Amsterdam',
    pageTitle: 'Dit weekend in Amsterdam — uitgaan & cultuur | ANDREAS',
    description:
      'Wat te doen dit weekend in Amsterdam. Concerten, clubs, theater, film, exposities en festivals — vrijdag, zaterdag en zondag.',
    intro:
      'Alles wat <strong>dit weekend in Amsterdam</strong> te beleven valt — van vrijdagavond tot en met zondagnacht. Concerten, clubs, theater, film en openingen, op één plek.',
    venuesHeading: 'Venues actief dit weekend',
    kind: 'weekend',
  },
];

/* ============================================================
 * Helper: bouw query-conditions per hub-type
 * ============================================================ */

function buildHubConditions(hub: HubConfig) {
  const baseConditions = [
    eq(schema.events.published, true),
    eq(schema.venues.published, true),
    sql`${schema.occurrences.status} <> 'cancelled'`,
  ];

  // Time-range bepalen voor today/weekend hubs (Europe/Amsterdam timezone
  // wordt aangehouden via Postgres `AT TIME ZONE`).
  if (hub.kind === 'today') {
    // Vandaag: van NU tot middernacht Amsterdam-tijd. Houdt ook events die
    // net begonnen zijn nog 4u zichtbaar.
    baseConditions.push(
      sql`${schema.occurrences.startsAt} + INTERVAL '4 hours' >= NOW()`,
      sql`${schema.occurrences.startsAt} <
          (DATE_TRUNC('day', NOW() AT TIME ZONE 'Europe/Amsterdam')
            + INTERVAL '1 day') AT TIME ZONE 'Europe/Amsterdam'`
    );
  } else if (hub.kind === 'weekend') {
    // Weekend = van vrijdag 18:00 t/m zondag 23:59 (Europe/Amsterdam).
    // Berekend t.o.v. de aankomende vrijdag. Als 't al in het weekend is,
    // pak het lopende weekend.
    baseConditions.push(
      sql`${schema.occurrences.startsAt} >=
          (DATE_TRUNC('week', NOW() AT TIME ZONE 'Europe/Amsterdam')
            + INTERVAL '4 days 18 hours') AT TIME ZONE 'Europe/Amsterdam'`,
      sql`${schema.occurrences.startsAt} <
          (DATE_TRUNC('week', NOW() AT TIME ZONE 'Europe/Amsterdam')
            + INTERVAL '7 days') AT TIME ZONE 'Europe/Amsterdam'`
    );
  } else {
    // Category/venueType hubs: alleen "nu of in de toekomst", met 4u buffer
    // voor net-gestarte shows.
    baseConditions.push(
      sql`COALESCE(${schema.occurrences.endsAt}, ${schema.occurrences.startsAt} + INTERVAL '4 hours') >= NOW()`
    );
  }

  if (hub.category) {
    baseConditions.push(eq(schema.events.category, hub.category));
  }
  if (hub.venueType) {
    baseConditions.push(eq(schema.venues.type, hub.venueType));
  }
  if (hub.eventKind) {
    baseConditions.push(eq(schema.events.kind, hub.eventKind));
  }

  return baseConditions;
}

/* ============================================================
 * Pagina-renderer
 * ============================================================ */

type EventRow = {
  eventId: string;
  title: string;
  kind: 'show' | 'exhibition';
  category: 'Muziek' | 'Theater' | 'Literatuur' | 'Film' | 'Kunst' | 'Lezing';
  genres: string[];
  imageUrl: string | null;
  startsAt: Date;
  endsAt: Date | null;
  venueName: string;
  venueSlug: string;
  venueWijk: string | null;
  venueType:
    | 'galerie' | 'museum' | 'podium' | 'club' | 'film'
    | 'ruimte' | 'boekhandel-cafe' | null;
};

type VenueRow = {
  slug: string;
  name: string;
  wijk: string | null;
  type: EventRow['venueType'];
  imageUrl: string | null;
};

/**
 * Tijd-hubs (vandaag/dit-weekend) groeperen de events in herkenbare
 * clusters: muziek-op-podia, muziek-in-clubs, theater, film, kunst,
 * literatuur, lezing. "Muziek elders" vangt muziek-events op locaties
 * die geen podium of club zijn (musea, ruimtes, boekhandels).
 *
 * Volgorde is bewust: muziek eerst (grootste catalogus + meest gezocht),
 * dan podium-arts, film, beeldende kunst, en pas daarna literatuur +
 * lezing als kleinere clusters. Lege groepen vallen weg.
 */
function groupEventsByType(
  events: EventRow[]
): Array<{ key: string; heading: string; events: EventRow[] }> {
  const buckets: Record<string, { key: string; heading: string; events: EventRow[] }> = {};
  const ensure = (key: string, heading: string) => {
    if (!buckets[key]) buckets[key] = { key, heading, events: [] };
    return buckets[key];
  };
  for (const e of events) {
    if (e.category === 'Muziek') {
      if (e.venueType === 'podium') ensure('music-podium', 'Muziek op de podia').events.push(e);
      else if (e.venueType === 'club') ensure('music-club', 'Muziek in de clubs').events.push(e);
      else ensure('music-other', 'Muziek elders').events.push(e);
    } else if (e.category === 'Theater') ensure('theater', 'Theater').events.push(e);
    else if (e.category === 'Film') ensure('film', 'Film').events.push(e);
    else if (e.category === 'Kunst') ensure('kunst', 'Kunst').events.push(e);
    else if (e.category === 'Literatuur') ensure('literatuur', 'Literatuur').events.push(e);
    else if (e.category === 'Lezing') ensure('lezing', 'Lezing').events.push(e);
  }
  const order = [
    'music-podium',
    'music-club',
    'music-other',
    'theater',
    'film',
    'kunst',
    'literatuur',
    'lezing',
  ];
  return order.map((k) => buckets[k]).filter((g): g is { key: string; heading: string; events: EventRow[] } => Boolean(g));
}

function formatRowWhen(e: EventRow): string {
  if (e.kind === 'exhibition' && e.endsAt) {
    return `t/m ${e.endsAt.toLocaleDateString('nl-NL', {
      day: 'numeric',
      month: 'short',
      timeZone: 'Europe/Amsterdam',
    })}`;
  }
  return formatShort(e.startsAt);
}

function renderHubPage(
  hub: HubConfig,
  events: EventRow[],
  venues: VenueRow[]
): string {
  const canonical = `${PUBLIC_BASE_URL}/${hub.slug}`;

  // JSON-LD: CollectionPage + ItemList + Breadcrumb. CollectionPage zegt
  // Google "dit is een lijst-pagina"; ItemList geeft de URLs structuurd.
  const collectionLd = jsonLd({
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: hub.title,
    description: hub.description,
    url: canonical,
    isPartOf: {
      '@type': 'WebSite',
      name: 'ANDREAS',
      url: PUBLIC_BASE_URL,
    },
    mainEntity: {
      '@type': 'ItemList',
      name: hub.title,
      numberOfItems: events.length,
      itemListElement: events.map((e, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        url: `${PUBLIC_BASE_URL}/e/${e.eventId}`,
        name: e.title,
      })),
    },
  });

  const breadcrumb = breadcrumbJsonLd([
    { name: 'ANDREAS', path: '/' },
    { name: hub.title, path: `/${hub.slug}` },
  ]);

  const HUB_FEATURED = 2;

  const renderEventListItem = (e: EventRow) => `<li>
        <a class="row-link" href="/e/${escapeHtml(e.eventId)}">
          ${renderThumb(e.imageUrl, e.title)}
          <span class="row-text">
            <span class="when">${escapeHtml(formatRowWhen(e))}</span>
            <span class="title">${escapeHtml(e.title)}</span>
            <span class="meta">${renderEventMeta(e.venueName, e.genres)}</span>
          </span>
        </a>
      </li>`;

  const renderEventFeatured = (e: EventRow) =>
    renderFeaturedCard({
      href: `/e/${e.eventId}`,
      imageUrl: e.imageUrl,
      when: formatRowWhen(e),
      title: e.title,
      meta: renderEventMeta(e.venueName, e.genres),
    });

  /** Render één event-cluster: section-head + featured + (optioneel)
   *  rest als compacte lijst. Met `allCards: true` worden alle items
   *  als featured-card getoond — gebruikt op vandaag/dit-weekend waar
   *  visuele rijkdom belangrijker is dan compactheid. */
  const renderEventSection = (
    heading: string,
    group: EventRow[],
    allCards = false
  ) => {
    const cardsList = allCards ? group : group.slice(0, HUB_FEATURED);
    const featured = cardsList.map(renderEventFeatured).join('\n      ');
    const rest = allCards
      ? ''
      : group.slice(HUB_FEATURED).map(renderEventListItem).join('\n        ');
    return `
      <section>
        <div class="section-head">
          <h2>${escapeHtml(heading)}</h2>
          <span class="count">${group.length} ${group.length === 1 ? 'event' : 'events'}</span>
        </div>
        ${featured ? `<div class="featured-grid">${featured}</div>` : ''}
        ${rest ? `<ul class="lines">
          ${rest}
        </ul>` : ''}
      </section>
    `;
  };

  // Voor tijd-hubs (vandaag/dit-weekend) groeperen we de events naar
  // type — muziek-op-podia, muziek-in-clubs, theater, film, kunst,
  // literatuur, lezing. Voor categorie/venue-type hubs heeft één lijst
  // volstaan (die was al gefilterd op het thema).
  const isTimeHub = hub.kind === 'today' || hub.kind === 'weekend';
  let mainEventsHtml = '';
  if (events.length === 0) {
    mainEventsHtml = '';
  } else if (isTimeHub) {
    const groups = groupEventsByType(events);
    mainEventsHtml = groups
      .map((g) => renderEventSection(g.heading, g.events, true))
      .join('\n');
  } else {
    // Flat: featured + rest binnen één impliciete sectie (geen h2 want
    // de hub-h1 dekt de lading al).
    const featured = events.slice(0, HUB_FEATURED).map(renderEventFeatured).join('\n      ');
    const rest = events.slice(HUB_FEATURED).map(renderEventListItem).join('\n        ');
    mainEventsHtml = `${featured ? `<div class="featured-grid">${featured}</div>` : ''}
        ${rest ? `<ul class="lines">
          ${rest}
        </ul>` : ''}`;
  }

  const renderVenueCard = (v: VenueRow) => {
    const label = venueTypeLabel(v.type);
    const meta = [label, v.wijk]
      .filter(Boolean)
      .map((s) => escapeHtml(String(s)))
      .join(' · ');
    const imgHtml = v.imageUrl
      ? `<img class="venue-card-img" src="${escapeHtml(v.imageUrl)}" alt="${escapeHtml(v.name)}" loading="lazy" />`
      : `<span class="venue-card-img venue-card-img-placeholder" aria-hidden="true"></span>`;
    return `<a class="venue-card" href="/v/${escapeHtml(v.slug)}">
        <span class="venue-card-img-wrap">${imgHtml}</span>
        <span class="venue-card-body">
          <span class="venue-card-title">${escapeHtml(v.name)}</span>
          <span class="venue-card-meta">${meta}</span>
        </span>
      </a>`;
  };

  const venuesHtml = venues
    .map((v) => {
      const label = venueTypeLabel(v.type);
      const meta = [label, v.wijk]
        .filter(Boolean)
        .map((s) => escapeHtml(String(s)))
        .join(' · ');
      return `<li>
        <a class="row-link" href="/v/${escapeHtml(v.slug)}">
          <span class="row-text">
            <span class="title">${escapeHtml(v.name)}</span>
            <span class="meta">${meta}</span>
          </span>
        </a>
      </li>`;
    })
    .join('\n        ');

  const venuesGridHtml = venues.map(renderVenueCard).join('\n        ');

  // JSON-LD voor de venues-sectie — een tweede ItemList. Helpt AI-engines
  // zien dat deze hub-pagina ook een venue-cluster is, niet alleen events.
  const venuesListLd =
    venues.length > 0
      ? jsonLd({
          '@context': 'https://schema.org',
          '@type': 'ItemList',
          name: `Venues op ${hub.title.toLowerCase()}`,
          numberOfItems: venues.length,
          itemListElement: venues.map((v, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            url: `${PUBLIC_BASE_URL}/v/${v.slug}`,
            name: v.name,
          })),
        })
      : null;

  const emptyState =
    events.length === 0
      ? `<p class="empty">Op dit moment staan er geen events gepland voor ${escapeHtml(hub.title.toLowerCase())}. Kijk later opnieuw of <a href="/">bekijk alle komende events</a>.</p>`
      : '';

  return `<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(hub.pageTitle)}</title>
  <meta name="description" content="${escapeHtml(hub.description)}" />
  <link rel="canonical" href="${canonical}" />
  <link rel="icon" type="image/png" sizes="16x16" href="${PUBLIC_BASE_URL}/favicon-16.png" />
  <link rel="icon" type="image/png" sizes="32x32" href="${PUBLIC_BASE_URL}/favicon-32.png" />
  <link rel="icon" type="image/png" sizes="48x48" href="${PUBLIC_BASE_URL}/favicon.png" />
  <link rel="apple-touch-icon" sizes="180x180" href="${PUBLIC_BASE_URL}/apple-touch-icon.png" />
  <meta name="theme-color" content="#0a0a0b" />
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1" />
  <meta name="googlebot" content="index, follow, max-image-preview:large" />
  <meta name="ai-content-declaration" content="no-ai-training" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="ANDREAS" />
  <meta property="og:locale" content="nl_NL" />
  <meta property="og:title" content="${escapeHtml(hub.title)}" />
  <meta property="og:description" content="${escapeHtml(hub.description)}" />
  <meta property="og:url" content="${canonical}" />
  <meta property="og:image" content="${escapeHtml(OG_IMAGE_URL)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:image" content="${escapeHtml(OG_IMAGE_URL)}" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;700;800;900&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <script type="application/ld+json">${collectionLd}</script>
  <script type="application/ld+json">${breadcrumb}</script>
  ${venuesListLd ? `<script type="application/ld+json">${venuesListLd}</script>` : ''}
  <style>
    ${SEO_STYLES}
    ${LIST_STYLES}
    /* Hub-specifiek: compactere hero (geen wordmark) — H1 staat centraal. */
    .hub-hero { margin: 8px 0 28px; }
    .hub-hero .kicker {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 11px; letter-spacing: 1.6px;
      text-transform: uppercase;
      color: var(--acid);
      margin: 0 0 12px;
    }
    .hub-hero h1 {
      font-family: 'Archivo', sans-serif; font-weight: 900;
      font-size: clamp(30px, 5vw, 44px);
      line-height: 1.02; letter-spacing: -1.2px;
      margin: 0 0 18px; color: var(--fg);
    }
    .hub-hero .intro {
      font-size: 16px; line-height: 1.55;
      color: var(--fg-read); margin: 0 0 8px;
      max-width: 620px;
    }
    .hub-hero .intro strong { color: var(--fg); font-weight: 700; }
    .hub-hero .count {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 11px; letter-spacing: 1.4px;
      text-transform: uppercase;
      color: var(--fg-faint);
      margin-top: 14px;
    }
    p.empty {
      padding: 24px;
      background: var(--bg-lift);
      border-radius: 12px;
      color: var(--fg-muted);
    }
    /* Tweede sectie-kop (voor venues onder de events). */
    .section-head {
      display: flex; align-items: baseline; gap: 18px;
      margin: 32px 0 16px;
      padding-top: 24px;
      border-top: 1px solid var(--border-soft);
    }
    .section-head h2 {
      font-family: 'Archivo', sans-serif; font-weight: 800;
      font-size: 22px; letter-spacing: -0.4px;
      margin: 0; color: var(--fg);
    }
    .section-head .count {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 11px; letter-spacing: 1.4px; text-transform: uppercase;
      color: var(--fg-faint); margin-left: auto;
    }
    ${PAGE_GRID_STYLES}
  </style>
</head>
<body class="has-sticky-cta">
  ${renderAppBanner('andreas://', hub.title)}
  ${renderMobileStickyCta('andreas://', hub.title)}
  <main>
    <nav class="breadcrumb" aria-label="Kruimelpad">
      <a href="/">ANDREAS</a><span>›</span>
      ${escapeHtml(hub.title)}
    </nav>
    <header class="hub-hero">
      <p class="kicker">Amsterdam</p>
      <h1>${escapeHtml(hub.title)}</h1>
      <p class="intro">${hub.intro}</p>
      <p class="count">${events.length} ${events.length === 1 ? 'event' : 'events'}</p>
    </header>
    <div class="page-grid">
      <div class="page-main">
        ${events.length > 0 ? mainEventsHtml : emptyState}
        ${
          venues.length > 0
            ? `<section>
          <div class="section-head">
            <h2>${escapeHtml(hub.venuesHeading)}</h2>
            <span class="count">${venues.length} ${venues.length === 1 ? 'venue' : 'venues'}</span>
          </div>
          ${isTimeHub
            ? `<div class="venues-grid">${venuesGridHtml}</div>`
            : `<ul class="lines">${venuesHtml}</ul>`}
        </section>`
            : ''
        }
      </div>
      <aside class="page-aside">
        ${renderCtaCard({
          // Generieke andreas:// deeplink — opent de app op de laatst-bezochte
          // view. Per-hub deeplinks (`andreas://agenda?category=Muziek`) zou
          // theoretisch beter zijn maar vereist een handler in de mobile app.
          deeplink: 'andreas://',
          title: `${hub.title} in de ANDREAS-app`,
          body: 'Sla op wat je interesseert, krijg herinneringen bij events die starten, en zie wat vrienden hebben gered.',
          qrUrl: `${PUBLIC_BASE_URL}/${hub.slug}`,
        })}
      </aside>
    </div>
    ${renderSiteFooter()}
  </main>
  ${renderSiteScripts()}
</body>
</html>`;
}

/* ============================================================
 * Route-registratie
 * ============================================================ */

// Legacy 301-redirect: /bioscopen → /filmhuizen. Hernoemd om beter aan
// te sluiten bij hoe de Amsterdamse arthouse-zalen zichzelf positioneren
// (filmhuis vs commerciële bioscoop). Permanent zodat Google de
// indexering verplaatst naar de nieuwe URL.
hubsRoute.get('/bioscopen', (c) => c.redirect('/filmhuizen', 301));

for (const hub of HUBS) {
  hubsRoute.get(`/${hub.slug}`, async (c) => {
    const conditions = buildHubConditions(hub);

    // Per occurrence: 1 rij. Dedupe later op event-ID zodat een wekelijks
    // feest niet 4x in de hub-lijst staat — eerste occurrence wint.
    const rows = await db
      .select({
        eventId: schema.events.id,
        title: schema.events.title,
        kind: schema.events.kind,
        category: schema.events.category,
        genres: schema.events.genres,
        imageUrl: schema.events.imageUrl,
        startsAt: schema.occurrences.startsAt,
        endsAt: schema.occurrences.endsAt,
        venueName: schema.venues.name,
        venueSlug: schema.venues.slug,
        venueWijk: schema.venues.wijk,
        venueType: schema.venues.type,
        venueImageUrl: schema.venues.imageUrl,
      })
      .from(schema.events)
      .innerJoin(schema.venues, eq(schema.venues.id, schema.events.venueId))
      .innerJoin(
        schema.occurrences,
        eq(schema.occurrences.eventId, schema.events.id)
      )
      .where(and(...conditions))
      .orderBy(
        hub.eventKind === 'exhibition'
          ? asc(schema.occurrences.endsAt)
          : asc(schema.occurrences.startsAt)
      )
      .limit(200);

    const seenEvents = new Set<string>();
    const events: EventRow[] = rows
      .filter((r) => {
        if (seenEvents.has(r.eventId)) return false;
        seenEvents.add(r.eventId);
        return true;
      })
      .slice(0, 50);

    // Venue-lijst per hub-type:
    //   • venue-type hubs (/clubs, /musea, …): ALLE venues van dat type uit
    //     de DB, ook zonder lopende events. Geeft volledig overzicht +
    //     maximum crawl-paths richting elke venue-detail-pagina.
    //   • andere hubs (/muziek, /vandaag, …): venues uit de gevonden events,
    //     gededupliceerd op slug. Schaalt automatisch met het hub-filter.
    let venues: VenueRow[];
    if (hub.kind === 'venueType' && hub.venueType) {
      const venueRows = await db
        .select({
          slug: schema.venues.slug,
          name: schema.venues.name,
          wijk: schema.venues.wijk,
          type: schema.venues.type,
          imageUrl: schema.venues.imageUrl,
        })
        .from(schema.venues)
        .where(
          and(
            eq(schema.venues.type, hub.venueType),
            eq(schema.venues.published, true)
          )
        )
        .orderBy(asc(schema.venues.name));
      venues = venueRows;
    } else {
      const seenVenues = new Set<string>();
      venues = rows
        .filter((r) => {
          if (seenVenues.has(r.venueSlug)) return false;
          seenVenues.add(r.venueSlug);
          return true;
        })
        .map((r) => ({
          slug: r.venueSlug,
          name: r.venueName,
          wijk: r.venueWijk,
          type: r.venueType,
          imageUrl: r.venueImageUrl,
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 40);
    }

    const html = renderHubPage(hub, events, venues);
    return c.body(html, 200, {
      'Content-Type': 'text/html; charset=utf-8',
      // Hubs zijn dynamische lijst-pagina's — kort genoeg om dagelijks
      // vers te zijn, lang genoeg om DB-druk te dempen.
      'Cache-Control':
        'public, max-age=600, s-maxage=1800, stale-while-revalidate=3600',
    });
  });
}

/** Export voor seo-feeds.ts om de sitemap-hubs.xml te bouwen. */
export const HUB_SLUGS = HUBS.map((h) => h.slug);
