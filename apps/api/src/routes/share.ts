import { and, asc, desc, eq, not, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import { db, schema } from '../db/index.js';
import {
  APP_STORE_URL,
  LIST_STYLES,
  OG_IMAGE_URL,
  PAGE_GRID_STYLES,
  PLAY_STORE_URL,
  PUBLIC_BASE_URL,
  breadcrumbJsonLd,
  escapeHtml,
  eventSchemaType,
  faqJsonLd,
  formatDateLong,
  formatPrice,
  formatRangeLong,
  formatShort,
  formatTime,
  jsonLd,
  renderAppBanner,
  renderCtaCard,
  renderEventMeta,
  renderHead,
  renderHeroImage,
  renderMobileStickyCta,
  renderSiteFooter,
  renderThumb,
  streetAddress,
  ticketDomain,
  venueSchemaType,
  venueTypeLabel,
} from './_seo.js';

/**
 * Publieke share-/web-routes:
 *
 *   • `/.well-known/apple-app-site-association` — Apple universal-link
 *     associatie. Niet aanraken bij UI/SEO-werk.
 *
 *   • `/e/:id` en `/v/:slug` — twee modi via querystring:
 *       - `?ref=…`  → minimal share-pagina + JS-redirect naar app/store
 *                     (iMessage/WhatsApp unfurler-pad, "ik kreeg dit
 *                     gedeeld" UX).
 *       - geen `?ref` → volledige SEO/GEO-pagina: JSON-LD, antwoord-
 *                       capsule, feiten-tabel, FAQ, smart-app-banner.
 *                       Géén auto-redirect: Google + AI-engines moeten
 *                       de content kunnen lezen.
 *
 *   • `/u/:handle` — friend-add share. Niet publiek vindbaar, dus
 *     bewust géén SEO-uitbreiding; profielen blijven privé.
 *
 *   • `/` — ANDREAS-marketing-homepage (logo + store-buttons).
 */
export const shareRoute = new Hono();

const APPLE_TEAM_ID = process.env.APPLE_TEAM_ID ?? '';
const APPLE_BUNDLE_ID = process.env.APPLE_BUNDLE_ID ?? 'amsterdam.andreas.app';
const APPLE_APP_ID = process.env.APPLE_APP_ID ?? '000000000';

shareRoute.get('/.well-known/apple-app-site-association', (c) => {
  const aasa = {
    applinks: {
      details: [
        {
          appIDs: APPLE_TEAM_ID
            ? [`${APPLE_TEAM_ID}.${APPLE_BUNDLE_ID}`]
            : [],
          components: [
            { '/': '/e/*', comment: 'Event-share-links' },
            { '/': '/v/*', comment: 'Venue-share-links' },
            { '/': '/u/*', comment: 'User-handle (QR) share-links' },
            { '/': '/', comment: 'Home' },
            { '/': '/api/*', exclude: true, comment: 'API-calls' },
          ],
        },
      ],
    },
  };
  c.header('Content-Type', 'application/json');
  return c.body(JSON.stringify(aasa));
});

/* ========================================================================
 * /e/:id  —  event-share / event-SEO-pagina
 * ====================================================================== */

shareRoute.get('/e/:id', async (c) => {
  const id = c.req.param('id');
  const ref = c.req.query('ref') ?? '';
  const isShareContext = ref.length > 0;

  // Eén query voor het hoofd-record. Onder de aanname dat de meeste
  // requests een geldige event-ID hebben — niet-bestaande IDs vallen
  // door naar de minimal-fallback (zonder venue).
  const [row] = await db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      description: schema.events.description,
      kind: schema.events.kind,
      imageUrl: schema.events.imageUrl,
      category: schema.events.category,
      genres: schema.events.genres,
      published: schema.events.published,
      venue: {
        id: schema.venues.id,
        slug: schema.venues.slug,
        name: schema.venues.name,
        address: schema.venues.address,
        lat: schema.venues.lat,
        lng: schema.venues.lng,
        type: schema.venues.type,
        description: schema.venues.description,
        imageUrl: schema.venues.imageUrl,
        priceNote: schema.venues.priceNote,
        website: schema.venues.website,
        published: schema.venues.published,
      },
    })
    .from(schema.events)
    .innerJoin(schema.venues, eq(schema.venues.id, schema.events.venueId))
    .where(eq(schema.events.id, id))
    .limit(1);

  const refQs = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const appLink = `andreas://event/${encodeURIComponent(id)}${refQs}`;

  // Share-context → minimal redirect-pagina (legacy). Voorkomt dat een
  // iMessage-tap eerst een SEO-pagina laat zien.
  if (isShareContext) {
    return c.body(renderShareRedirectEvent(id, ref, row), 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    });
  }

  // Niet-bestaand of ongepubliceerd event → 404-pagina (geen redirect).
  if (!row || !row.published || !row.venue.published) {
    return c.body(renderNotFound('Event niet gevonden'), 404, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  }

  // Occurrences: alle toekomstige (gecapt op 50) + de meest recente uit
  // het verleden als fallback voor afgelopen events.
  const upcomingOccs = await db
    .select()
    .from(schema.occurrences)
    .where(
      and(
        eq(schema.occurrences.eventId, row.id),
        sql`COALESCE(${schema.occurrences.endsAt}, ${schema.occurrences.startsAt} + INTERVAL '4 hours') >= NOW()`,
        sql`${schema.occurrences.status} <> 'cancelled'`
      )
    )
    .orderBy(asc(schema.occurrences.startsAt))
    .limit(50);

  let primaryOcc = upcomingOccs[0];
  if (!primaryOcc) {
    const [past] = await db
      .select()
      .from(schema.occurrences)
      .where(
        and(
          eq(schema.occurrences.eventId, row.id),
          sql`${schema.occurrences.status} <> 'cancelled'`
        )
      )
      .orderBy(desc(schema.occurrences.startsAt))
      .limit(1);
    primaryOcc = past;
  }

  // Series voor de breadcrumb/tags.
  const seriesRows = await db
    .select({
      id: schema.series.id,
      slug: schema.series.slug,
      name: schema.series.name,
    })
    .from(schema.eventsInSeries)
    .innerJoin(
      schema.series,
      eq(schema.series.id, schema.eventsInSeries.seriesId)
    )
    .where(
      and(
        eq(schema.eventsInSeries.eventId, row.id),
        eq(schema.series.published, true)
      )
    );

  // "Vergelijkbare events": eerstvolgende events op (a) dezelfde venue
  // en (b) dezelfde category, gededupliceerd. Geeft Google + AI's extra
  // interne paden naar gerelateerde content — versterkt het topical
  // cluster rond deze venue/categorie.
  const relatedRows = await db
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
        not(eq(schema.events.id, row.id)),
        sql`COALESCE(${schema.occurrences.endsAt}, ${schema.occurrences.startsAt} + INTERVAL '4 hours') >= NOW()`,
        sql`${schema.occurrences.status} <> 'cancelled'`,
        or(
          eq(schema.events.venueId, row.venue.id),
          eq(schema.events.category, row.category)
        )!
      )
    )
    .orderBy(
      // Zelfde-venue events eerst, dan op startsAt. SQL CASE doet de
      // sortering — vermijdt twee aparte queries.
      sql`CASE WHEN ${schema.events.venueId} = ${row.venue.id} THEN 0 ELSE 1 END`,
      asc(schema.occurrences.startsAt)
    )
    .limit(30);

  const seenRelated = new Set<string>();
  const relatedEvents = relatedRows
    .filter((r) => {
      if (seenRelated.has(r.eventId)) return false;
      seenRelated.add(r.eventId);
      return true;
    })
    .slice(0, 6);

  const html = renderEventSeoPage({
    event: row,
    primaryOcc,
    upcomingOccs,
    series: seriesRows,
    appLink,
    relatedEvents,
  });

  return c.body(html, 200, {
    'Content-Type': 'text/html; charset=utf-8',
    // Wat langer dan share (10 min): SEO-pagina's hoeven niet realtime,
    // maar wel snel updaten na een titel-correctie.
    'Cache-Control': 'public, max-age=600, s-maxage=900, stale-while-revalidate=3600',
  });
});

/* ========================================================================
 * /v/:slug  —  venue-share / venue-SEO-pagina
 * ====================================================================== */

shareRoute.get('/v/:slug', async (c) => {
  const slug = c.req.param('slug');
  const ref = c.req.query('ref') ?? '';
  const isShareContext = ref.length > 0;

  const [row] = await db
    .select()
    .from(schema.venues)
    .where(eq(schema.venues.slug, slug))
    .limit(1);

  const refQs = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const appLink = `andreas://venue/${encodeURIComponent(slug)}${refQs}`;

  if (isShareContext) {
    return c.body(renderShareRedirectVenue(slug, ref, row), 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    });
  }

  if (!row || !row.published) {
    return c.body(renderNotFound('Venue niet gevonden'), 404, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  }

  // Komende events op deze venue: limit 20 op de pagina, sortering op
  // eerstvolgende occurrence.
  const upcomingRows = await db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      kind: schema.events.kind,
      category: schema.events.category,
      startsAt: schema.occurrences.startsAt,
      endsAt: schema.occurrences.endsAt,
    })
    .from(schema.events)
    .innerJoin(
      schema.occurrences,
      eq(schema.occurrences.eventId, schema.events.id)
    )
    .where(
      and(
        eq(schema.events.venueId, row.id),
        eq(schema.events.published, true),
        sql`COALESCE(${schema.occurrences.endsAt}, ${schema.occurrences.startsAt} + INTERVAL '4 hours') >= NOW()`,
        sql`${schema.occurrences.status} <> 'cancelled'`
      )
    )
    .orderBy(asc(schema.occurrences.startsAt))
    .limit(40);

  // Eén row per event (dedupe op event-id) — events met meerdere
  // occurrences mogen niet 7× in de lijst komen.
  const seen = new Set<string>();
  const upcoming = upcomingRows.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  }).slice(0, 20);

  // "Vergelijkbare venues": andere venues van hetzelfde type én scene
  // (clubs met dezelfde sub-scene clusteren naturlijk: Shelter ↔ RADION,
  // OCCII ↔ OT301). Vermijdt dat een fringe-galerie naar een mainstream-
  // museum linkt — die hebben weinig met elkaar te maken.
  const relatedVenues = row.type
    ? await db
        .select({
          slug: schema.venues.slug,
          name: schema.venues.name,
          type: schema.venues.type,
          wijk: schema.venues.wijk,
        })
        .from(schema.venues)
        .where(
          and(
            eq(schema.venues.published, true),
            eq(schema.venues.type, row.type),
            not(eq(schema.venues.id, row.id)),
            row.scene ? eq(schema.venues.scene, row.scene) : sql`true`
          )
        )
        .orderBy(asc(schema.venues.name))
        .limit(8)
    : [];

  const html = renderVenueSeoPage({ venue: row, upcoming, appLink, relatedVenues });

  return c.body(html, 200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=600, s-maxage=900, stale-while-revalidate=3600',
  });
});

/* ========================================================================
 * Event SEO-template
 * ====================================================================== */

type EventRow = {
  id: string;
  title: string;
  description: string | null;
  kind: 'show' | 'exhibition';
  imageUrl: string | null;
  category: 'Muziek' | 'Theater' | 'Literatuur' | 'Film' | 'Kunst';
  genres: string[];
  venue: {
    id: string;
    slug: string;
    name: string;
    address: string;
    lat: number;
    lng: number;
    type: ApiVenueType;
    description: string | null;
    imageUrl: string | null;
    priceNote: string | null;
    website: string | null;
  };
};

type ApiVenueType =
  | 'galerie'
  | 'museum'
  | 'podium'
  | 'club'
  | 'film'
  | 'ruimte'
  | 'boekhandel-cafe'
  | null;

type OccRow = typeof schema.occurrences.$inferSelect;

type RelatedEvent = {
  eventId: string;
  title: string;
  kind: 'show' | 'exhibition';
  category: 'Muziek' | 'Theater' | 'Literatuur' | 'Film' | 'Kunst';
  genres: string[];
  imageUrl: string | null;
  startsAt: Date;
  endsAt: Date | null;
  venueName: string;
  venueSlug: string;
};

function renderEventSeoPage(opts: {
  event: EventRow;
  primaryOcc: OccRow | undefined;
  upcomingOccs: OccRow[];
  series: Array<{ id: string; slug: string; name: string }>;
  appLink: string;
  relatedEvents: RelatedEvent[];
}): string {
  const { event, primaryOcc, upcomingOccs, series, appLink, relatedEvents } = opts;
  const isExhibition = event.kind === 'exhibition';
  const occLabel = primaryOcc
    ? isExhibition && primaryOcc.endsAt
      ? formatRangeLong(primaryOcc.startsAt, primaryOcc.endsAt)
      : `${formatDateLong(primaryOcc.startsAt)} om ${formatTime(primaryOcc.startsAt)}`
    : '';

  // ---------- titel + description ----------

  const dateShort = primaryOcc
    ? primaryOcc.startsAt.toLocaleDateString('nl-NL', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'Europe/Amsterdam',
      })
    : '';

  // Onder 60 tekens als kan; ankers: titel, venue, plaats, datum.
  const pageTitle = [
    event.title,
    `${event.venue.name} Amsterdam`,
    dateShort,
  ]
    .filter(Boolean)
    .join(' · ') + ' | ANDREAS';

  // 150-160 tekens — lokt klikkers én AI-extractors. Bouw deterministisch
  // zodat we niet afhankelijk zijn van editor-input.
  const priceText = formatPrice(primaryOcc?.priceCents ?? null);
  const desc = [
    `${event.title} in ${event.venue.name}, Amsterdam`,
    occLabel ? `op ${occLabel.toLowerCase()}` : '',
    priceText ? `Tickets ${priceText}.` : '',
    event.category === 'Muziek' && event.genres.length > 0
      ? event.genres.slice(0, 3).join(', ') + '.'
      : '',
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+\./g, '.')
    .slice(0, 158);

  // ---------- JSON-LD: hoofdtype-event ----------

  const eventType = eventSchemaType(event);
  const ticketUrl = primaryOcc?.ticketUrl ?? null;
  const lineup = (primaryOcc?.lineup ?? []) as Array<{
    name: string;
    role?: 'dj' | 'support' | 'headliner' | 'act';
  }>;

  const performers = lineup.length > 0
    ? lineup.map((l) => ({
        '@type': event.category === 'Muziek' ? 'MusicGroup' : 'PerformingGroup',
        name: l.name,
      }))
    : [{
        '@type': event.category === 'Muziek' ? 'MusicGroup' : 'PerformingGroup',
        name: event.title,
      }];

  const eventLd = {
    '@context': 'https://schema.org',
    '@type': eventType,
    name: event.title,
    description: event.description ?? `${event.title} in ${event.venue.name}, Amsterdam.`,
    startDate: primaryOcc?.startsAt ?? undefined,
    endDate: primaryOcc?.endsAt ?? undefined,
    eventStatus: primaryOcc?.status === 'cancelled'
      ? 'https://schema.org/EventCancelled'
      : 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    // Image als ImageObject met expliciete credit naar de venue. Google
    // Images en AI-engines pakken `creditText` op om de bron te tonen
    // bij citaties; `copyrightHolder` documenteert auteursrechtelijke
    // toedeling. Geeft Andreas een duidelijke "we hosten, maar de rechten
    // liggen bij X"-positie.
    image: event.imageUrl
      ? [
          {
            '@type': 'ImageObject',
            url: event.imageUrl,
            creditText: `Foto via ${event.venue.name}`,
            copyrightHolder: {
              '@type': 'Organization',
              name: event.venue.name,
              ...(event.venue.website ? { url: event.venue.website } : {}),
            },
          },
        ]
      : undefined,
    // Content-credit: beschrijving/info komt grotendeels van de venue's
    // eigen kanalen (website, ticket-platform, persbericht). `sourceOrganization`
    // documenteert dat — zowel voor Google E-E-A-T als voor juridische context.
    sourceOrganization: {
      '@type': 'Organization',
      name: event.venue.name,
      ...(event.venue.website ? { url: event.venue.website } : {}),
    },
    inLanguage: 'nl',
    url: `${PUBLIC_BASE_URL}/e/${event.id}`,
    location: {
      '@type': venueSchemaType({ type: event.venue.type }),
      name: event.venue.name,
      address: {
        '@type': 'PostalAddress',
        streetAddress: streetAddress(event.venue.address),
        addressLocality: 'Amsterdam',
        addressCountry: 'NL',
      },
      geo: {
        '@type': 'GeoCoordinates',
        latitude: event.venue.lat,
        longitude: event.venue.lng,
      },
      url: `${PUBLIC_BASE_URL}/v/${event.venue.slug}`,
      ...(event.venue.website ? { sameAs: [event.venue.website] } : {}),
    },
    performer: performers,
    organizer: {
      '@type': 'Organization',
      name: event.venue.name,
      ...(event.venue.website ? { url: event.venue.website } : {}),
    },
    ...(primaryOcc?.priceCents != null
      ? {
          offers: {
            '@type': 'Offer',
            price: (primaryOcc.priceCents / 100).toFixed(2),
            priceCurrency: 'EUR',
            availability:
              primaryOcc.status === 'sold_out'
                ? 'https://schema.org/SoldOut'
                : 'https://schema.org/InStock',
            ...(ticketUrl ? { url: ticketUrl } : {}),
          },
        }
      : ticketUrl
      ? {
          offers: {
            '@type': 'Offer',
            url: ticketUrl,
            priceCurrency: 'EUR',
            availability: 'https://schema.org/InStock',
          },
        }
      : {}),
    isAccessibleForFree: primaryOcc?.priceCents === 0 ? true : false,
  };

  // ---------- JSON-LD: breadcrumb ----------

  const breadcrumb = breadcrumbJsonLd([
    { name: 'ANDREAS', path: '/' },
    { name: 'Events', path: '/' },
    { name: event.title, path: `/e/${event.id}` },
  ]);

  // ---------- JSON-LD: FAQ ----------

  // `answer` blijft plain text voor JSON-LD (AI-engines lezen 't zo
  // schoner). `answerHtml` is optioneel: gebruikt door de visuele FAQ
  // wanneer we klikbare links of opmaak willen tonen.
  const faqEntries: Array<{
    question: string;
    answer: string;
    answerHtml?: string;
  }> = [];
  if (primaryOcc) {
    if (isExhibition && primaryOcc.endsAt) {
      faqEntries.push({
        question: `Tot wanneer loopt ${event.title}?`,
        answer: `${event.title} is te zien in ${event.venue.name} tot en met ${primaryOcc.endsAt.toLocaleDateString(
          'nl-NL',
          { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Amsterdam' }
        )}.`,
      });
    } else {
      faqEntries.push({
        question: `Hoe laat begint ${event.title}?`,
        answer: `${event.title} start op ${formatDateLong(primaryOcc.startsAt)} om ${formatTime(primaryOcc.startsAt)} in ${event.venue.name}, ${event.venue.address}.`,
      });
    }
  }
  if (priceText) {
    faqEntries.push({
      question: `Wat kost een ticket voor ${event.title}?`,
      answer:
        priceText === 'Gratis'
          ? `${event.title} is gratis toegankelijk${event.venue.priceNote ? ` (${event.venue.priceNote})` : ''}.`
          : `Een ticket kost ${priceText}${event.venue.priceNote ? ` (${event.venue.priceNote})` : ''}. Tickets zijn verkrijgbaar via ${event.venue.name}.`,
    });
  }
  faqEntries.push({
    question: `Waar is ${event.venue.name}?`,
    answer: `${event.venue.name} ligt aan ${event.venue.address}.`,
  });
  // Ticket-vraag — Google + AI-engines pakken dit type FAQ direct op bij
  // "waar koop ik tickets voor X" queries. Antwoord blijft tekst-only zodat
  // 't 1-op-1 in de FAQPage JSON-LD past.
  if (primaryOcc?.ticketUrl) {
    const ticketHost = ticketDomain(primaryOcc.ticketUrl);
    faqEntries.push({
      question: `Waar koop ik tickets voor ${event.title}?`,
      answer: `Tickets voor ${event.title} zijn verkrijgbaar via ${ticketHost} (${primaryOcc.ticketUrl}).`,
      answerHtml: `Tickets voor ${escapeHtml(event.title)} zijn verkrijgbaar via <a href="${escapeHtml(primaryOcc.ticketUrl)}" target="_blank" rel="noopener">${escapeHtml(ticketHost)} ↗</a>.`,
    });
  }

  // ---------- head ----------

  const head = renderHead({
    title: pageTitle,
    description: desc,
    canonicalPath: `/e/${event.id}`,
    ogImage: event.imageUrl,
    ogType: 'event',
    apple: { appId: APPLE_APP_ID, appArgument: appLink },
    jsonLdBlocks: [jsonLd(eventLd), breadcrumb, faqJsonLd(faqEntries)],
    extraStyles: PAGE_GRID_STYLES + LIST_STYLES,
  });

  // ---------- body ----------

  // Antwoord-capsule: eerste regel onder de H1. Wordt door AI-engines
  // gepakt als citatie — moet zelfstandig leesbaar zijn en feitelijk.
  const leadParts: string[] = [];
  if (occLabel) {
    leadParts.push(
      isExhibition
        ? `<strong>${escapeHtml(event.title)}</strong> is te zien in ${escapeHtml(event.venue.name)} (${escapeHtml(event.venue.address)}) ${escapeHtml(occLabel.toLowerCase())}.`
        : `<strong>${escapeHtml(event.title)}</strong> speelt op ${escapeHtml(occLabel)} in ${escapeHtml(event.venue.name)} (${escapeHtml(event.venue.address)}).`
    );
  } else {
    leadParts.push(
      `<strong>${escapeHtml(event.title)}</strong> in ${escapeHtml(event.venue.name)}, Amsterdam.`
    );
  }
  if (priceText) leadParts.push(`${escapeHtml(priceText)}.`);
  if (event.genres.length > 0)
    leadParts.push(`${escapeHtml(event.genres.slice(0, 3).join(', '))}.`);

  const facts: Array<[string, string]> = [];
  if (primaryOcc) {
    if (isExhibition && primaryOcc.endsAt) {
      facts.push(['Periode', escapeHtml(formatRangeLong(primaryOcc.startsAt, primaryOcc.endsAt))]);
    } else {
      facts.push(['Datum', escapeHtml(formatDateLong(primaryOcc.startsAt))]);
      facts.push(['Aanvang', escapeHtml(formatTime(primaryOcc.startsAt))]);
    }
  }
  facts.push([
    'Locatie',
    `<a href="/v/${escapeHtml(event.venue.slug)}">${escapeHtml(event.venue.name)}</a> · ${escapeHtml(event.venue.address)}`,
  ]);
  if (priceText) {
    facts.push([
      'Prijs',
      escapeHtml(priceText) + (event.venue.priceNote ? ` <span style="color:var(--fg-muted)">· ${escapeHtml(event.venue.priceNote)}</span>` : ''),
    ]);
  }
  // Externe ticket-link in een aparte rij. Geen nofollow — Google waardeert
  // outbound links naar authoritative bronnen (E-E-A-T signaal). `noopener`
  // beschermt tegen `window.opener` access van de target page.
  if (primaryOcc?.ticketUrl) {
    const ticketHost = ticketDomain(primaryOcc.ticketUrl);
    facts.push([
      'Tickets',
      `<a href="${escapeHtml(primaryOcc.ticketUrl)}" target="_blank" rel="noopener">${escapeHtml(ticketHost)} ↗</a>`,
    ]);
  }
  facts.push(['Soort', escapeHtml(event.category)]);
  if (event.genres.length > 0)
    facts.push(['Genres', escapeHtml(event.genres.join(', '))]);
  if (primaryOcc?.room) facts.push(['Zaal', escapeHtml(primaryOcc.room)]);

  const factsHtml = facts
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join('\n        ');

  // Over-secties — alleen renderen als er een description is.
  const aboutEvent = event.description
    ? `
      <h2>Over ${escapeHtml(event.title)}</h2>
      <p>${escapeHtml(event.description)}</p>
    `
    : '';

  const aboutVenue = event.venue.description
    ? `
      <h2>Over ${escapeHtml(event.venue.name)}</h2>
      <p>${escapeHtml(event.venue.description)}</p>
      <p><a href="/v/${escapeHtml(event.venue.slug)}">Meer over ${escapeHtml(event.venue.name)} →</a></p>
    `
    : `
      <h2>Over ${escapeHtml(event.venue.name)}</h2>
      <p>${escapeHtml(event.venue.name)} ligt aan ${escapeHtml(event.venue.address)} in Amsterdam. <a href="/v/${escapeHtml(event.venue.slug)}">Bekijk de venue-pagina</a>.</p>
    `;

  // Lineup-lijst.
  const lineupHtml = lineup.length > 0
    ? `
      <h2>Line-up</h2>
      <ul class="lineup">
        ${lineup
          .map(
            (l) => `<li><span>${escapeHtml(l.name)}</span>${l.role ? `<span class="role">${escapeHtml(l.role)}</span>` : ''}</li>`
          )
          .join('\n        ')}
      </ul>
    `
    : '';

  // Komende voorstellingen lijst — alleen tonen bij events met meerdere.
  const occListHtml = !isExhibition && upcomingOccs.length > 1
    ? `
      <h2>Komende voorstellingen</h2>
      <ul class="occurrences">
        ${upcomingOccs
          .map(
            (o) => `<li>
          <span class="when">${escapeHtml(formatShort(o.startsAt))}</span>
          <span class="what">${o.room ? escapeHtml(o.room) : escapeHtml(event.venue.name)}${o.priceCents != null ? ` · ${escapeHtml(formatPrice(o.priceCents))}` : ''}${o.status === 'sold_out' ? ' · <em>uitverkocht</em>' : ''}</span>
        </li>`
          )
          .join('\n        ')}
      </ul>
    `
    : '';

  // Series-pills.
  const seriesHtml = series.length > 0
    ? `<div class="tags">${series
        .map(
          (s) =>
            `<span class="tag accent">onderdeel van ${escapeHtml(s.name)}</span>`
        )
        .join('')}</div>`
    : '';

  // FAQ-blok (HTML mirror van de FAQ-JSON-LD). Gebruikt `answerHtml`
  // wanneer beschikbaar (voor klikbare links), anders escape `answer`.
  const faqHtml = `
    <h2>Veelgestelde vragen</h2>
    ${faqEntries
      .map(
        (q) => `<details><summary>${escapeHtml(q.question)}</summary><p>${q.answerHtml ?? escapeHtml(q.answer)}</p></details>`
      )
      .join('\n    ')}
  `;

  // "Vergelijkbare events" — interne link-cluster naar gerelateerde events
  // op dezelfde venue of in dezelfde category. Versterkt topical authority
  // én geeft bezoekers een logische volgende stap zonder de app-CTA in de
  // weg te zitten.
  const relatedHtml = relatedEvents.length > 0
    ? `
      <h2>Vergelijkbaar</h2>
      <ul class="lines">
        ${relatedEvents
          .map((e) => {
            const when = e.kind === 'exhibition' && e.endsAt
              ? `t/m ${e.endsAt.toLocaleDateString('nl-NL', {
                  day: 'numeric', month: 'short', timeZone: 'Europe/Amsterdam',
                })}`
              : formatShort(e.startsAt);
            return `<li>
          <a class="row-link" href="/e/${escapeHtml(e.eventId)}">
            ${renderThumb(e.imageUrl, e.title)}
            <span class="row-text">
              <span class="when">${escapeHtml(when)}</span>
              <span class="title">${escapeHtml(e.title)}</span>
              <span class="meta">${escapeHtml(e.venueName)}</span>
            </span>
          </a>
        </li>`;
          })
          .join('\n        ')}
      </ul>
    `
    : '';

  const breadcrumbHtml = `
    <nav class="breadcrumb" aria-label="Kruimelpad">
      <a href="/">ANDREAS</a><span>›</span>
      <a href="/v/${escapeHtml(event.venue.slug)}">${escapeHtml(event.venue.name)}</a><span>›</span>
      ${escapeHtml(event.title)}
    </nav>
  `;

  return `<!doctype html>
<html lang="nl">
<head>${head}</head>
<body class="has-sticky-cta">
  ${renderAppBanner(appLink, `${event.title} in ${event.venue.name}`)}
  ${renderMobileStickyCta(appLink, event.title)}
  <main>
    <article>
      ${breadcrumbHtml}
      <div class="hero">
        ${event.imageUrl ? renderHeroImage(event.imageUrl, event.title) : ''}
        ${event.imageUrl ? `<p class="credit">Foto via ${escapeHtml(event.venue.name)}</p>` : ''}
        <h1>${escapeHtml(event.title)}</h1>
        <p class="lead">${leadParts.join(' ')}</p>
      </div>
      ${seriesHtml}
      <div class="page-grid">
        <div class="page-main">
          <dl class="facts">
            ${factsHtml}
          </dl>
          ${aboutEvent}
          ${lineupHtml}
          ${occListHtml}
          ${aboutVenue}
          ${faqHtml}
          ${relatedHtml}
        </div>
        <aside class="page-aside">
          ${renderCtaCard({
            deeplink: appLink,
            title: 'Bewaar dit event in ANDREAS',
            body: 'Krijg een herinnering, zie welke vrienden ook gaan, en ontdek meer in Amsterdam.',
          })}
        </aside>
      </div>
    </article>
    ${renderSiteFooter()}
  </main>
</body>
</html>`;
}

/* ========================================================================
 * Venue SEO-template
 * ====================================================================== */

type VenueRow = typeof schema.venues.$inferSelect;
type UpcomingEvent = {
  id: string;
  title: string;
  kind: 'show' | 'exhibition';
  category: 'Muziek' | 'Theater' | 'Literatuur' | 'Film' | 'Kunst';
  startsAt: Date;
  endsAt: Date | null;
};

type RelatedVenue = {
  slug: string;
  name: string;
  type: ApiVenueType;
  wijk: string | null;
};

function renderVenueSeoPage(opts: {
  venue: VenueRow;
  upcoming: UpcomingEvent[];
  appLink: string;
  relatedVenues: RelatedVenue[];
}): string {
  const { venue, upcoming, appLink, relatedVenues } = opts;

  const venueType = venueSchemaType({ type: venue.type as ApiVenueType });

  // ---------- titel + description ----------

  const pageTitle = `${venue.name} Amsterdam — ${venue.address} | ANDREAS`;
  const desc = [
    `${venue.name} in Amsterdam: agenda, info en route.`,
    venue.description ? venue.description.slice(0, 100) : '',
    upcoming.length > 0 ? `${upcoming.length} komende events.` : '',
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 158);

  // ---------- JSON-LD: venue + nested events ----------

  const venueLd = {
    '@context': 'https://schema.org',
    '@type': venueType,
    name: venue.name,
    description: venue.description ?? `${venue.name} in Amsterdam.`,
    url: `${PUBLIC_BASE_URL}/v/${venue.slug}`,
    // ImageObject met expliciete credit — de venue is z'n eigen
    // copyright-holder voor de eigen pers-foto.
    image: venue.imageUrl
      ? {
          '@type': 'ImageObject',
          url: venue.imageUrl,
          creditText: `Foto via ${venue.name}`,
          copyrightHolder: {
            '@type': 'Organization',
            name: venue.name,
            ...(venue.website ? { url: venue.website } : {}),
          },
        }
      : undefined,
    address: {
      '@type': 'PostalAddress',
      streetAddress: streetAddress(venue.address),
      addressLocality: 'Amsterdam',
      addressCountry: 'NL',
    },
    geo: {
      '@type': 'GeoCoordinates',
      latitude: venue.lat,
      longitude: venue.lng,
    },
    ...(venue.website || venue.instagram
      ? {
          sameAs: [
            venue.website,
            venue.instagram ? `https://instagram.com/${venue.instagram}` : null,
          ].filter(Boolean),
        }
      : {}),
    event: upcoming.slice(0, 12).map((e) => ({
      '@type': eventSchemaType({ kind: e.kind, category: e.category }),
      name: e.title,
      startDate: e.startsAt,
      endDate: e.endsAt ?? undefined,
      url: `${PUBLIC_BASE_URL}/e/${e.id}`,
      location: { '@type': venueType, name: venue.name },
    })),
  };

  const breadcrumb = breadcrumbJsonLd([
    { name: 'ANDREAS', path: '/' },
    { name: 'Venues', path: '/' },
    { name: venue.name, path: `/v/${venue.slug}` },
  ]);

  // ---------- FAQ ----------

  const faqEntries: Array<{ question: string; answer: string }> = [
    {
      question: `Waar ligt ${venue.name}?`,
      answer: `${venue.name} ligt aan ${venue.address}.`,
    },
  ];
  if (upcoming.length > 0) {
    const next = upcoming[0];
    faqEntries.push({
      question: `Wat is het eerstvolgende event in ${venue.name}?`,
      answer: `Het eerstvolgende event is "${next.title}" op ${formatDateLong(next.startsAt)} om ${formatTime(next.startsAt)}.`,
    });
  }
  if (venue.website) {
    faqEntries.push({
      question: `Wat is de website van ${venue.name}?`,
      answer: `De officiële website van ${venue.name} is ${venue.website}.`,
    });
  }

  // ---------- head ----------

  const head = renderHead({
    title: pageTitle,
    description: desc,
    canonicalPath: `/v/${venue.slug}`,
    ogImage: venue.imageUrl,
    ogType: 'website',
    apple: { appId: APPLE_APP_ID, appArgument: appLink },
    jsonLdBlocks: [jsonLd(venueLd), breadcrumb, faqJsonLd(faqEntries)],
    extraStyles: PAGE_GRID_STYLES + LIST_STYLES,
  });

  // ---------- body ----------

  const typeLabel = venueTypeLabel(venue.type as ApiVenueType);

  const leadParts: string[] = [];
  leadParts.push(
    `<strong>${escapeHtml(venue.name)}</strong> is een ${typeLabel ? escapeHtml(typeLabel.toLowerCase()) + ' ' : ''}in Amsterdam aan ${escapeHtml(streetAddress(venue.address))}.`
  );
  if (upcoming.length > 0) {
    leadParts.push(
      `Komende weken: ${upcoming.length} ${upcoming.length === 1 ? 'event' : 'events'}.`
    );
  }

  const facts: Array<[string, string]> = [
    ['Adres', escapeHtml(venue.address)],
  ];
  if (typeLabel) facts.push(['Type', escapeHtml(typeLabel)]);
  if (venue.scene) facts.push(['Scene', escapeHtml(String(venue.scene))]);
  if (venue.capacity) facts.push(['Capaciteit', escapeHtml(String(venue.capacity))]);
  if (venue.categories.length > 0)
    facts.push(['Programma', escapeHtml(venue.categories.join(', '))]);
  if (venue.subtype.length > 0)
    facts.push(['Genres', escapeHtml(venue.subtype.join(', '))]);
  if (venue.priceNote) facts.push(['Prijs-info', escapeHtml(venue.priceNote)]);
  if (venue.website)
    facts.push([
      'Website',
      `<a href="${escapeHtml(venue.website)}" rel="noopener" target="_blank">${escapeHtml(venue.website.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a>`,
    ]);
  if (venue.instagram)
    facts.push([
      'Instagram',
      `<a href="https://instagram.com/${escapeHtml(venue.instagram)}" rel="noopener" target="_blank">@${escapeHtml(venue.instagram)}</a>`,
    ]);

  const factsHtml = facts
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join('\n        ');

  const aboutVenue = venue.description
    ? `
      <h2>Over ${escapeHtml(venue.name)}</h2>
      <p>${escapeHtml(venue.description)}</p>
    `
    : '';

  const upcomingHtml = upcoming.length > 0
    ? `
      <h2>Komende events</h2>
      <ul class="upcoming">
        ${upcoming
          .map(
            (e) => `<li>
          <span class="when">${escapeHtml(formatShort(e.startsAt))}</span>
          <span class="what"><a href="/e/${escapeHtml(e.id)}">${escapeHtml(e.title)}</a></span>
        </li>`
          )
          .join('\n        ')}
      </ul>
    `
    : `
      <h2>Komende events</h2>
      <p>Op dit moment staan er geen events gepland in ${escapeHtml(venue.name)}.</p>
    `;

  const faqHtml = `
    <h2>Veelgestelde vragen</h2>
    ${faqEntries
      .map(
        (q) => `<details><summary>${escapeHtml(q.question)}</summary><p>${escapeHtml(q.answer)}</p></details>`
      )
      .join('\n    ')}
  `;

  // Vergelijkbare venues — alleen renderen als de type-label heeft betekenis
  // (anders is de heading nietszeggend).
  const typeLabelLower = venueTypeLabel(venue.type as ApiVenueType)?.toLowerCase();
  const relatedVenuesHtml = relatedVenues.length > 0
    ? `
      <h2>Vergelijkbare ${escapeHtml(typeLabelLower ? typeLabelLower + 's' : 'venues')}</h2>
      <ul class="lines">
        ${relatedVenues
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
          .join('\n        ')}
      </ul>
    `
    : '';

  const breadcrumbHtml = `
    <nav class="breadcrumb" aria-label="Kruimelpad">
      <a href="/">ANDREAS</a><span>›</span>
      ${escapeHtml(venue.name)}
    </nav>
  `;

  return `<!doctype html>
<html lang="nl">
<head>${head}</head>
<body class="has-sticky-cta">
  ${renderAppBanner(appLink, venue.name)}
  ${renderMobileStickyCta(appLink, venue.name)}
  <main>
    <article>
      ${breadcrumbHtml}
      <div class="hero">
        ${venue.imageUrl ? renderHeroImage(venue.imageUrl, venue.name) : ''}
        ${venue.imageUrl ? `<p class="credit">Foto via ${escapeHtml(venue.name)}</p>` : ''}
        <h1>${escapeHtml(venue.name)}</h1>
        <p class="lead">${leadParts.join(' ')}</p>
      </div>
      <div class="page-grid">
        <div class="page-main">
          <dl class="facts">
            ${factsHtml}
          </dl>
          ${aboutVenue}
          ${upcomingHtml}
          ${faqHtml}
          ${relatedVenuesHtml}
        </div>
        <aside class="page-aside">
          ${renderCtaCard({
            deeplink: appLink,
            title: `Volg ${venue.name} in ANDREAS`,
            body: 'Krijg een melding bij nieuwe events en zie wat je vrienden hebben gered.',
          })}
        </aside>
      </div>
    </article>
    ${renderSiteFooter()}
  </main>
</body>
</html>`;
}

/* ========================================================================
 * Share-redirect-pagina's (legacy `?ref=` pad)
 * ====================================================================== */

function renderShareRedirectEvent(
  id: string,
  ref: string,
  row:
    | {
        id: string;
        title: string;
        description: string | null;
        imageUrl: string | null;
        kind: 'show' | 'exhibition';
        venue: { name: string } | null;
      }
    | undefined
): string {
  const eventTitle = row?.title ?? 'ANDREAS';
  const eventImage = row?.imageUrl ?? '';
  const refQs = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const appLink = `andreas://event/${encodeURIComponent(id)}${refQs}`;
  const universalLink = `${PUBLIC_BASE_URL}/e/${encodeURIComponent(id)}${refQs}`;

  return `<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(eventTitle)} · ANDREAS</title>
  <meta property="og:title" content="${escapeHtml(eventTitle)}" />
  <meta property="og:description" content="${escapeHtml(
    [row?.venue?.name].filter(Boolean).join(' · ') || ''
  )}" />
  ${eventImage ? `<meta property="og:image" content="${escapeHtml(eventImage)}" />` : ''}
  <meta property="og:url" content="${escapeHtml(universalLink)}" />
  <meta property="og:type" content="website" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="apple-itunes-app" content="app-id=${APPLE_APP_ID}, app-argument=${escapeHtml(appLink)}" />
  <meta name="robots" content="noindex" />
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; background: #0a0a0b; color: #f2f2ef; font-family: -apple-system, system-ui, sans-serif; }
    main { max-width: 480px; margin: 0 auto; padding: 48px 24px; text-align: center; }
    h1 { font-size: 28px; line-height: 1.05; letter-spacing: -1px; margin: 24px 0 8px; font-weight: 900; }
    p { color: #9a9a94; margin: 4px 0 24px; font-size: 14px; }
    a.cta { display: inline-block; background: #d4ff3a; color: #0a0a0b; padding: 14px 22px; border-radius: 999px; text-decoration: none; font-weight: 600; }
    a.fallback { display: block; margin-top: 16px; color: #9a9a94; font-size: 12px; }
    img { width: 100%; border-radius: 12px; aspect-ratio: 16/9; object-fit: cover; background: #17171a; }
    .kicker { font-family: ui-monospace, monospace; font-size: 11px; letter-spacing: 1.4px; text-transform: uppercase; color: #d4ff3a; margin-bottom: 4px; }
  </style>
</head>
<body>
  <main>
    ${eventImage ? `<img src="${escapeHtml(eventImage)}" alt="" />` : ''}
    <div class="kicker">ANDREAS · uitgaan in Amsterdam</div>
    <h1>${escapeHtml(eventTitle)}</h1>
    <p>${escapeHtml([row?.venue?.name].filter(Boolean).join(' · '))}</p>
    <a class="cta" href="${escapeHtml(appLink)}" id="open">Open in ANDREAS</a>
    <a class="fallback" href="${escapeHtml(APP_STORE_URL)}">Nog geen ANDREAS? Download in de App Store</a>
  </main>
  <script>
    (function () {
      var app = ${JSON.stringify(appLink)};
      var store = ${JSON.stringify(APP_STORE_URL)};
      var t = setTimeout(function () { window.location.href = store; }, 1200);
      window.addEventListener('pagehide', function () { clearTimeout(t); });
      window.location.href = app;
    })();
  </script>
</body>
</html>`;
}

function renderShareRedirectVenue(
  slug: string,
  ref: string,
  row: VenueRow | undefined
): string {
  const venueName = row?.name ?? 'ANDREAS';
  const venueImage = row?.imageUrl ?? '';
  const refQs = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const appLink = `andreas://venue/${encodeURIComponent(slug)}${refQs}`;
  const universalLink = `${PUBLIC_BASE_URL}/v/${encodeURIComponent(slug)}${refQs}`;

  return `<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(venueName)} · ANDREAS</title>
  <meta property="og:title" content="${escapeHtml(venueName)}" />
  <meta property="og:description" content="${escapeHtml(row?.description ?? row?.address ?? '')}" />
  ${venueImage ? `<meta property="og:image" content="${escapeHtml(venueImage)}" />` : ''}
  <meta property="og:url" content="${escapeHtml(universalLink)}" />
  <meta property="og:type" content="website" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="apple-itunes-app" content="app-id=${APPLE_APP_ID}, app-argument=${escapeHtml(appLink)}" />
  <meta name="robots" content="noindex" />
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; background: #0a0a0b; color: #f2f2ef; font-family: -apple-system, system-ui, sans-serif; }
    main { max-width: 480px; margin: 0 auto; padding: 48px 24px; text-align: center; }
    h1 { font-size: 28px; line-height: 1.05; letter-spacing: -1px; margin: 24px 0 8px; font-weight: 900; }
    p { color: #9a9a94; margin: 4px 0 24px; font-size: 14px; }
    a.cta { display: inline-block; background: #d4ff3a; color: #0a0a0b; padding: 14px 22px; border-radius: 999px; text-decoration: none; font-weight: 600; }
    a.fallback { display: block; margin-top: 16px; color: #9a9a94; font-size: 12px; }
    img { width: 100%; border-radius: 12px; aspect-ratio: 16/9; object-fit: cover; background: #17171a; }
    .kicker { font-family: ui-monospace, monospace; font-size: 11px; letter-spacing: 1.4px; text-transform: uppercase; color: #d4ff3a; margin-bottom: 4px; }
  </style>
</head>
<body>
  <main>
    ${venueImage ? `<img src="${escapeHtml(venueImage)}" alt="" />` : ''}
    <div class="kicker">ANDREAS · venue</div>
    <h1>${escapeHtml(venueName)}</h1>
    <p>${escapeHtml(row?.address ?? '')}</p>
    <a class="cta" href="${escapeHtml(appLink)}" id="open">Open in ANDREAS</a>
    <a class="fallback" href="${escapeHtml(APP_STORE_URL)}">Nog geen ANDREAS? Download in de App Store</a>
  </main>
  <script>
    (function () {
      var app = ${JSON.stringify(appLink)};
      var store = ${JSON.stringify(APP_STORE_URL)};
      var t = setTimeout(function () { window.location.href = store; }, 1200);
      window.addEventListener('pagehide', function () { clearTimeout(t); });
      window.location.href = app;
    })();
  </script>
</body>
</html>`;
}

/* ========================================================================
 * Generieke 404-pagina
 * ====================================================================== */

function renderNotFound(label: string): string {
  return `<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(label)} · ANDREAS</title>
  <meta name="robots" content="noindex" />
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; background: #0a0a0b; color: #f2f2ef; font-family: -apple-system, system-ui, sans-serif; }
    main { max-width: 480px; margin: 0 auto; padding: 80px 24px; text-align: center; }
    h1 { font-size: 28px; letter-spacing: -1px; font-weight: 900; }
    p { color: #9a9a94; }
    a { color: #d4ff3a; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(label)}</h1>
    <p>Deze pagina bestaat niet (meer). Ga terug naar <a href="/">ANDREAS</a>.</p>
  </main>
</body>
</html>`;
}

/* ========================================================================
 * /u/:handle  —  friend-add share. Géén SEO-uitbreiding (privé).
 * ====================================================================== */

shareRoute.get('/u/:handle', async (c) => {
  const rawHandle = c.req.param('handle');
  const handle = rawHandle.toLowerCase().replace(/[^a-z0-9_]/g, '');

  const [row] = await db
    .select({
      name: schema.users.name,
      handle: schema.users.handle,
      avatarUrl: schema.users.avatarUrl,
    })
    .from(schema.users)
    .where(eq(schema.users.handle, handle))
    .limit(1);

  const displayName = row?.name && !row.name.startsWith('+') ? row.name : '';
  const handleLabel = row?.handle ?? handle;
  const appLink = `andreas://u/${encodeURIComponent(handleLabel)}`;
  const universalLink = `${PUBLIC_BASE_URL}/u/${encodeURIComponent(handleLabel)}`;

  const html = `<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>@${escapeHtml(handleLabel)} · ANDREAS</title>
  <meta property="og:title" content="${escapeHtml(displayName || `@${handleLabel}`)} op ANDREAS" />
  <meta property="og:description" content="Voeg ${escapeHtml(displayName || `@${handleLabel}`)} toe als vriend op ANDREAS." />
  ${row?.avatarUrl ? `<meta property="og:image" content="${escapeHtml(row.avatarUrl)}" />` : ''}
  <meta property="og:url" content="${escapeHtml(universalLink)}" />
  <meta property="og:type" content="website" />
  <meta name="apple-itunes-app" content="app-id=${APPLE_APP_ID}, app-argument=${escapeHtml(appLink)}" />
  <meta name="robots" content="noindex" />
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; background: #0a0a0b; color: #f2f2ef; font-family: -apple-system, system-ui, sans-serif; }
    main { max-width: 420px; margin: 0 auto; padding: 56px 24px; text-align: center; }
    h1 { font-size: 28px; line-height: 1.05; letter-spacing: -1px; margin: 16px 0 4px; font-weight: 900; }
    p.handle { font-family: ui-monospace, monospace; font-size: 12px; letter-spacing: 1.4px; text-transform: uppercase; color: #9a9a94; margin: 0 0 28px; }
    p { color: #9a9a94; margin: 4px 0 24px; font-size: 14px; }
    a.cta { display: inline-block; background: #d4ff3a; color: #0a0a0b; padding: 14px 22px; border-radius: 999px; text-decoration: none; font-weight: 600; }
    a.fallback { display: block; margin-top: 16px; color: #9a9a94; font-size: 12px; }
    .avatar { width: 96px; height: 96px; border-radius: 999px; object-fit: cover; background: #17171a; margin: 0 auto; }
    .kicker { font-family: ui-monospace, monospace; font-size: 11px; letter-spacing: 1.4px; text-transform: uppercase; color: #d4ff3a; }
  </style>
</head>
<body>
  <main>
    <div class="kicker">ANDREAS · vrienden</div>
    ${row?.avatarUrl ? `<img class="avatar" src="${escapeHtml(row.avatarUrl)}" alt="" />` : '<div class="avatar"></div>'}
    <h1>${escapeHtml(displayName || `@${handleLabel}`)}</h1>
    <p class="handle">@${escapeHtml(handleLabel)}</p>
    <a class="cta" href="${escapeHtml(appLink)}" id="open">Voeg toe in ANDREAS</a>
    <a class="fallback" href="${escapeHtml(APP_STORE_URL)}">Nog geen ANDREAS? Download in de App Store</a>
  </main>
  <script>
    (function () {
      var app = ${JSON.stringify(appLink)};
      var store = ${JSON.stringify(APP_STORE_URL)};
      var t = setTimeout(function () { window.location.href = store; }, 1200);
      window.addEventListener('pagehide', function () { clearTimeout(t); });
      window.location.href = app;
    })();
  </script>
</body>
</html>`;

  c.header('Content-Type', 'text/html; charset=utf-8');
  c.header('Cache-Control', 'public, max-age=300');
  return c.body(html);
});

/* ========================================================================
 * /  —  ANDREAS marketing-homepage
 *
 * Hero (wordmark) → tagline + uitleg → store-buttons → komende events
 * lijn-lijst → venues lijn-lijst → footer.
 *
 * Lijsten zijn deep-link surfaces voor crawl-budget: één homepage geeft
 * crawlers direct toegang tot alle ~200 venue-pagina's en de ~12
 * eerstvolgende event-pagina's. JSON-LD ItemList per sectie maakt de
 * structuur expliciet voor AI-engines.
 * ====================================================================== */

shareRoute.get('/', async (c) => {
  // Eerstvolgende 12 events (gededupliceerd op event-ID — een
  // wekelijkse club-avond mag de hele lijst niet vullen). We pakken
  // een buffer van 40 occurrences zodat na dedupe nog 12 events
  // overblijven voor de dichte agenda's.
  // Drie onafhankelijke queries — parallel afhandelen scheelt een hele
  // roundtrip op Neon (Frankfurt). We splitsen shows/exhibitions zodat
  // de "komende events"-sectie niet vol staat met al-lang-lopende
  // exhibitions waardoor de night-events vanavond eruit verdwijnen.
  const [showRows, exhibitionRows, venues] = await Promise.all([
    // Eerstvolgende point-in-time shows (concert, club, film, theater,
    // literatuur). Sort op startsAt asc — vanavond bovenaan.
    db
      .select({
        eventId: schema.events.id,
        title: schema.events.title,
        category: schema.events.category,
        genres: schema.events.genres,
        imageUrl: schema.events.imageUrl,
        startsAt: schema.occurrences.startsAt,
        endsAt: schema.occurrences.endsAt,
        venueName: schema.venues.name,
        venueSlug: schema.venues.slug,
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
          eq(schema.events.kind, 'show'),
          // Houd events die net begonnen zijn (club-avond gestart 22:00,
          // het is nu 23:30) nog 4 uur zichtbaar — anders verdwijnen ze
          // direct na startsAt.
          sql`${schema.occurrences.startsAt} + INTERVAL '4 hours' >= NOW()`,
          sql`${schema.occurrences.status} <> 'cancelled'`
        )
      )
      .orderBy(asc(schema.occurrences.startsAt))
      .limit(40),
    // Lopende exhibitions — sort op endsAt asc (sluit-eerst-eerst geeft
    // urgentie). Nieuwe exhibitions zonder endsAt nemen we niet mee in
    // de homepage-lijst (we kunnen ze niet ordenen op urgentie).
    db
      .select({
        eventId: schema.events.id,
        title: schema.events.title,
        genres: schema.events.genres,
        imageUrl: schema.events.imageUrl,
        startsAt: schema.occurrences.startsAt,
        endsAt: schema.occurrences.endsAt,
        venueName: schema.venues.name,
        venueSlug: schema.venues.slug,
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
          eq(schema.events.kind, 'exhibition'),
          sql`${schema.occurrences.endsAt} IS NOT NULL`,
          sql`${schema.occurrences.endsAt} >= NOW()`,
          sql`${schema.occurrences.status} <> 'cancelled'`
        )
      )
      .orderBy(asc(schema.occurrences.endsAt))
      .limit(20),
    // Alle gepubliceerde venues alfabetisch — geeft Google en AI's één
    // pad-met-alle-venues-anchors om in te crawlen.
    db
      .select({
        slug: schema.venues.slug,
        name: schema.venues.name,
        type: schema.venues.type,
        wijk: schema.venues.wijk,
      })
      .from(schema.venues)
      .where(eq(schema.venues.published, true))
      .orderBy(asc(schema.venues.name)),
  ]);

  const seenShowIds = new Set<string>();
  const upcomingShows = showRows
    .filter((r) => {
      if (seenShowIds.has(r.eventId)) return false;
      seenShowIds.add(r.eventId);
      return true;
    })
    .slice(0, 12);

  const seenExhIds = new Set<string>();
  const upcomingExhibitions = exhibitionRows
    .filter((r) => {
      if (seenExhIds.has(r.eventId)) return false;
      seenExhIds.add(r.eventId);
      return true;
    })
    .slice(0, 8);

  // JSON-LD: app + twee ItemLists.
  const appLd = jsonLd({
    '@context': 'https://schema.org',
    '@type': 'MobileApplication',
    name: 'ANDREAS',
    description:
      'ANDREAS bundelt de meest complete agenda van Amsterdam in één app: concerten, clubavonden, exposities, theater, film en literaire events.',
    operatingSystem: 'iOS, Android',
    applicationCategory: 'LifestyleApplication',
    url: PUBLIC_BASE_URL,
    installUrl: APP_STORE_URL,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
  });

  const showsListLd = jsonLd({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Komende events in Amsterdam',
    itemListElement: upcomingShows.map((e, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      url: `${PUBLIC_BASE_URL}/e/${e.eventId}`,
      name: e.title,
    })),
  });

  const exhibitionsListLd = jsonLd({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Lopende exhibitions in Amsterdam',
    itemListElement: upcomingExhibitions.map((e, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      url: `${PUBLIC_BASE_URL}/e/${e.eventId}`,
      name: e.title,
    })),
  });

  const venuesListLd = jsonLd({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Venues in Amsterdam',
    itemListElement: venues.map((v, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      url: `${PUBLIC_BASE_URL}/v/${v.slug}`,
      name: v.name,
    })),
  });

  // Homepage-FAQ: voor nieuwe bezoekers + voor AI-engines die "wat is X"
  // vragen direct beantwoorden. Vier korte vragen rond de basics. JSON-LD
  // FAQPage wordt door ChatGPT/Perplexity letterlijk gepakt als citatie.
  const homeFaq: Array<{ question: string; answer: string }> = [
    {
      question: 'Wat is ANDREAS?',
      answer:
        'ANDREAS is een uitgaansapp voor Amsterdam met de meest complete agenda van de stad: concerten, clubavonden, exposities, theater, film en literaire events op één plek.',
    },
    {
      question: 'Is ANDREAS gratis?',
      answer:
        'Ja, de ANDREAS-app is gratis te downloaden in de App Store en Google Play. Tickets voor events koop je rechtstreeks bij de venue — ANDREAS verkoopt zelf geen tickets.',
    },
    {
      question: 'Welke venues staan in ANDREAS?',
      answer: `Op dit moment ${venues.length} Amsterdamse venues, waaronder Paradiso, Melkweg, OCCII, OT301, Stedelijk Museum, Rijksmuseum, FOAM, Concertgebouw, Bimhuis, EYE Filmmuseum, Carré en DeLaMar. Van clubs tot musea en van bioscopen tot literaire podia.`,
    },
    {
      question: 'Werkt ANDREAS in andere steden?',
      answer:
        'Op dit moment alleen in Amsterdam. ANDREAS is gemaakt voor Amsterdam en houdt zich daar voorlopig bij. Suggesties voor andere steden zijn welkom via wij@andreas.amsterdam.',
    },
  ];
  const homeFaqLd = faqJsonLd(homeFaq);

  const showsHtml = upcomingShows
    .map((e) => {
      return `<li>
        <a class="row-link" href="/e/${escapeHtml(e.eventId)}">
          ${renderThumb(e.imageUrl, e.title)}
          <span class="row-text">
            <span class="when">${escapeHtml(formatShort(e.startsAt))}</span>
            <span class="title">${escapeHtml(e.title)}</span>
            <span class="meta">${renderEventMeta(e.venueName, e.genres)}</span>
          </span>
        </a>
      </li>`;
    })
    .join('\n      ');

  const exhibitionsHtml = upcomingExhibitions
    .map((e) => {
      const when = e.endsAt
        ? `t/m ${e.endsAt.toLocaleDateString('nl-NL', {
            day: 'numeric', month: 'short', timeZone: 'Europe/Amsterdam',
          })}`
        : '';
      return `<li>
        <a class="row-link" href="/e/${escapeHtml(e.eventId)}">
          ${renderThumb(e.imageUrl, e.title)}
          <span class="row-text">
            <span class="when">${escapeHtml(when)}</span>
            <span class="title">${escapeHtml(e.title)}</span>
            <span class="meta">${renderEventMeta(e.venueName, e.genres)}</span>
          </span>
        </a>
      </li>`;
    })
    .join('\n      ');

  // Venues: eerste 30 visible, rest in <details>. Beide secties zitten
  // gewoon in de HTML — Google crawlt en indexeert <details>-content,
  // dus alle 197 venue-links blijven volwaardig anchors voor PageRank.
  const VENUE_VISIBLE_COUNT = 30;
  const venuesVisible = venues.slice(0, VENUE_VISIBLE_COUNT);
  const venuesHidden = venues.slice(VENUE_VISIBLE_COUNT);

  const renderVenueRow = (v: typeof venues[number]) => {
    const label = venueTypeLabel(v.type as ApiVenueType);
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
  };

  const venuesVisibleHtml = venuesVisible.map(renderVenueRow).join('\n      ');
  const venuesHiddenHtml = venuesHidden.map(renderVenueRow).join('\n      ');

  const html = `<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8" />
  <title>ANDREAS — uitgaan in Amsterdam</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="ANDREAS bundelt de meest complete agenda van Amsterdam in één app: concerten, clubavonden, exposities, theater, film en literaire events — wat er vanavond is en wat eraan komt, op één plek." />
  <link rel="canonical" href="${PUBLIC_BASE_URL}/" />
  <link rel="icon" type="image/png" href="${PUBLIC_BASE_URL}/favicon.png" />
  <link rel="apple-touch-icon" href="${PUBLIC_BASE_URL}/apple-touch-icon.png" />
  <meta name="theme-color" content="#0a0a0b" />
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1" />
  <meta name="googlebot" content="index, follow, max-image-preview:large" />
  <meta name="ai-content-declaration" content="no-ai-training" />
  <meta name="impact-site-verification" value="fff70f25-b91e-4833-a018-ee1c1f216a6c" />
  <meta property="og:title" content="ANDREAS — uitgaan in Amsterdam" />
  <meta property="og:description" content="De meest complete agenda van Amsterdam in één app: concerten, clubs, exposities, theater, film en literatuur." />
  <meta property="og:url" content="${PUBLIC_BASE_URL}/" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="ANDREAS" />
  <meta property="og:locale" content="nl_NL" />
  <meta property="og:image" content="${escapeHtml(OG_IMAGE_URL)}" />
  <meta property="og:image:width" content="1024" />
  <meta property="og:image:height" content="1024" />
  <meta property="og:image:alt" content="ANDREAS app-icoon" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:image" content="${escapeHtml(OG_IMAGE_URL)}" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;700;800;900&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <script type="application/ld+json">${appLd}</script>
  <script type="application/ld+json">${showsListLd}</script>
  <script type="application/ld+json">${exhibitionsListLd}</script>
  <script type="application/ld+json">${venuesListLd}</script>
  <script type="application/ld+json">${homeFaqLd}</script>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0a0a0b;
      --bg-lift: #17171a;
      --fg: #f2f2ef;
      --fg-read: #c8c8c2;
      --fg-muted: #9a9a94;
      --fg-faint: #6a6a64;
      --acid: #d4ff3a;
      --border: #2a2a2d;
      --border-soft: #1d1d20;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--fg);
      font-family: 'Archivo', -apple-system, system-ui, sans-serif;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    main {
      max-width: 720px; width: 100%;
      margin: 0 auto; padding: 64px 28px 96px;
    }
    /* Hero */
    .hero { text-align: center; margin-bottom: 56px; }
    .logo { display: inline-flex; align-items: center; gap: 18px; }
    .logo-text {
      font-family: 'Archivo', sans-serif; font-weight: 900;
      font-size: 64px; letter-spacing: -1.2px; line-height: 1;
      color: var(--fg);
    }
    .cross { position: relative; width: 50px; height: 50px; flex-shrink: 0; }
    .cross::before, .cross::after {
      content: ""; position: absolute; top: 50%; left: 0;
      width: 100%; height: 11px; margin-top: -5.5px; background: var(--acid);
    }
    .cross::before { transform: rotate(45deg); }
    .cross::after { transform: rotate(-45deg); }
    .kicker {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 11px; letter-spacing: 2px; text-transform: uppercase;
      color: var(--fg-muted); margin: 18px 0 0;
    }
    /* Intro */
    .tagline {
      font-family: 'Archivo', sans-serif;
      font-weight: 800;
      font-size: 26px;
      letter-spacing: -0.6px;
      line-height: 1.2;
      margin: 0 0 20px;
      color: var(--fg);
    }
    .intro {
      font-size: 16px; line-height: 1.55;
      color: var(--fg-read); margin: 0 0 32px;
      max-width: 580px;
    }
    .intro strong { color: var(--fg); font-weight: 700; }
    /* Store-buttons */
    .stores {
      display: flex; gap: 10px; flex-wrap: wrap;
      margin: 0 0 80px;
    }
    .store-btn {
      flex: 1; min-width: 160px;
      display: inline-flex; align-items: center; justify-content: center; gap: 8px;
      padding: 14px 20px; border-radius: 999px;
      background: var(--acid); color: var(--bg);
      text-decoration: none; font-size: 14px;
      letter-spacing: -0.1px; transition: opacity 120ms;
      text-align: center;
    }
    .store-btn:hover { opacity: 0.85; }
    .store-btn small {
      display: block; font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 9px; letter-spacing: 1px; text-transform: uppercase;
      color: var(--bg); opacity: 0.7; margin-bottom: 2px;
    }
    .store-btn span { font-weight: 700; }
    /* Sectie-koppen */
    .section-head {
      display: flex; align-items: baseline; gap: 18px;
      margin: 0 0 16px;
      padding-top: 16px;
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
      color: var(--fg-faint);
      margin-left: auto;
    }
    ${LIST_STYLES}
    /* Hub-nav onder de stores: snelle paden naar de top-landing-pages. */
    nav.hub-nav {
      display: flex; flex-wrap: wrap;
      gap: 4px 14px;
      margin: 0 0 64px;
      padding: 18px 0;
      border-top: 1px solid var(--border-soft);
      border-bottom: 1px solid var(--border-soft);
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 12px; letter-spacing: 0.8px;
      text-transform: uppercase;
      align-items: center;
    }
    nav.hub-nav a {
      color: var(--fg-muted);
      text-decoration: none;
      transition: color 120ms;
    }
    nav.hub-nav a:hover { color: var(--acid); }
    nav.hub-nav .sep { color: var(--fg-faint); }
    /* "Toon alle venues"-toggle — strakke lijn met acid-accent. */
    details.venues-more {
      margin: -32px 0 56px;
    }
    details.venues-more > summary {
      cursor: pointer;
      list-style: none;
      padding: 16px 0;
      border-bottom: 1px solid var(--border-soft);
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 12px; letter-spacing: 1.2px; text-transform: uppercase;
      color: var(--fg-muted);
      transition: color 120ms;
      position: relative;
      padding-right: 32px;
    }
    details.venues-more > summary:hover { color: var(--acid); }
    details.venues-more > summary::-webkit-details-marker { display: none; }
    details.venues-more > summary::after {
      content: "+"; position: absolute; right: 4px; top: 50%;
      transform: translateY(-50%); font-size: 18px;
      color: var(--acid);
      font-family: 'Archivo', sans-serif; font-weight: 700;
      letter-spacing: 0;
    }
    details.venues-more[open] > summary::after { content: "−"; }
    details.venues-more[open] > summary { color: var(--acid); }
    details.venues-more > ul.lines { margin-top: 0; }
    details.venues-more > ul.lines li:first-child { border-top: 0; }

    /* Homepage FAQ — gestapelde details, acid +/- indicator. */
    details.home-faq {
      border-bottom: 1px solid var(--border-soft);
      padding: 16px 0;
    }
    details.home-faq:first-of-type { border-top: 1px solid var(--border-soft); }
    details.home-faq summary {
      cursor: pointer; list-style: none;
      font-weight: 600; color: var(--fg);
      font-size: 16px;
      padding-right: 32px;
      position: relative;
      letter-spacing: -0.1px;
    }
    details.home-faq summary::-webkit-details-marker { display: none; }
    details.home-faq summary::after {
      content: "+"; position: absolute; right: 4px; top: 50%;
      transform: translateY(-50%);
      color: var(--acid); font-size: 20px;
      font-weight: 700;
    }
    details.home-faq[open] summary::after { content: "−"; }
    details.home-faq p {
      margin: 12px 0 4px;
      color: var(--fg-read);
      font-size: 15px; line-height: 1.55;
      max-width: 640px;
    }

    /* Footer */
    footer.site {
      border-top: 1px solid var(--border-soft);
      margin-top: 32px; padding-top: 24px;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 11px; letter-spacing: 0.6px;
      color: var(--fg-faint);
      text-align: center;
    }
    footer.site a {
      color: var(--fg-muted); text-decoration: none;
      border-bottom: 1px solid var(--border);
    }
    footer.site a:hover { color: var(--acid); border-color: var(--acid); }
    @media (max-width: 540px) {
      main { padding: 48px 22px 64px; }
      .hero { margin-bottom: 40px; }
      .logo { gap: 14px; }
      .logo-text { font-size: 48px; letter-spacing: -0.8px; }
      .cross { width: 38px; height: 38px; }
      .cross::before, .cross::after { height: 9px; margin-top: -4.5px; }
      .tagline { font-size: 22px; }
      .stores { margin-bottom: 56px; }
    }
    /* Mobile sticky CTA — alleen onder 900px zichtbaar. Op desktop staan
       de store-buttons hoog in de hero, dus daar is deze overbodig. */
    .sticky-mobile-cta {
      position: fixed; bottom: 0; left: 0; right: 0;
      z-index: 100;
      display: flex; align-items: center; gap: 12px;
      padding: 12px 18px calc(12px + env(safe-area-inset-bottom)) 18px;
      background: rgba(10, 10, 11, 0.92);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-top: 1px solid var(--border);
    }
    .sticky-mobile-cta .brand {
      display: inline-flex; align-items: center; gap: 7px; flex-shrink: 0;
    }
    .sticky-mobile-cta .brand strong {
      color: var(--fg); font-weight: 800;
      font-size: 14px; letter-spacing: -0.1px;
      font-family: 'Archivo', sans-serif;
    }
    .sticky-mobile-cta .cross-mini {
      position: relative; width: 16px; height: 16px; flex-shrink: 0;
    }
    .sticky-mobile-cta .cross-mini::before,
    .sticky-mobile-cta .cross-mini::after {
      content: ""; position: absolute; top: 50%; left: 0;
      width: 100%; height: 4px; margin-top: -2px; background: var(--acid);
    }
    .sticky-mobile-cta .cross-mini::before { transform: rotate(45deg); }
    .sticky-mobile-cta .cross-mini::after { transform: rotate(-45deg); }
    .sticky-mobile-cta .label {
      flex: 1; min-width: 0;
      color: var(--fg-muted); font-size: 13px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .sticky-mobile-cta a.open {
      background: var(--acid); color: var(--bg);
      padding: 10px 18px; border-radius: 999px;
      font-weight: 700; font-size: 13px;
      text-decoration: none; flex-shrink: 0;
    }
    .sticky-mobile-cta a.open:hover { opacity: 0.9; }
    @media (min-width: 900px) {
      .sticky-mobile-cta { display: none; }
    }
    /* Extra bottom-padding op main wanneer sticky-CTA actief, zodat de
       footer/colofon niet onder de bar verdwijnt. */
    @media (max-width: 899px) {
      body.has-sticky-cta main {
        padding-bottom: calc(96px + env(safe-area-inset-bottom));
      }
    }
  </style>
</head>
<body class="has-sticky-cta">
  ${renderMobileStickyCta('andreas://', 'Uitgaan in Amsterdam')}
  <main>
    <header class="hero">
      <div class="logo">
        <span class="logo-text">ANDREAS</span>
        <span class="cross" aria-hidden="true"></span>
      </div>
      <p class="kicker">Amsterdam · ${new Date().getFullYear()}</p>
    </header>

    <p class="tagline">Heel Amsterdam, in één agenda.</p>
    <p class="intro">
      ANDREAS bundelt <strong>de meest complete agenda van Amsterdam</strong>
      in één app. Concerten, clubavonden, exposities, theater, film en
      literaire events — wat er vanavond is en wat eraan komt, op één plek.
    </p>

    <div class="stores">
      <a class="store-btn" href="${escapeHtml(APP_STORE_URL)}">
        <div><small>Download op de</small><span>App Store</span></div>
      </a>
      <a class="store-btn" href="${escapeHtml(PLAY_STORE_URL)}">
        <div><small>Verkrijgbaar via</small><span>Google Play</span></div>
      </a>
    </div>

    <nav class="hub-nav" aria-label="Browse">
      <a href="/vandaag">Vandaag</a>
      <a href="/dit-weekend">Dit weekend</a>
      <span class="sep">·</span>
      <a href="/muziek">Muziek</a>
      <a href="/theater">Theater</a>
      <a href="/film">Film</a>
      <a href="/kunst">Kunst</a>
      <a href="/literatuur">Literatuur</a>
      <span class="sep">·</span>
      <a href="/clubs">Clubs</a>
      <a href="/podia">Podia</a>
      <a href="/musea">Musea</a>
      <a href="/galeries">Galeries</a>
      <a href="/bioscopen">Bioscopen</a>
    </nav>

    <section>
      <div class="section-head">
        <h2>Komende events</h2>
        <span class="count">eerstvolgende ${upcomingShows.length}</span>
      </div>
      <ul class="lines">
        ${showsHtml}
      </ul>
    </section>

    ${upcomingExhibitions.length > 0 ? `<section>
      <div class="section-head">
        <h2>Lopende exhibitions</h2>
        <span class="count">sluit eerst</span>
      </div>
      <ul class="lines">
        ${exhibitionsHtml}
      </ul>
    </section>` : ''}

    <section>
      <div class="section-head">
        <h2>Venues in Amsterdam</h2>
        <span class="count">${venues.length} venues</span>
      </div>
      <ul class="lines">
        ${venuesVisibleHtml}
      </ul>
      ${venuesHidden.length > 0 ? `<details class="venues-more">
        <summary>Toon alle ${venues.length} venues</summary>
        <ul class="lines">
          ${venuesHiddenHtml}
        </ul>
      </details>` : ''}
    </section>

    <section>
      <div class="section-head">
        <h2>Vragen</h2>
      </div>
      ${homeFaq
        .map(
          (q) => `<details class="home-faq"><summary>${escapeHtml(q.question)}</summary><p>${escapeHtml(q.answer)}</p></details>`
        )
        .join('\n      ')}
    </section>

    <footer class="site">
      <p>
        <a href="/privacy">Privacy</a> · <a href="/voorwaarden">Voorwaarden</a> · <a href="/auteursrecht">Auteursrecht</a> · <a href="/sitemap.xml">Sitemap</a><br/>
        Gemaakt in Amsterdam · gehost in Frankfurt, Ljubljana en Amsterdam.
      </p>
    </footer>
  </main>
</body>
</html>`;

  return c.body(html, 200, {
    'Content-Type': 'text/html; charset=utf-8',
    // Homepage update niet sneller dan de eerstvolgende event — 15min
    // is ruim genoeg voor publishers en verlaagt DB-load.
    'Cache-Control': 'public, max-age=900, s-maxage=1800, stale-while-revalidate=3600',
  });
});
