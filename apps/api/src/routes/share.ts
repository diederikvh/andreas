import { and, asc, desc, eq, not, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import { db, displayGenres, schema } from '../db/index.js';
import { renderEventOg, renderInviteOg } from '../social/inviteOg.js';
import {
  AI_CONNECT_FAQ,
  AI_CONNECT_STYLES,
  COPY_SCRIPT,
  MCP_PUBLIC_URL,
  renderAiPromo,
} from './ai-connect.js';
import {
  APP_STORE_URL,
  HEADER_STYLES,
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
  renderFeaturedCard,
  renderHead,
  renderHeroImage,
  renderMobileStickyCta,
  renderQrSvg,
  renderSaveButton,
  renderShareButton,
  renderSiteFooter,
  renderSiteScripts,
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

/**
 * Server-side platform-detect voor de store-fallback. Android-bezoekers
 * krijgen anders een Apple-App-Store-link voorgeschoteld. Onbekend +
 * iOS-achtig vallen terug op de App Store; alleen UA met "Android"
 * mapt naar Play Store.
 */
function pickStore(ua: string): { url: string; label: string } {
  if (/Android/i.test(ua)) {
    return { url: PLAY_STORE_URL, label: 'Google Play' };
  }
  return { url: APP_STORE_URL, label: 'App Store' };
}

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
            { '/': '/i/*', comment: 'Friend-invite-tokens' },
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
  const lang: 'nl' | 'en' = c.req.query('lang') === 'en' ? 'en' : 'nl';

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
      genres: displayGenres,
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
    return c.body(renderShareRedirectEvent(id, ref, row, c.req.header('user-agent') ?? '', lang), 200, {
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
  // het verleden als fallback voor afgelopen events. Left-join venues op
  // de occurrence-venue-kolom zodat we per voorstelling het juiste venue
  // tonen — relevant voor multi-venue films (Anora bij Eye én Kriterion).
  // Coalesce naar event-venue als de occurrence geen eigen venue heeft.
  const upcomingOccs = await db
    .select({
      id: schema.occurrences.id,
      eventId: schema.occurrences.eventId,
      startsAt: schema.occurrences.startsAt,
      endsAt: schema.occurrences.endsAt,
      priceCents: schema.occurrences.priceCents,
      priceNote: schema.occurrences.priceNote,
      ticketUrl: schema.occurrences.ticketUrl,
      room: schema.occurrences.room,
      lineup: schema.occurrences.lineup,
      status: schema.occurrences.status,
      venueId: schema.occurrences.venueId,
      createdAt: schema.occurrences.createdAt,
      occVenueName: schema.venues.name,
      occVenueSlug: schema.venues.slug,
    })
    .from(schema.occurrences)
    .leftJoin(
      schema.venues,
      eq(schema.venues.id, schema.occurrences.venueId)
    )
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
      .select({
        id: schema.occurrences.id,
        eventId: schema.occurrences.eventId,
        startsAt: schema.occurrences.startsAt,
        endsAt: schema.occurrences.endsAt,
        priceCents: schema.occurrences.priceCents,
        priceNote: schema.occurrences.priceNote,
        ticketUrl: schema.occurrences.ticketUrl,
        room: schema.occurrences.room,
        lineup: schema.occurrences.lineup,
        status: schema.occurrences.status,
        venueId: schema.occurrences.venueId,
        createdAt: schema.occurrences.createdAt,
        occVenueName: schema.venues.name,
        occVenueSlug: schema.venues.slug,
      })
      .from(schema.occurrences)
      .leftJoin(
        schema.venues,
        eq(schema.venues.id, schema.occurrences.venueId)
      )
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
      genres: displayGenres,
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
    return c.body(renderShareRedirectVenue(slug, ref, row, c.req.header('user-agent') ?? ''), 200, {
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
      imageUrl: schema.events.imageUrl,
      genres: displayGenres,
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
        // Voor films-met-multi-venue: een Anora-event waarvan
        // event.venueId='kriterion' maar dat ook bij Eye draait moet op
        // /v/eye-filmmuseum verschijnen. We checken daarom de effectieve
        // venue per occurrence (occurrence.venueId óf event.venueId als
        // fallback voor legacy rows zonder occurrence-venueId).
        sql`COALESCE(${schema.occurrences.venueId}, ${schema.events.venueId}) = ${row.id}`,
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

/**
 * ImageObject met volledige rechten-attributie. Search Console klaagt
 * non-critical over `copyrightNotice`, `creator`, `license` en
 * `acquireLicensePage` als die ontbreken — we wijzen license en
 * acquireLicensePage consistent naar `/auteursrecht`, waar staat dat foto's
 * via venues komen en bij hun rechthebbenden liggen.
 */
function imageObjectLd(opts: {
  url: string;
  creditName: string;
  creditUrl?: string | null;
}) {
  const { url, creditName, creditUrl } = opts;
  const year = new Date().getFullYear();
  const org = {
    '@type': 'Organization' as const,
    name: creditName,
    ...(creditUrl ? { url: creditUrl } : {}),
  };
  return {
    '@type': 'ImageObject' as const,
    url,
    creditText: `Foto via ${creditName}`,
    copyrightNotice: `© ${year} ${creditName}`,
    copyrightHolder: org,
    creator: org,
    license: `${PUBLIC_BASE_URL}/auteursrecht`,
    acquireLicensePage: `${PUBLIC_BASE_URL}/auteursrecht`,
  };
}

type EventRow = {
  id: string;
  title: string;
  description: string | null;
  kind: 'show' | 'exhibition';
  imageUrl: string | null;
  category: 'Muziek' | 'Theater' | 'Literatuur' | 'Film' | 'Kunst' | 'Lezing';
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

type OccRow = typeof schema.occurrences.$inferSelect & {
  /** Venue van de occurrence (afwijkend van event.venue bij multi-venue
      films). Null als occurrence.venueId leeg is — caller valt terug op
      event.venue. */
  occVenueName?: string | null;
  occVenueSlug?: string | null;
};

type RelatedEvent = {
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
    artistId?: string;
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

  // endDate-fallback: voor shows zonder `endsAt` rekenen we +2u op startsAt
  // zodat Google's "Missing field endDate" non-critical warning verdwijnt
  // en de event-tegel een eindtijd toont. Exhibitions horen een echte
  // endsAt te hebben — als die mist krijg je hier dus ook een +2u, maar
  // dat is een data-issue om bij de bron op te lossen.
  const eventEndDate =
    primaryOcc?.endsAt ??
    (primaryOcc?.startsAt
      ? new Date(primaryOcc.startsAt.getTime() + 2 * 60 * 60 * 1000)
      : undefined);

  // Image-fallback chain: event-foto → venue-foto → ANDREAS app-icoon.
  // Search Console flagt non-critical "Missing image" als 'image' ontbreekt;
  // door altijd te emitten halen we die warning weg.
  const eventImage = event.imageUrl
    ? imageObjectLd({
        url: event.imageUrl,
        creditName: event.venue.name,
        creditUrl: event.venue.website,
      })
    : event.venue.imageUrl
    ? imageObjectLd({
        url: event.venue.imageUrl,
        creditName: event.venue.name,
        creditUrl: event.venue.website,
      })
    : imageObjectLd({
        url: OG_IMAGE_URL,
        creditName: 'ANDREAS',
        creditUrl: PUBLIC_BASE_URL,
      });

  // Offer altijd emitten — Search Console klaagt over missende 'offers'
  // wanneer we noch prijs noch ticket-URL hebben. URL valt terug op de
  // share-page (de feitelijke "koop"-route in onze app); validFrom op
  // `createdAt` van de occurrence, of nu als die mist.
  const offerUrl = ticketUrl ?? `${PUBLIC_BASE_URL}/e/${event.id}`;
  const offerValidFrom = primaryOcc?.createdAt ?? new Date();
  const offerAvailability =
    primaryOcc?.status === 'sold_out'
      ? 'https://schema.org/SoldOut'
      : 'https://schema.org/InStock';
  const offerLd = {
    '@type': 'Offer',
    url: offerUrl,
    priceCurrency: 'EUR',
    availability: offerAvailability,
    validFrom: offerValidFrom.toISOString(),
    ...(primaryOcc?.priceCents != null
      ? { price: (primaryOcc.priceCents / 100).toFixed(2) }
      : {}),
  };

  const eventLd = {
    '@context': 'https://schema.org',
    '@type': eventType,
    name: event.title,
    description: event.description ?? `${event.title} in ${event.venue.name}, Amsterdam.`,
    startDate: primaryOcc?.startsAt ?? undefined,
    endDate: eventEndDate,
    eventStatus: primaryOcc?.status === 'cancelled'
      ? 'https://schema.org/EventCancelled'
      : 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    image: [eventImage],
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
    offers: offerLd,
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
  // AI-connector — ook event-contextueel, zodat ChatGPT/Perplexity bij een
  // vraag over dit event direct weten dat ANDREAS via MCP te koppelen is.
  faqEntries.push({
    question: `Kan ik ${event.title} via ChatGPT of Claude vinden?`,
    answer: `Ja. Koppel ANDREAS aan ChatGPT, Claude of je eigen AI via de Model Context Protocol-connector op ${MCP_PUBLIC_URL} en zoek het Amsterdamse aanbod rechtstreeks vanuit je AI.`,
    answerHtml: `Ja. Koppel ANDREAS aan ChatGPT, Claude of je eigen AI via de <a href="/ai">MCP-connector</a> en zoek het Amsterdamse aanbod rechtstreeks vanuit je AI.`,
  });

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

  // Lineup-lijst. Items met een gematchte `artistId` worden klikbaar
  // naar de artist-pagina — interne link-cluster voor SEO + extra
  // diepte voor bezoekers ("wie is deze headliner eigenlijk?").
  const lineupHtml = lineup.length > 0
    ? `
      <h2>Line-up</h2>
      <ul class="lineup">
        ${lineup
          .map((l) => {
            const nameHtml = l.artistId
              ? `<a href="/a/${escapeHtml(l.artistId)}">${escapeHtml(l.name)}</a>`
              : `<span>${escapeHtml(l.name)}</span>`;
            const roleHtml = l.role
              ? `<span class="role">${escapeHtml(l.role)}</span>`
              : '';
            return `<li>${nameHtml}${roleHtml}</li>`;
          })
          .join('\n        ')}
      </ul>
    `
    : '';

  // Komende voorstellingen lijst — alleen tonen bij events met meerdere.
  // Voor multi-venue films (Anora bij Eye én Kriterion) groeperen we
  // per venue zodat de lijst niet door elkaar staat met bioscoopnamen
  // op elke regel. Voor single-venue events (concerts/theater) krijg je
  // één groep zonder kop — visueel gelijk aan vóór.
  let occListHtml = '';
  if (!isExhibition && upcomingOccs.length > 1) {
    type Group = { venueName: string; venueSlug: string | null; rows: typeof upcomingOccs };
    const byVenue = new Map<string, Group>();
    for (const o of upcomingOccs) {
      const venueName = o.occVenueName ?? event.venue.name;
      const venueSlug = o.occVenueSlug ?? event.venue.slug;
      const key = venueSlug ?? venueName;
      let g = byVenue.get(key);
      if (!g) {
        g = { venueName, venueSlug, rows: [] };
        byVenue.set(key, g);
      }
      g.rows.push(o);
    }
    const groups = [...byVenue.values()];
    const multiVenue = groups.length > 1;
    occListHtml = `
      <h2>Komende voorstellingen</h2>
      ${groups
        .map((g) => {
          const heading = multiVenue
            ? `<h3 class="occ-venue"><a href="/v/${escapeHtml(g.venueSlug ?? '')}">${escapeHtml(g.venueName)}</a> (${g.rows.length})</h3>`
            : '';
          const rows = g.rows
            .map(
              (o) => `<li>
          <span class="when">${escapeHtml(formatShort(o.startsAt))}</span>
          <span class="what">${o.room ? escapeHtml(o.room) : escapeHtml(g.venueName)}${o.priceCents != null ? ` · ${escapeHtml(formatPrice(o.priceCents))}` : ''}${o.status === 'sold_out' ? ' · <em>uitverkocht</em>' : ''}</span>
        </li>`
            )
            .join('\n        ');
          return `${heading}<ul class="occurrences">\n        ${rows}\n      </ul>`;
        })
        .join('\n      ')}
    `;
  }

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
  const relatedWhen = (re: RelatedEvent): string =>
    re.kind === 'exhibition' && re.endsAt
      ? `t/m ${re.endsAt.toLocaleDateString('nl-NL', {
          day: 'numeric',
          month: 'short',
          timeZone: 'Europe/Amsterdam',
        })}`
      : formatShort(re.startsAt);

  const RELATED_FEATURED = 2;
  const relatedFeaturedHtml = relatedEvents
    .slice(0, RELATED_FEATURED)
    .map((e) =>
      renderFeaturedCard({
        href: `/e/${e.eventId}`,
        imageUrl: e.imageUrl,
        when: relatedWhen(e),
        title: e.title,
        meta: e.venueName,
      })
    )
    .join('\n      ');

  const relatedListHtml = relatedEvents
    .slice(RELATED_FEATURED)
    .map((e) => {
      const when = relatedWhen(e);
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
    .join('\n        ');

  const relatedHtml = relatedEvents.length > 0
    ? `
      <h2>Vergelijkbaar</h2>
      ${relatedFeaturedHtml ? `<div class="featured-grid">${relatedFeaturedHtml}</div>` : ''}
      ${relatedListHtml ? `<ul class="lines">
        ${relatedListHtml}
      </ul>` : ''}
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
        ${event.imageUrl ? `
          <div class="hero-image-wrap">
            ${renderHeroImage(event.imageUrl, event.title)}
            <div class="hero-overlay-actions">
              ${renderShareButton({
                title: event.title,
                url: `${PUBLIC_BASE_URL}/e/${event.id}`,
                text: `${event.title} in ${event.venue.name}`,
              })}
              ${renderSaveButton({
                id: event.id,
                title: event.title,
                venueName: event.venue.name,
                startsAt: primaryOcc?.startsAt.toISOString() ?? null,
                imageUrl: event.imageUrl,
              })}
            </div>
          </div>
          <p class="credit">Foto via ${escapeHtml(event.venue.name)}</p>
        ` : `
          <div class="hero-actions">
            ${renderShareButton({
              title: event.title,
              url: `${PUBLIC_BASE_URL}/e/${event.id}`,
              text: `${event.title} in ${event.venue.name}`,
            })}
            ${renderSaveButton({
              id: event.id,
              title: event.title,
              venueName: event.venue.name,
              startsAt: primaryOcc?.startsAt.toISOString() ?? null,
              imageUrl: event.imageUrl,
            })}
          </div>
        `}
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
            qrUrl: `${PUBLIC_BASE_URL}/e/${event.id}`,
          })}
        </aside>
      </div>
    </article>
    ${renderSiteFooter()}
  </main>
  ${renderSiteScripts({ withSaveButton: true })}
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
  category: 'Muziek' | 'Theater' | 'Literatuur' | 'Film' | 'Kunst' | 'Lezing';
  imageUrl: string | null;
  genres: string[];
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
    // ImageObject met volledige rechten-attributie — de venue is z'n
    // eigen copyright-holder voor de eigen pers-foto. Bij ontbrekende
    // venue-foto valt 'ie terug op het ANDREAS-icoon zodat 'image' altijd
    // aanwezig is.
    image: venue.imageUrl
      ? imageObjectLd({
          url: venue.imageUrl,
          creditName: venue.name,
          creditUrl: venue.website,
        })
      : imageObjectLd({
          url: OG_IMAGE_URL,
          creditName: 'ANDREAS',
          creditUrl: PUBLIC_BASE_URL,
        }),
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
  faqEntries.push({
    question: `Kan ik ${venue.name} via ChatGPT of Claude vinden?`,
    answer: `Ja. Koppel ANDREAS aan ChatGPT, Claude of je eigen AI via de Model Context Protocol-connector op ${MCP_PUBLIC_URL} (zie ${PUBLIC_BASE_URL}/ai) en zoek het aanbod van ${venue.name} rechtstreeks vanuit je AI.`,
  });

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

  const VENUE_UPCOMING_FEATURED = 2;
  const venueUpcomingWhen = (e: UpcomingEvent): string =>
    e.kind === 'exhibition' && e.endsAt
      ? `t/m ${e.endsAt.toLocaleDateString('nl-NL', {
          day: 'numeric',
          month: 'short',
          timeZone: 'Europe/Amsterdam',
        })}`
      : formatShort(e.startsAt);

  const venueUpcomingFeatured = upcoming
    .slice(0, VENUE_UPCOMING_FEATURED)
    .map((e) =>
      renderFeaturedCard({
        href: `/e/${e.id}`,
        imageUrl: e.imageUrl,
        when: venueUpcomingWhen(e),
        title: e.title,
        meta: e.genres.length > 0 ? e.genres.slice(0, 2).join(', ') : e.category,
      })
    )
    .join('\n      ');

  const venueUpcomingList = upcoming
    .slice(VENUE_UPCOMING_FEATURED)
    .map(
      (e) => `<li>
        <a class="row-link" href="/e/${escapeHtml(e.id)}">
          ${renderThumb(e.imageUrl, e.title)}
          <span class="row-text">
            <span class="when">${escapeHtml(venueUpcomingWhen(e))}</span>
            <span class="title">${escapeHtml(e.title)}</span>
            <span class="meta">${escapeHtml(e.genres.slice(0, 2).join(', ') || e.category)}</span>
          </span>
        </a>
      </li>`
    )
    .join('\n        ');

  const upcomingHtml = upcoming.length > 0
    ? `
      <h2>Komende events</h2>
      ${venueUpcomingFeatured ? `<div class="featured-grid">${venueUpcomingFeatured}</div>` : ''}
      ${venueUpcomingList ? `<ul class="lines">
        ${venueUpcomingList}
      </ul>` : ''}
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
            qrUrl: `${PUBLIC_BASE_URL}/v/${venue.slug}`,
          })}
        </aside>
      </div>
    </article>
    ${renderSiteFooter()}
  </main>
  ${renderSiteScripts()}
</body>
</html>`;
}

/* ========================================================================
 * /zoeken  —  cross-category search (events / venues / artists).
 *             Server-rendered, ILIKE-search op naam/titel — geen FTS-
 *             index nodig voor de huidige catalogus-grootte.
 * ====================================================================== */

shareRoute.get('/zoeken', async (c) => {
  const rawQuery = (c.req.query('q') ?? '').trim().slice(0, 100);
  // ILIKE-pattern voorbereiden — basic escape voor LIKE-wildcards die
  // de gebruiker letterlijk wil zoeken (zeldzaam maar correct).
  const q = rawQuery.replace(/[\\%_]/g, (m) => `\\${m}`);
  const pattern = `%${q}%`;

  // Bij een lege query: geen DB-hit, lege resultaten. Pagina toont
  // dan alleen het zoekformulier + lege state.
  let events: Array<{
    id: string;
    title: string;
    imageUrl: string | null;
    startsAt: Date;
    venueName: string;
    venueSlug: string;
  }> = [];
  let venues: Array<{
    slug: string;
    name: string;
    type: ApiVenueType;
    wijk: string | null;
  }> = [];
  let artists: Array<{
    id: string;
    name: string;
    genres: string[];
  }> = [];

  if (rawQuery.length >= 2) {
    [events, venues, artists] = await Promise.all([
      db
        .selectDistinct({
          id: schema.events.id,
          title: schema.events.title,
          imageUrl: schema.events.imageUrl,
          startsAt: schema.occurrences.startsAt,
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
            sql`${schema.occurrences.status} <> 'cancelled'`,
            sql`COALESCE(${schema.occurrences.endsAt}, ${schema.occurrences.startsAt} + INTERVAL '4 hours') >= NOW()`,
            sql`${schema.events.title} ILIKE ${pattern}`
          )
        )
        .orderBy(asc(schema.occurrences.startsAt))
        .limit(20),
      db
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
            sql`${schema.venues.name} ILIKE ${pattern}`
          )
        )
        .orderBy(asc(schema.venues.name))
        .limit(15)
        .then((rows) => rows.map((r) => ({ ...r, type: r.type as ApiVenueType }))),
      db
        .select({
          id: schema.artists.id,
          name: schema.artists.name,
          genres: schema.artists.genres,
        })
        .from(schema.artists)
        .where(sql`${schema.artists.name} ILIKE ${pattern}`)
        .orderBy(asc(schema.artists.name))
        .limit(15),
    ]);
  }

  // Eerste event dedup op id (een residency in meerdere occurrences zou
  // anders 5× kunnen voorkomen).
  const seenEvents = new Set<string>();
  const uniqueEvents = events.filter((e) => {
    if (seenEvents.has(e.id)) return false;
    seenEvents.add(e.id);
    return true;
  });

  const html = renderSearchPage({
    query: rawQuery,
    events: uniqueEvents,
    venues,
    artists,
  });

  return c.body(html, 200, {
    'Content-Type': 'text/html; charset=utf-8',
    // Zoekresultaten verschillen per query; korte cache, geen shared.
    'Cache-Control': 'public, max-age=120',
  });
});

function renderSearchPage(opts: {
  query: string;
  events: Array<{
    id: string;
    title: string;
    imageUrl: string | null;
    startsAt: Date;
    venueName: string;
    venueSlug: string;
  }>;
  venues: Array<{
    slug: string;
    name: string;
    type: ApiVenueType;
    wijk: string | null;
  }>;
  artists: Array<{ id: string; name: string; genres: string[] }>;
}): string {
  const { query, events, venues, artists } = opts;
  const totalResults = events.length + venues.length + artists.length;
  const hasQuery = query.length >= 2;

  const pageTitle = hasQuery
    ? `Zoeken: ${query} | ANDREAS`
    : 'Zoeken | ANDREAS';
  const desc = hasQuery
    ? `${totalResults} resultaten voor "${query}" in ANDREAS — events, venues, artists in Amsterdam.`
    : 'Zoek door alle events, venues en artists in ANDREAS.';

  const head = renderHead({
    title: pageTitle,
    description: desc,
    canonicalPath: '/zoeken',
    ogType: 'website',
    jsonLdBlocks: [],
    extraStyles: PAGE_GRID_STYLES + LIST_STYLES + SEARCH_STYLES,
  });
  // Zoekresultaten-pagina's hebben weinig SEO-waarde (thin content,
  // duplicate-risk). Noindex zodat Google ze niet als landings pakt.
  const headNoindex = head.replace(
    /<meta name="robots"[^>]*\/>/,
    '<meta name="robots" content="noindex, follow" />'
  );

  const formHtml = `
    <form class="search-form" action="/zoeken" method="get" role="search">
      <input
        type="search"
        name="q"
        placeholder="Zoek events, venues, artists…"
        value="${escapeHtml(query)}"
        autofocus
        autocomplete="off"
      />
      <button type="submit">Zoeken</button>
    </form>
  `;

  const eventRow = (e: typeof events[number]) => `<li>
        <a class="row-link" href="/e/${escapeHtml(e.id)}">
          ${renderThumb(e.imageUrl, e.title)}
          <span class="row-text">
            <span class="when">${escapeHtml(formatShort(e.startsAt))}</span>
            <span class="title">${escapeHtml(e.title)}</span>
            <span class="meta">${escapeHtml(e.venueName)}</span>
          </span>
        </a>
      </li>`;
  const venueRow = (v: typeof venues[number]) => {
    const label = venueTypeLabel(v.type);
    const meta = [label, v.wijk]
      .filter(Boolean)
      .map((s) => escapeHtml(String(s)))
      .join(' · ');
    return `<li>
        <a class="row-link" href="/v/${escapeHtml(v.slug)}">
          <span class="thumb thumb-placeholder" aria-hidden="true"></span>
          <span class="row-text">
            <span class="title">${escapeHtml(v.name)}</span>
            <span class="meta">${meta}</span>
          </span>
        </a>
      </li>`;
  };
  const artistRow = (a: typeof artists[number]) => {
    const meta = a.genres.slice(0, 2).join(', ');
    return `<li>
        <a class="row-link" href="/a/${escapeHtml(a.id)}">
          <span class="thumb thumb-placeholder" aria-hidden="true"></span>
          <span class="row-text">
            <span class="title">${escapeHtml(a.name)}</span>
            <span class="meta">${escapeHtml(meta)}</span>
          </span>
        </a>
      </li>`;
  };

  const section = (heading: string, rows: string[]) =>
    rows.length === 0
      ? ''
      : `
      <div class="section-head">
        <h2>${escapeHtml(heading)}</h2>
        <span class="count">${rows.length}</span>
      </div>
      <ul class="lines">
        ${rows.join('\n        ')}
      </ul>
    `;

  const resultsHtml = !hasQuery
    ? '<p class="search-hint">Typ minstens 2 tekens om te zoeken — bijvoorbeeld een venuenaam, artiest of event-titel.</p>'
    : totalResults === 0
    ? `<p class="search-hint">Geen resultaten voor "${escapeHtml(query)}". Probeer een andere term — of bekijk <a href="/vandaag">wat er vandaag is</a>.</p>`
    : [
        section('Events', events.map(eventRow)),
        section('Venues', venues.map(venueRow)),
        section('Artists', artists.map(artistRow)),
      ].join('');

  return `<!doctype html>
<html lang="nl">
<head>${headNoindex}</head>
<body class="has-sticky-cta">
  ${renderAppBanner('andreas://', 'Zoeken in ANDREAS')}
  ${renderMobileStickyCta('andreas://', 'Open in app')}
  <main>
    <article>
      <nav class="breadcrumb" aria-label="Kruimelpad">
        <a href="/">ANDREAS</a><span>›</span>
        Zoeken
      </nav>
      <div class="hero">
        <h1>Zoeken</h1>
        ${formHtml}
      </div>
      <div class="page-grid">
        <div class="page-main">
          ${resultsHtml}
        </div>
        <aside class="page-aside">
          ${renderCtaCard({
            deeplink: 'andreas://',
            title: 'Vind sneller in ANDREAS',
            body: 'In de app heb je filters, opgeslagen zoekopdrachten en vrienden-zicht.',
            qrUrl: `${PUBLIC_BASE_URL}/zoeken`,
          })}
        </aside>
      </div>
    </article>
    ${renderSiteFooter()}
  </main>
  ${renderSiteScripts()}
</body>
</html>`;
}

/**
 * CSS voor de /zoeken-pagina: zoekveld + button, en wat tekst-tweaks
 * voor de empty/no-results state. Apart van LIST_STYLES omdat 't
 * alleen op deze pagina nodig is.
 */
const SEARCH_STYLES = `
  /* CTA-aside op /zoeken een stukje lager laten beginnen zodat 'ie
     niet visueel aan de zoekbalk vastplakt. De sticky positie blijft
     gewoon werken — start lager, plakt nog steeds 68px van top zodra
     je scrollt. */
  .page-aside { margin-top: 88px; }
  @media (max-width: 899px) {
    /* Op mobile vouwt 'ie onder de search/main; geen margin nodig. */
    .page-aside { margin-top: 0; }
  }
  .search-form {
    display: flex; gap: 8px;
    margin: 16px 0 0;
  }
  .search-form input[type="search"] {
    flex: 1;
    padding: 14px 18px;
    background: var(--bg-lift);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--fg);
    font-family: 'Archivo', sans-serif;
    font-size: 15px;
    -webkit-appearance: none;
    appearance: none;
  }
  .search-form input[type="search"]:focus {
    outline: none;
    border-color: var(--acid);
  }
  .search-form input[type="search"]::placeholder { color: var(--fg-faint); }
  .search-form button {
    padding: 14px 22px;
    background: var(--acid); color: var(--bg);
    border: 0; border-radius: 8px;
    font-family: 'Archivo', sans-serif;
    font-weight: 700; font-size: 14px;
    cursor: pointer;
  }
  .search-form button:hover { opacity: 0.9; }
  .search-hint {
    color: var(--fg-muted);
    font-size: 15px;
    margin: 24px 0;
    font-style: italic;
  }
  /* Section-head reuse uit ARTIST_INDEX_STYLES — kan generic worden
     ooit, voor nu inline. */
  .section-head {
    display: flex; align-items: baseline; gap: 18px;
    margin: 16px 0 12px;
    padding-top: 16px;
    border-top: 1px solid var(--border-soft);
  }
  .section-head h2 { margin: 0; }
  .section-head .count {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 11px; letter-spacing: 1.4px; text-transform: uppercase;
    color: var(--fg-faint);
    margin-left: auto;
  }
`;

/* ========================================================================
 * /mijn-lijst  —  client-side rendering van localStorage-saves.
 *                 Geen server-side data; alleen een shell die JS vult.
 *                 Noindex zodat Google deze persoonlijke pagina niet
 *                 oppakt.
 * ====================================================================== */

shareRoute.get('/mijn-lijst', async (c) => {
  const html = renderMyListPage();
  return c.body(html, 200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
  });
});

function renderMyListPage(): string {
  const extraStyles = PAGE_GRID_STYLES + LIST_STYLES;
  const head = renderHead({
    title: 'Mijn lijst | ANDREAS',
    description:
      'Events die je in ANDREAS hebt bewaard voor later — een snelle lijst zonder login.',
    canonicalPath: '/mijn-lijst',
    ogType: 'website',
    jsonLdBlocks: [],
    extraStyles,
  });
  // Pagina is persoonlijk per browser (localStorage); Google indexeren
  // heeft geen waarde — we overrulen daarom de default robots-meta.
  const headNoindex = head.replace(
    /<meta name="robots"[^>]*\/>/,
    '<meta name="robots" content="noindex, follow" />'
  );

  // Render-script: leest snapshots uit localStorage en bouwt de
  // event-rows. Bij een leeg lijstje: empty-state. Verwijder-icoon per
  // rij dat alleen de save weghaalt (niet naar /e navigeert).
  const renderScript = `
    (function () {
      function fmtWhen(iso) {
        if (!iso) return '';
        try {
          var d = new Date(iso);
          return d.toLocaleString('nl-NL', {
            weekday: 'short', day: 'numeric', month: 'short',
            hour: '2-digit', minute: '2-digit',
            timeZone: 'Europe/Amsterdam',
          });
        } catch (e) { return ''; }
      }
      function escape(s) {
        return String(s == null ? '' : s)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }
      function render() {
        var list = window.andreasSaves.list();
        var empty = document.getElementById('empty-state');
        var ul = document.getElementById('my-list');
        var countEl = document.getElementById('saves-count-display');
        if (countEl) countEl.textContent = String(list.length);
        if (list.length === 0) {
          empty.style.display = '';
          ul.style.display = 'none';
          return;
        }
        empty.style.display = 'none';
        ul.style.display = '';
        ul.innerHTML = list.map(function (s) {
          var when = escape(fmtWhen(s.startsAt));
          var thumb = s.imageUrl
            ? '<img class="thumb" src="' + escape(s.imageUrl) + '" alt="" loading="lazy" />'
            : '<span class="thumb thumb-placeholder" aria-hidden="true"></span>';
          return '<li>'
            + '<a class="row-link" href="' + escape(s.url) + '">'
            + thumb
            + '<span class="row-text">'
            +   '<span class="when">' + when + '</span>'
            +   '<span class="title">' + escape(s.title) + '</span>'
            +   '<span class="meta">' + escape(s.venue) + '</span>'
            + '</span>'
            + '</a>'
            + '<button class="my-list-remove" data-remove-id="' + escape(s.id) + '" aria-label="Verwijder uit lijst">×</button>'
          + '</li>';
        }).join('');
        ul.querySelectorAll('[data-remove-id]').forEach(function (btn) {
          btn.addEventListener('click', function (e) {
            e.preventDefault();
            window.andreasSaves.remove(btn.getAttribute('data-remove-id'));
            render();
          });
        });
      }
      // Initial + iedere keer dat de saves veranderen.
      window.andreasSaves.subscribe(render);
    })();
  `;

  return `<!doctype html>
<html lang="nl">
<head>${headNoindex}
<style>
  /* Lokaal extra: cross-knop rechts van elke row. Niet in LIST_STYLES
     omdat 't alleen op deze pagina nuttig is. */
  ul.lines li { display: flex; align-items: center; gap: 8px; }
  ul.lines li a.row-link { flex: 1; min-width: 0; }
  .my-list-remove {
    flex-shrink: 0;
    background: transparent; border: none;
    color: var(--fg-faint);
    font-size: 22px; line-height: 1;
    padding: 8px 12px;
    cursor: pointer;
    transition: color 120ms;
    font-family: inherit;
  }
  .my-list-remove:hover { color: var(--flare); }
</style>
</head>
<body class="has-sticky-cta">
  ${renderAppBanner('andreas://saves', 'Mijn lijst')}
  ${renderMobileStickyCta('andreas://saves', 'Open mijn lijst in app')}
  <main>
    <article>
      <nav class="breadcrumb" aria-label="Kruimelpad">
        <a href="/">ANDREAS</a><span>›</span>
        Mijn lijst
      </nav>
      <div class="hero">
        <h1>Mijn lijst</h1>
        <p class="lead">
          Events die je hebt bewaard voor later — <span id="saves-count-display">0</span> in totaal.
          Bewaard zonder login, alleen op dit apparaat. Voor pings, agenda-export en
          vrienden-zicht: open dezelfde lijst in de ANDREAS-app.
        </p>
      </div>
      <div class="page-grid">
        <div class="page-main">
          <p id="empty-state" style="display:none; color: var(--fg-muted); font-style: italic;">
            Nog geen events bewaard. Open een event en klik op <em>Bewaar voor later</em> om 'm hier terug te zien.
          </p>
          <ul id="my-list" class="lines" style="display:none;"></ul>
        </div>
        <aside class="page-aside">
          ${renderCtaCard({
            deeplink: 'andreas://saves',
            title: 'Open mijn lijst in ANDREAS',
            body: 'In de app sync je je lijst tussen apparaten en krijg je pings voor wat eraan komt.',
            qrUrl: `${PUBLIC_BASE_URL}/mijn-lijst`,
          })}
        </aside>
      </div>
    </article>
    ${renderSiteFooter()}
  </main>
  ${renderSiteScripts()}
  <script>${renderScript}</script>
</body>
</html>`;
}

/* ========================================================================
 * /a/:slug  —  artist-SEO-pagina
 * ====================================================================== */

shareRoute.get('/a/:slug', async (c) => {
  const slug = c.req.param('slug');

  const [artist] = await db
    .select()
    .from(schema.artists)
    .where(eq(schema.artists.id, slug))
    .limit(1);

  if (!artist) {
    return c.body(renderNotFound('Artist niet gevonden'), 404, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  }

  // Komende shows: dezelfde JSONB-containment-query als de mobile API.
  // We pakken de eerstvolgende occurrence per event, dedupen op eventId
  // zodat een residency niet 5× verschijnt, en sorteren op datum.
  const upcomingRows = await db
    .select({
      eventId: schema.events.id,
      title: schema.events.title,
      imageUrl: schema.events.imageUrl,
      occId: schema.occurrences.id,
      startsAt: schema.occurrences.startsAt,
      endsAt: schema.occurrences.endsAt,
      venueId: schema.venues.id,
      venueSlug: schema.venues.slug,
      venueName: schema.venues.name,
    })
    .from(schema.occurrences)
    .innerJoin(schema.events, eq(schema.events.id, schema.occurrences.eventId))
    .innerJoin(schema.venues, eq(schema.venues.id, schema.events.venueId))
    .where(
      and(
        eq(schema.events.category, 'Muziek'),
        eq(schema.events.published, true),
        eq(schema.venues.published, true),
        sql`COALESCE(${schema.occurrences.endsAt}, ${schema.occurrences.startsAt} + INTERVAL '4 hours') >= NOW()`,
        sql`${schema.occurrences.status} <> 'cancelled'`,
        sql`${schema.occurrences.lineup} @> ${JSON.stringify([{ artistId: artist.id }])}::jsonb`
      )
    )
    .orderBy(asc(schema.occurrences.startsAt));

  const seenEvents = new Set<string>();
  const upcoming: Array<{
    eventId: string;
    title: string;
    imageUrl: string | null;
    startsAt: Date;
    endsAt: Date | null;
    venueSlug: string;
    venueName: string;
  }> = [];
  for (const r of upcomingRows) {
    if (seenEvents.has(r.eventId)) continue;
    seenEvents.add(r.eventId);
    upcoming.push({
      eventId: r.eventId,
      title: r.title,
      imageUrl: r.imageUrl,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      venueSlug: r.venueSlug,
      venueName: r.venueName,
    });
  }

  const appLink = `andreas://artist/${encodeURIComponent(slug)}`;
  const html = renderArtistSeoPage({ artist, upcoming, appLink });

  return c.body(html, 200, {
    'Content-Type': 'text/html; charset=utf-8',
    // 10-15 min vers; artists worden niet vaker dan dagelijks ge-enrichd
    // en upcoming-rij verandert alleen bij nieuwe scrape-rondes.
    'Cache-Control': 'public, max-age=600, s-maxage=900, stale-while-revalidate=3600',
  });
});

/* ========================================================================
 * /artists  —  index van artists met komende shows in Amsterdam
 * ====================================================================== */

shareRoute.get('/artists', async (c) => {
  // Filter (WHERE): artists met >=1 future occurrence ÉN minimaal één
  // streaming-link of officiële site (= MB-enriched).
  // Kwaliteits-bar (HAVING): bio aanwezig ÓF >=2 shows. Dat snijdt de
  // eenmalige openers eruit en houdt artists over waar Google + bezoeker
  // wat aan hebben.
  const rows = await db
    .selectDistinct({
      id: schema.artists.id,
      name: schema.artists.name,
      genres: schema.artists.genres,
      description: schema.artists.description,
      spotifyUrl: schema.artists.spotifyUrl,
      appleMusicUrl: schema.artists.appleMusicUrl,
      bandcampUrl: schema.artists.bandcampUrl,
      youtubeUrl: schema.artists.youtubeUrl,
      officialUrl: schema.artists.officialUrl,
      nextStart: sql<Date>`MIN(${schema.occurrences.startsAt})`.as('next_start'),
      showCount: sql<number>`COUNT(DISTINCT ${schema.events.id})`.as('show_count'),
    })
    .from(schema.artists)
    .innerJoin(
      schema.occurrences,
      sql`${schema.occurrences.lineup} @> jsonb_build_array(jsonb_build_object('artistId', ${schema.artists.id}))`
    )
    .innerJoin(schema.events, eq(schema.events.id, schema.occurrences.eventId))
    .innerJoin(schema.venues, eq(schema.venues.id, schema.events.venueId))
    .where(
      and(
        eq(schema.events.category, 'Muziek'),
        eq(schema.events.published, true),
        eq(schema.venues.published, true),
        sql`COALESCE(${schema.occurrences.endsAt}, ${schema.occurrences.startsAt} + INTERVAL '4 hours') >= NOW()`,
        sql`${schema.occurrences.status} <> 'cancelled'`,
        or(
          sql`${schema.artists.spotifyUrl} IS NOT NULL`,
          sql`${schema.artists.appleMusicUrl} IS NOT NULL`,
          sql`${schema.artists.bandcampUrl} IS NOT NULL`,
          sql`${schema.artists.youtubeUrl} IS NOT NULL`,
          sql`${schema.artists.officialUrl} IS NOT NULL`
        )
      )
    )
    .groupBy(
      schema.artists.id,
      schema.artists.name,
      schema.artists.genres,
      schema.artists.description,
      schema.artists.spotifyUrl,
      schema.artists.appleMusicUrl,
      schema.artists.bandcampUrl,
      schema.artists.youtubeUrl,
      schema.artists.officialUrl
    )
    // Kwaliteits-bar: alleen artists met >=2 komende shows. MB-bio bleek
    // geen bruikbaar signaal (de enrich-helper zet "disambiguation" als
    // bio — typisch "Dutch DJ" of "soprano", maar 100% van de enriched
    // artists heeft het, dus filter-waarde = 0). Multi-show pakt
    // recurring acts en sluit eenmalige openers uit; brengt het van 377
    // naar ~80 artists — scanbaar genoeg voor één pagina.
    .having(sql`COUNT(DISTINCT ${schema.events.id}) >= 2`)
    .orderBy(asc(schema.artists.name));

  const html = renderArtistsIndexPage({ artists: rows });

  return c.body(html, 200, {
    'Content-Type': 'text/html; charset=utf-8',
    // 30 min — index hoeft niet realtime maar wel binnen een dag na een
    // nieuwe scrape-batch verse content tonen.
    'Cache-Control': 'public, max-age=1800, s-maxage=1800, stale-while-revalidate=86400',
  });
});

/* ========================================================================
 * Artist SEO-templates
 * ====================================================================== */

type ArtistRow = typeof schema.artists.$inferSelect;

type ArtistShow = {
  eventId: string;
  title: string;
  imageUrl: string | null;
  startsAt: Date;
  endsAt: Date | null;
  venueSlug: string;
  venueName: string;
};

type StreamingPlatform = 'spotify' | 'apple' | 'bandcamp' | 'youtube' | 'website';

/**
 * Inline SVG-iconen per platform. Brand-paden komen uit simple-icons.org
 * (CC0/MIT). `fill="currentColor"` zodat 't icoon mee-kleurt met de
 * button-state (fg in rust, acid op hover). 18×18 past goed naast 14px
 * Archivo-tekst. Bandcamp en Website hebben simpele geometrie zelf
 * geschreven.
 */
function streamingIconSvg(platform: StreamingPlatform): string {
  const attrs = `width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"`;
  switch (platform) {
    case 'spotify':
      return `<svg ${attrs}><path d="M12 0a12 12 0 1 0 0 24 12 12 0 0 0 0-24Zm5.5 17.3a.75.75 0 0 1-1.03.25c-2.82-1.72-6.37-2.1-10.55-1.15a.75.75 0 1 1-.34-1.46c4.58-1.04 8.5-.6 11.66 1.33.36.22.47.69.26 1.03Zm1.47-3.27a.94.94 0 0 1-1.29.31c-3.23-1.98-8.14-2.56-11.95-1.4a.94.94 0 0 1-.55-1.8c4.36-1.32 9.77-.68 13.48 1.6.44.27.58.86.31 1.29Zm.13-3.41C15.3 8.32 8.78 8.08 5.06 9.2a1.13 1.13 0 0 1-.66-2.15C8.66 5.76 15.86 6.05 20.06 8.5a1.13 1.13 0 0 1-1.16 1.94Z"/></svg>`;
    case 'apple':
      return `<svg ${attrs}><path d="M23.97 6.43c-.13-2.96-2.42-5.4-5.4-5.4H5.43C2.45 1.03.16 3.47.03 6.43L0 6.96v10.08l.03.53c.13 2.96 2.42 5.4 5.4 5.4h13.14c2.98 0 5.27-2.44 5.4-5.4l.03-.53V6.96l-.03-.53ZM17.2 17.04c0 .79-.49 1.48-1.22 1.74l-.42.13c-1.5.44-2.46-.5-2.46-1.45 0-1 .77-1.47 1.83-1.71.31-.07 1.05-.2 1.35-.27.41-.1.49-.16.49-.5V8.7L9.05 10.4v7.97c0 .79-.49 1.48-1.22 1.74l-.42.13c-1.5.44-2.47-.5-2.47-1.45 0-1 .77-1.47 1.84-1.71.3-.07 1.05-.2 1.35-.27.41-.1.49-.16.49-.5V7.97c0-.81.48-1.18 1.2-1.34l6.04-1.21c.4-.08.84-.18 1.16-.18.95 0 1.18.7 1.18 1.45v10.35Z"/></svg>`;
    case 'bandcamp':
      return `<svg ${attrs}><path d="M0 18.75 7.437 5.25H24l-7.438 13.5Z"/></svg>`;
    case 'youtube':
      return `<svg ${attrs}><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814ZM9.545 15.568V8.432L15.818 12l-6.273 3.568Z"/></svg>`;
    case 'website':
      return `<svg ${attrs} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18Z"/></svg>`;
  }
}

/**
 * Bouw een lijst van streaming-/web-links voor een artist. Alleen platforms
 * waarvoor een URL bekend is, in een vaste volgorde (Spotify eerst — meest
 * herkenbaar voor het NL-publiek). Externe links openen in nieuw tabblad
 * met `rel="noopener"`.
 */
function artistLinks(a: ArtistRow): Array<{
  platform: StreamingPlatform;
  label: string;
  url: string;
}> {
  const out: Array<{ platform: StreamingPlatform; label: string; url: string }> = [];
  if (a.spotifyUrl) out.push({ platform: 'spotify', label: 'Spotify', url: a.spotifyUrl });
  if (a.appleMusicUrl) out.push({ platform: 'apple', label: 'Apple Music', url: a.appleMusicUrl });
  if (a.bandcampUrl) out.push({ platform: 'bandcamp', label: 'Bandcamp', url: a.bandcampUrl });
  if (a.youtubeUrl) out.push({ platform: 'youtube', label: 'YouTube', url: a.youtubeUrl });
  if (a.officialUrl) out.push({ platform: 'website', label: 'Website', url: a.officialUrl });
  return out;
}

function renderArtistSeoPage(opts: {
  artist: ArtistRow;
  upcoming: ArtistShow[];
  appLink: string;
}): string {
  const { artist, upcoming, appLink } = opts;
  const links = artistLinks(artist);

  // ---------- titel + description ----------

  const venueList = [...new Set(upcoming.slice(0, 3).map((s) => s.venueName))];
  const pageTitle =
    upcoming.length > 0
      ? `${artist.name} in Amsterdam · Komende shows | ANDREAS`
      : `${artist.name} | ANDREAS`;

  const descParts: string[] = [];
  if (upcoming.length > 0) {
    descParts.push(
      `${artist.name} speelt binnenkort in Amsterdam: ${venueList.join(', ')}.`
    );
  } else {
    descParts.push(`${artist.name} op ANDREAS — uitgaan in Amsterdam.`);
  }
  if (artist.genres.length > 0) {
    descParts.push(artist.genres.slice(0, 3).join(', ') + '.');
  }
  if (links.length > 0) {
    descParts.push(`Luister op ${links.slice(0, 2).map((l) => l.label).join(' & ')}.`);
  }
  const desc = descParts.join(' ').slice(0, 158);

  // ---------- JSON-LD: MusicGroup ----------

  const sameAs = links.map((l) => l.url);
  const musicGroupLd = {
    '@context': 'https://schema.org',
    '@type': 'MusicGroup',
    name: artist.name,
    ...(artist.description ? { description: artist.description } : {}),
    ...(artist.genres.length > 0 ? { genre: artist.genres } : {}),
    ...(sameAs.length > 0 ? { sameAs } : {}),
    url: `${PUBLIC_BASE_URL}/a/${artist.id}`,
  };

  // ---------- JSON-LD: ItemList van komende shows ----------

  const upcomingLd = upcoming.length > 0
    ? {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        itemListElement: upcoming.slice(0, 20).map((s, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          item: {
            '@type': 'MusicEvent',
            name: s.title,
            startDate: s.startsAt,
            ...(s.endsAt ? { endDate: s.endsAt } : {}),
            url: `${PUBLIC_BASE_URL}/e/${s.eventId}`,
            location: {
              '@type': 'MusicVenue',
              name: s.venueName,
              url: `${PUBLIC_BASE_URL}/v/${s.venueSlug}`,
            },
            performer: { '@type': 'MusicGroup', name: artist.name },
          },
        })),
      }
    : null;

  // ---------- JSON-LD: breadcrumb ----------

  const breadcrumb = breadcrumbJsonLd([
    { name: 'ANDREAS', path: '/' },
    { name: 'Artists', path: '/artists' },
    { name: artist.name, path: `/a/${artist.id}` },
  ]);

  const jsonLdBlocks = [jsonLd(musicGroupLd), breadcrumb];
  if (upcomingLd) jsonLdBlocks.push(jsonLd(upcomingLd));

  // ---------- head ----------

  const head = renderHead({
    title: pageTitle,
    description: desc,
    canonicalPath: `/a/${artist.id}`,
    ogImage: artist.imageUrl,
    ogType: 'article',
    apple: { appId: APPLE_APP_ID, appArgument: appLink },
    jsonLdBlocks,
    extraStyles: PAGE_GRID_STYLES + LIST_STYLES + ARTIST_PAGE_STYLES,
  });

  // ---------- body ----------

  const nextShow = upcoming[0];
  const leadParts: string[] = [];
  if (nextShow) {
    leadParts.push(
      `<strong>${escapeHtml(artist.name)}</strong> speelt op ${escapeHtml(
        formatShort(nextShow.startsAt)
      )} in <a href="/v/${escapeHtml(nextShow.venueSlug)}">${escapeHtml(
        nextShow.venueName
      )}</a>.`
    );
  } else {
    leadParts.push(
      `<strong>${escapeHtml(artist.name)}</strong> op ANDREAS.`
    );
  }
  if (artist.genres.length > 0) {
    leadParts.push(escapeHtml(artist.genres.slice(0, 3).join(', ')) + '.');
  }

  const genreHtml = artist.genres.length > 0
    ? `<div class="tags">${artist.genres
        .slice(0, 8)
        .map((g) => `<span class="tag">${escapeHtml(g)}</span>`)
        .join('')}</div>`
    : '';

  // Streaming-links als substantiële buttons (bgLift-vlak, 6px radius)
  // met platform-icoontje links en label rechts — zelfde recept als de
  // mobile-tiles. Inline SVG zodat we geen icon-font of externe deps
  // nodig hebben.
  const linksHtml = links.length > 0
    ? `<div class="streaming-btns">${links
        .map(
          (l) =>
            `<a class="streaming-btn" href="${escapeHtml(l.url)}" target="_blank" rel="noopener"><span class="streaming-icon">${streamingIconSvg(l.platform)}</span><span class="streaming-label">${escapeHtml(l.label)}</span></a>`
        )
        .join('')}</div>`
    : '';

  const aboutHtml = artist.description && artist.description.length > 40
    ? `<h2>Over ${escapeHtml(artist.name)}</h2><p>${escapeHtml(artist.description)}</p>`
    : '';

  const ARTIST_FEATURED = 2;
  const artistFeaturedHtml = upcoming
    .slice(0, ARTIST_FEATURED)
    .map((s) =>
      renderFeaturedCard({
        href: `/e/${s.eventId}`,
        imageUrl: s.imageUrl,
        when: formatShort(s.startsAt),
        title: s.title,
        meta: s.venueName,
      })
    )
    .join('\n      ');

  const artistListHtml = upcoming
    .slice(ARTIST_FEATURED)
    .map((s) => {
      const when = formatShort(s.startsAt);
      return `<li>
          <a class="row-link" href="/e/${escapeHtml(s.eventId)}">
            ${renderThumb(s.imageUrl, s.title)}
            <span class="row-text">
              <span class="when">${escapeHtml(when)}</span>
              <span class="title">${escapeHtml(s.title)}</span>
              <span class="meta">${escapeHtml(s.venueName)}</span>
            </span>
          </a>
        </li>`;
    })
    .join('\n        ');

  const upcomingHtml = upcoming.length > 0
    ? `
      <h2>Komende shows in Amsterdam</h2>
      ${artistFeaturedHtml ? `<div class="featured-grid">${artistFeaturedHtml}</div>` : ''}
      ${artistListHtml ? `<ul class="lines">
        ${artistListHtml}
      </ul>` : ''}
    `
    : `<p>Geen geplande shows in Amsterdam op dit moment. Bewaar ${escapeHtml(
        artist.name
      )} in de ANDREAS-app om een melding te krijgen zodra er één bij komt.</p>`;

  const breadcrumbHtml = `
    <nav class="breadcrumb" aria-label="Kruimelpad">
      <a href="/">ANDREAS</a><span>›</span>
      <a href="/artists">Artists</a><span>›</span>
      ${escapeHtml(artist.name)}
    </nav>
  `;

  return `<!doctype html>
<html lang="nl">
<head>${head}</head>
<body class="has-sticky-cta">
  ${renderAppBanner(appLink, artist.name)}
  ${renderMobileStickyCta(appLink, artist.name)}
  <main>
    <article>
      ${breadcrumbHtml}
      <div class="hero">
        <h1>${escapeHtml(artist.name)}</h1>
        <p class="lead">${leadParts.join(' ')}</p>
      </div>
      ${genreHtml}
      <div class="page-grid">
        <div class="page-main">
          ${linksHtml}
          ${aboutHtml}
          ${upcomingHtml}
        </div>
        <aside class="page-aside">
          ${renderCtaCard({
            deeplink: appLink,
            title: `Volg ${artist.name} in ANDREAS`,
            body: 'Krijg een melding zodra er een nieuwe show in Amsterdam bij komt, en zie welke vrienden ook gaan.',
            qrUrl: `${PUBLIC_BASE_URL}/a/${artist.id}`,
          })}
        </aside>
      </div>
    </article>
    ${renderSiteFooter()}
  </main>
  ${renderSiteScripts()}
</body>
</html>`;
}

type ArtistsIndexRow = {
  id: string;
  name: string;
  genres: string[];
  description: string | null;
  spotifyUrl: string | null;
  appleMusicUrl: string | null;
  bandcampUrl: string | null;
  youtubeUrl: string | null;
  officialUrl: string | null;
  nextStart: Date;
  showCount: number;
};

function renderArtistsIndexPage(opts: {
  artists: ArtistsIndexRow[];
}): string {
  const { artists } = opts;
  const TOP_COUNT = 30;

  const pageTitle = 'Artists in Amsterdam · Komende shows | ANDREAS';
  const desc =
    `Wie staat er binnenkort in Amsterdam op de bühne? ${artists.length} ` +
    `artists met komende concerten en clubavonden — met links naar Spotify, ` +
    `Apple Music en meer.`;

  // Top tier: meest-geprogrammeerde acts eerst (showCount desc, dan
  // alfabetisch). Geeft bezoekers direct de herkenbare namen; long-tail
  // staat eronder in een collapsible alfabetische browse.
  const top = [...artists]
    .sort(
      (a, b) =>
        b.showCount - a.showCount || a.name.localeCompare(b.name)
    )
    .slice(0, TOP_COUNT);

  // Alfabetische groepering over ALLE artists (incl. de top — zo blijft
  // browse-by-letter compleet). Groepen 0-9 als '#'.
  const groups = new Map<string, ArtistsIndexRow[]>();
  for (const a of artists) {
    const first = a.name.trim().charAt(0).toUpperCase();
    const key = /[A-Z]/.test(first) ? first : '#';
    const list = groups.get(key) ?? [];
    list.push(a);
    groups.set(key, list);
  }
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    if (a === '#') return 1;
    if (b === '#') return -1;
    return a.localeCompare(b);
  });

  // ItemList JSON-LD — geeft Google + AI's de volledige lijst als
  // structured data. We cappen op 100 zodat de payload niet ontspoort
  // (bij groei: pagineer later).
  const itemListLd = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: artists.slice(0, 100).map((a, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      url: `${PUBLIC_BASE_URL}/a/${a.id}`,
      name: a.name,
    })),
  };

  const breadcrumb = breadcrumbJsonLd([
    { name: 'ANDREAS', path: '/' },
    { name: 'Artists', path: '/artists' },
  ]);

  const head = renderHead({
    title: pageTitle,
    description: desc,
    canonicalPath: '/artists',
    ogType: 'website',
    apple: { appId: APPLE_APP_ID, appArgument: 'andreas://muziek' },
    jsonLdBlocks: [jsonLd(itemListLd), breadcrumb],
    extraStyles: PAGE_GRID_STYLES + LIST_STYLES + ARTIST_INDEX_STYLES,
  });

  const lead =
    `Artists die binnenkort meerdere keren in Amsterdam te zien zijn. ` +
    `${artists.length} totaal — klik door voor data, venues en luister-links.`;

  const renderArtistRow = (a: ArtistsIndexRow) => {
    const meta = [
      a.showCount === 1 ? '1 show' : `${a.showCount} shows`,
      a.genres.slice(0, 2).join(', '),
    ]
      .filter(Boolean)
      .join(' · ');
    return `<li>
        <a class="row-link" href="/a/${escapeHtml(a.id)}">
          <span class="thumb thumb-placeholder" aria-hidden="true"></span>
          <span class="row-text">
            <span class="title">${escapeHtml(a.name)}</span>
            <span class="meta">${escapeHtml(meta)}</span>
          </span>
        </a>
      </li>`;
  };

  const topHtml = top.map(renderArtistRow).join('\n      ');

  const alphabetNav = `
    <nav class="alpha-nav" aria-label="Spring naar letter">
      ${sortedKeys
        .map((k) => `<a href="#letter-${escapeHtml(k)}">${escapeHtml(k)}</a>`)
        .join('')}
    </nav>
  `;

  const groupsHtml = sortedKeys
    .map((k) => {
      const list = groups.get(k)!;
      const rows = list.map(renderArtistRow).join('\n      ');
      return `
      <h2 id="letter-${escapeHtml(k)}" class="alpha-heading">${escapeHtml(k)}</h2>
      <ul class="lines">
        ${rows}
      </ul>
    `;
    })
    .join('\n');

  const breadcrumbHtml = `
    <nav class="breadcrumb" aria-label="Kruimelpad">
      <a href="/">ANDREAS</a><span>›</span>
      Artists
    </nav>
  `;

  return `<!doctype html>
<html lang="nl">
<head>${head}</head>
<body class="has-sticky-cta">
  ${renderAppBanner('andreas://muziek', 'Muziek in Amsterdam')}
  ${renderMobileStickyCta('andreas://muziek', 'Muziek in Amsterdam')}
  <main>
    <article>
      ${breadcrumbHtml}
      <div class="hero">
        <h1>Artists binnenkort in Amsterdam</h1>
        <p class="lead">${escapeHtml(lead)}</p>
      </div>
      <div class="page-grid">
        <div class="page-main">
          ${artists.length === 0
            ? '<p>Nog geen artists in beeld — kom morgen terug.</p>'
            : `
              <div class="section-head">
                <h2>Meest geprogrammeerd</h2>
                <span class="section-count">top ${top.length}</span>
              </div>
              <ul class="lines">
                ${topHtml}
              </ul>
              ${artists.length > TOP_COUNT
                ? `<details class="artists-more">
                    <summary>Bekijk alle ${artists.length} artists alfabetisch</summary>
                    ${alphabetNav}
                    ${groupsHtml}
                  </details>`
                : ''}
            `}
        </div>
        <aside class="page-aside">
          ${renderCtaCard({
            deeplink: 'andreas://muziek',
            title: 'Volg muziek in ANDREAS',
            body: 'Bewaar artists, krijg een melding bij nieuwe shows, en ontdek meer in Amsterdam.',
            qrUrl: `${PUBLIC_BASE_URL}/artists`,
          })}
        </aside>
      </div>
    </article>
    ${renderSiteFooter()}
  </main>
  ${renderSiteScripts()}
</body>
</html>`;
}

/**
 * Extra CSS voor de /a/:slug artist-pagina: substantiële streaming-
 * buttons in een rij, ipv tag-pillen. 6px radius zoals gevraagd, bgLift
 * voor diepte, ↗-pijl via ::after.
 */
const ARTIST_PAGE_STYLES = `
  .streaming-btns {
    display: flex; flex-wrap: wrap; gap: 8px;
    margin: 8px 0 32px;
  }
  .streaming-btn {
    display: inline-flex; align-items: center; gap: 10px;
    padding: 12px 18px;
    background: var(--bg-lift);
    color: var(--fg);
    border-radius: 6px;
    font-family: 'Archivo', sans-serif;
    font-weight: 600;
    font-size: 14px;
    letter-spacing: -0.1px;
    transition: background 120ms, color 120ms;
  }
  .streaming-btn:hover {
    background: var(--bg-chip);
    color: var(--acid);
    text-decoration: none;
  }
  /* Platform-icoon meet 18px; flex-shrink: 0 zorgt dat 'ie niet
     samentrekt als de container krap wordt. Color via currentColor
     erfeert van de button (fg → acid op hover). */
  .streaming-icon {
    display: inline-flex; align-items: center;
    flex-shrink: 0;
    width: 18px; height: 18px;
  }
  .streaming-icon svg { display: block; }
`;

/**
 * Extra CSS voor de /artists-index: alfabet-navbar bovenaan en wat
 * extra ademruimte tussen letter-secties. Apart van SEO_STYLES omdat
 * 't alleen op deze pagina nodig is.
 */
const ARTIST_INDEX_STYLES = `
  /* Section-header voor "Meest geprogrammeerd" — kicker + count rechts. */
  .section-head {
    display: flex; align-items: baseline; gap: 18px;
    margin: 8px 0 16px;
    padding-top: 16px;
    border-top: 1px solid var(--border-soft);
  }
  .section-head h2 {
    margin: 0;
  }
  .section-head .section-count {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 11px; letter-spacing: 1.4px; text-transform: uppercase;
    color: var(--fg-faint);
    margin-left: auto;
  }
  /* "Bekijk alle X artists alfabetisch" toggle — zelfde stijl als
     details.venues-more op de homepage: strakke lijn, acid +/- indicator,
     mono uppercase summary. */
  details.artists-more {
    margin: 24px 0 32px;
  }
  details.artists-more > summary {
    cursor: pointer;
    list-style: none;
    padding: 16px 0;
    border-top: 1px solid var(--border-soft);
    border-bottom: 1px solid var(--border-soft);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 12px; letter-spacing: 1.2px; text-transform: uppercase;
    color: var(--fg-muted);
    transition: color 120ms;
    position: relative;
    padding-right: 32px;
  }
  details.artists-more > summary:hover { color: var(--acid); }
  details.artists-more > summary::-webkit-details-marker { display: none; }
  details.artists-more > summary::after {
    content: "+"; position: absolute; right: 4px; top: 50%;
    transform: translateY(-50%); font-size: 18px;
    color: var(--acid);
    font-weight: 700;
  }
  details.artists-more[open] > summary::after { content: "−"; }
  details.artists-more[open] > summary { color: var(--acid); }
  .alpha-nav {
    display: flex; flex-wrap: wrap; gap: 6px;
    margin: 24px 0 32px;
    padding: 14px 18px;
    background: var(--bg-lift);
    border-radius: 12px;
  }
  .alpha-nav a {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 13px; letter-spacing: 1px;
    padding: 6px 10px; border-radius: 6px;
    color: var(--fg);
    min-width: 28px; text-align: center;
  }
  .alpha-nav a:hover {
    background: var(--bg-chip); color: var(--acid);
    text-decoration: none;
  }
  .alpha-heading {
    font-size: 14px; letter-spacing: 2px;
    text-transform: uppercase;
    color: var(--fg-muted);
    border-bottom: 1px solid var(--border-soft);
    padding-bottom: 8px;
    margin: 32px 0 0;
    font-weight: 600;
    scroll-margin-top: 24px;
  }
  .alpha-heading:first-of-type { margin-top: 8px; }
  /* Onder de letter-heading staat een ul.lines — overlap de top-border
     met de heading-border zodat het er als één scheidingslijn uitziet. */
  .alpha-heading + ul.lines { margin-top: 0; }
  .alpha-heading + ul.lines li:first-child { border-top: 0; }
`;

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
    | undefined,
  ua: string,
  lang: 'nl' | 'en' = 'nl'
): string {
  const eventTitle = row?.title ?? 'ANDREAS';
  const eventImage = row?.imageUrl ?? '';
  const refQs = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const appLink = `andreas://event/${encodeURIComponent(id)}${refQs}`;
  const universalLink = `${PUBLIC_BASE_URL}/e/${encodeURIComponent(id)}${refQs}`;
  // OG-image URL krijgt ?lang=… mee zodat messaging-apps de juiste
  // taalversie van de composite-image fetchen. Zonder dit fallback'te
  // 't naar NL omdat WhatsApp/iMessage geen Accept-Language sturen.
  const ogImageUrl = `${PUBLIC_BASE_URL}/e/${encodeURIComponent(id)}/og.png${lang === 'en' ? '?lang=en' : ''}`;
  const { url: storeUrl, label: storeLabel } = pickStore(ua);

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
  <meta property="og:image" content="${escapeHtml(ogImageUrl)}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:url" content="${escapeHtml(universalLink)}" />
  <meta property="og:type" content="website" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:image" content="${escapeHtml(ogImageUrl)}" />
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
    <a class="fallback" href="${escapeHtml(storeUrl)}">Nog geen ANDREAS? Download in ${escapeHtml(storeLabel)}</a>
  </main>
  <script>
    (function () {
      var app = ${JSON.stringify(appLink)};
      var store = ${JSON.stringify(storeUrl)};
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
  row: VenueRow | undefined,
  ua: string
): string {
  const venueName = row?.name ?? 'ANDREAS';
  const venueImage = row?.imageUrl ?? '';
  const refQs = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const appLink = `andreas://venue/${encodeURIComponent(slug)}${refQs}`;
  const universalLink = `${PUBLIC_BASE_URL}/v/${encodeURIComponent(slug)}${refQs}`;
  const { url: storeUrl, label: storeLabel } = pickStore(ua);

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
    <a class="fallback" href="${escapeHtml(storeUrl)}">Nog geen ANDREAS? Download in ${escapeHtml(storeLabel)}</a>
  </main>
  <script>
    (function () {
      var app = ${JSON.stringify(appLink)};
      var store = ${JSON.stringify(storeUrl)};
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
  const { url: storeUrl, label: storeLabel } = pickStore(
    c.req.header('user-agent') ?? ''
  );

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
    <a class="fallback" href="${escapeHtml(storeUrl)}">Nog geen ANDREAS? Download in ${escapeHtml(storeLabel)}</a>
  </main>
  <script>
    (function () {
      var app = ${JSON.stringify(appLink)};
      var store = ${JSON.stringify(storeUrl)};
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
 * /i/:token  —  friend-invite share. Opent app via universal-link;
 *               iOS pakt 'm via AASA-component /i/*. App parsed de
 *               token + claimt via POST /share-invites/:token/claim
 *               zodra de user ingelogd is.
 * ====================================================================== */

/**
 * OG-image voor share-invite — avatar + app-icon composite. 1200×630.
 * Caching long: per-token zelfde input → zelfde output, en messaging-
 * apps gretig op caching.
 */
shareRoute.get('/i/:token/og.png', async (c) => {
  const token = c.req.param('token');
  const safeToken = token.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  const [row] = await db
    .select({
      name: schema.users.name,
      handle: schema.users.handle,
      avatarUrl: schema.users.avatarUrl,
    })
    .from(schema.shareInvites)
    .innerJoin(
      schema.users,
      eq(schema.users.id, schema.shareInvites.fromUserId)
    )
    .where(eq(schema.shareInvites.token, safeToken))
    .limit(1);
  const displayName =
    row && row.name && !row.name.startsWith('+') ? row.name : '';
  const inviterName =
    displayName || (row?.handle ? `@${row.handle}` : 'Iemand');
  // Taal-detectie: ?lang=en overschrijft alles; anders Accept-Language
  // van de browser (eerste taal-tag). Default NL. Messaging-apps die
  // de OG-preview ophalen sturen vaak géén Accept-Language — die
  // krijgen NL.
  const langParam = c.req.query('lang');
  const acceptLang = c.req.header('accept-language') ?? '';
  const locale: 'nl' | 'en' =
    langParam === 'en' || /^\s*en\b/i.test(acceptLang) ? 'en' : 'nl';
  const png = await renderInviteOg({
    avatarUrl: row?.avatarUrl ?? null,
    inviterName,
    locale,
  });
  // Buffer→ArrayBuffer copy: Hono wil 'n strict Uint8Array<ArrayBuffer>;
  // Node's Buffer kan SharedArrayBuffer-backed zijn. Een nieuwe
  // ArrayBuffer-allocatie via .slice() lost het op.
  const ab = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength);
  const bytes = new Uint8Array(ab as ArrayBuffer);
  return c.body(bytes, 200, {
    'Content-Type': 'image/png',
    'Cache-Control': 'public, max-age=86400, immutable',
  });
});

/**
 * OG-image voor event-share — event-poster in rounded square + Andreas
 * app-badge bottom-right. 1200×630. Locale via ?lang=… of Accept-
 * Language; default NL.
 */
shareRoute.get('/e/:id/og.png', async (c) => {
  const id = c.req.param('id').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
  const [row] = await db
    .select({
      title: schema.events.title,
      imageUrl: schema.events.imageUrl,
      venueName: schema.venues.name,
    })
    .from(schema.events)
    .innerJoin(schema.venues, eq(schema.venues.id, schema.events.venueId))
    .where(eq(schema.events.id, id))
    .limit(1);
  if (!row) return c.body('not found', 404);
  const langParam = c.req.query('lang');
  const acceptLang = c.req.header('accept-language') ?? '';
  const locale: 'nl' | 'en' =
    langParam === 'en' || /^\s*en\b/i.test(acceptLang) ? 'en' : 'nl';
  const png = await renderEventOg({
    eventImageUrl: row.imageUrl,
    eventTitle: row.title,
    venueName: row.venueName,
    locale,
  });
  const ab = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength);
  const bytes = new Uint8Array(ab as ArrayBuffer);
  return c.body(bytes, 200, {
    'Content-Type': 'image/png',
    'Cache-Control': 'public, max-age=86400, immutable',
  });
});

shareRoute.get('/i/:token', async (c) => {
  const token = c.req.param('token');
  const safeToken = token.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  // Platform-detect via UA — anders krijgen Android-bezoekers de
  // App-Store-link voorgeschoteld. iOS = default fallback (universal
  // link slaagt sowieso meestal); Android stuurt naar Play Store.
  const ua = c.req.header('user-agent') ?? '';
  const isAndroid = /Android/i.test(ua);
  const storeUrl = isAndroid ? PLAY_STORE_URL : APP_STORE_URL;
  const storeLabel = isAndroid ? 'Google Play' : 'App Store';
  // ?lang= bubbelt door naar de og:image-URL zodat messaging-apps de
  // EN-versie van de composite-image fetchen wanneer de share-link
  // met ?lang=en gegenereerd is.
  const lang: 'nl' | 'en' = c.req.query('lang') === 'en' ? 'en' : 'nl';
  const ogLangQs = lang === 'en' ? '?lang=en' : '';

  // Toon de uitnodiger op de fallback-pagina (avatar + naam). We
  // lookuppen via de share_invites + users join. Verlopen of niet-
  // bestaande tokens tonen we als 'algemene' uitnodiging, geen 404 —
  // dan kan de gebruiker alsnog de app downloaden zonder fout.
  const [row] = await db
    .select({
      name: schema.users.name,
      handle: schema.users.handle,
      avatarUrl: schema.users.avatarUrl,
      expiresAt: schema.shareInvites.expiresAt,
    })
    .from(schema.shareInvites)
    .innerJoin(
      schema.users,
      eq(schema.users.id, schema.shareInvites.fromUserId)
    )
    .where(eq(schema.shareInvites.token, safeToken))
    .limit(1);

  const expired = row ? row.expiresAt.getTime() < Date.now() : false;
  const displayName =
    row && row.name && !row.name.startsWith('+') ? row.name : '';
  const handleLabel = row?.handle ?? null;
  const inviterDisplay = displayName || (handleLabel ? `@${handleLabel}` : 'iemand');

  const appLink = `andreas://i/${encodeURIComponent(safeToken)}`;
  const universalLink = `${PUBLIC_BASE_URL}/i/${encodeURIComponent(safeToken)}`;

  const title = row && !expired
    ? `${inviterDisplay} nodigt je uit op ANDREAS`
    : 'Doe mee op ANDREAS';
  const subTitle = row && !expired
    ? 'Download de app, log in en jullie zijn vrienden.'
    : 'Anti-algoritme uitgaansapp voor Amsterdam.';

  const html = `<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(subTitle)}" />
  <meta property="og:image" content="${escapeHtml(PUBLIC_BASE_URL)}/i/${escapeHtml(safeToken)}/og.png${ogLangQs}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:image" content="${escapeHtml(PUBLIC_BASE_URL)}/i/${escapeHtml(safeToken)}/og.png${ogLangQs}" />
  <meta property="og:url" content="${escapeHtml(universalLink)}" />
  <meta property="og:type" content="website" />
  <meta name="apple-itunes-app" content="app-id=${APPLE_APP_ID}, app-argument=${escapeHtml(appLink)}" />
  <meta name="robots" content="noindex" />
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; background: #0a0a0b; color: #f2f2ef; font-family: -apple-system, system-ui, sans-serif; }
    main { max-width: 420px; margin: 0 auto; padding: 56px 24px; text-align: center; }
    h1 { font-size: 26px; line-height: 1.1; letter-spacing: -0.6px; margin: 16px 0 8px; font-weight: 900; }
    p { color: #9a9a94; margin: 4px 0 24px; font-size: 14px; line-height: 1.4; }
    a.cta { display: inline-block; background: #d4ff3a; color: #0a0a0b; padding: 14px 22px; border-radius: 999px; text-decoration: none; font-weight: 600; }
    a.fallback { display: block; margin-top: 16px; color: #9a9a94; font-size: 12px; }
    .avatar { width: 96px; height: 96px; border-radius: 999px; object-fit: cover; background: #17171a; margin: 0 auto; }
    .kicker { font-family: ui-monospace, monospace; font-size: 11px; letter-spacing: 1.4px; text-transform: uppercase; color: #d4ff3a; }
    .expired { color: #ff7a7a; font-size: 13px; margin-top: 8px; }
  </style>
</head>
<body>
  <main>
    <div class="kicker">ANDREAS · vrienden</div>
    ${row?.avatarUrl ? `<img class="avatar" src="${escapeHtml(row.avatarUrl)}" alt="" />` : '<div class="avatar"></div>'}
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(subTitle)}</p>
    ${expired ? `<p class="expired">Deze uitnodiging is verlopen — je kunt de app wel downloaden en daarna alsnog vrienden worden.</p>` : ''}
    <a class="cta" href="${escapeHtml(appLink)}" id="open">Open in ANDREAS</a>
    <a class="fallback" href="${escapeHtml(storeUrl)}">Nog geen ANDREAS? Download in ${escapeHtml(storeLabel)}</a>
  </main>
  <script>
    (function () {
      var app = ${JSON.stringify(appLink)};
      var store = ${JSON.stringify(storeUrl)};
      var t = setTimeout(function () { window.location.href = store; }, 1200);
      window.addEventListener('pagehide', function () { clearTimeout(t); });
      window.location.href = app;
    })();
  </script>
</body>
</html>`;

  c.header('Content-Type', 'text/html; charset=utf-8');
  c.header('Cache-Control', 'no-store');
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
        genres: displayGenres,
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
        genres: displayGenres,
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
    // pad-met-alle-venues-anchors om in te crawlen. imageUrl erbij voor
    // de homepage venue-card-grid.
    db
      .select({
        slug: schema.venues.slug,
        name: schema.venues.name,
        type: schema.venues.type,
        wijk: schema.venues.wijk,
        imageUrl: schema.venues.imageUrl,
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
      answer: `Op dit moment ${venues.length} Amsterdamse venues, waaronder Paradiso, Melkweg, OCCII, OT301, Stedelijk Museum, Rijksmuseum, FOAM, Concertgebouw, Bimhuis, EYE Filmmuseum, Carré en DeLaMar. Van clubs tot musea en van filmhuizen tot literaire podia.`,
    },
    {
      question: 'Werkt ANDREAS in andere steden?',
      answer:
        'Op dit moment alleen in Amsterdam. ANDREAS is gemaakt voor Amsterdam en houdt zich daar voorlopig bij. Suggesties voor andere steden zijn welkom via wij@andreas.amsterdam.',
    },
    {
      question: AI_CONNECT_FAQ[0].question,
      answer: AI_CONNECT_FAQ[0].answer,
    },
  ];
  const homeFaqLd = faqJsonLd(homeFaq);

  // Alle events als grote 16:9 magazine-cards — homepage als visueel
  // spectakel. De fallback-list is eruit; we tonen elk event volwaardig.
  const showsFeaturedHtml = upcomingShows
    .map((e) =>
      renderFeaturedCard({
        href: `/e/${e.eventId}`,
        imageUrl: e.imageUrl,
        when: formatShort(e.startsAt),
        title: e.title,
        meta: renderEventMeta(e.venueName, e.genres),
      })
    )
    .join('\n      ');

  const exhibitionWhen = (endsAt: Date | null) =>
    endsAt
      ? `t/m ${endsAt.toLocaleDateString('nl-NL', {
          day: 'numeric',
          month: 'short',
          timeZone: 'Europe/Amsterdam',
        })}`
      : '';

  const exhibitionsFeaturedHtml = upcomingExhibitions
    .map((e) =>
      renderFeaturedCard({
        href: `/e/${e.eventId}`,
        imageUrl: e.imageUrl,
        when: exhibitionWhen(e.endsAt),
        title: e.title,
        meta: renderEventMeta(e.venueName, e.genres),
      })
    )
    .join('\n      ');

  // Venues: eerste 30 visible, rest in <details>. Beide secties zitten
  // gewoon in de HTML — Google crawlt en indexeert <details>-content,
  // dus alle 197 venue-links blijven volwaardig anchors voor PageRank.
  const VENUE_VISIBLE_COUNT = 30;
  const venuesVisible = venues.slice(0, VENUE_VISIBLE_COUNT);
  const venuesHidden = venues.slice(VENUE_VISIBLE_COUNT);

  // Venue als compacte card met 1:1 image bovenaan + naam + meta-rij.
  // 4 op een rij in het home-feed grid op desktop, 2 op tablet, 1 op
  // mobile. Image is square (anders dan event-cards 16:9) zodat we 4
  // cards per row krijgen zonder dat ze té hoog worden.
  const renderVenueCard = (v: typeof venues[number]) => {
    const label = venueTypeLabel(v.type as ApiVenueType);
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

  // Voor de collapsible "Toon alle venues"-rest: lichter, lijst-style
  // ipv cards (anders te veel beeld). Behoud van interne link-density.
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

  const venuesVisibleHtml = venuesVisible.map(renderVenueCard).join('\n      ');
  const venuesHiddenHtml = venuesHidden.map(renderVenueRow).join('\n      ');

  const html = `<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8" />
  <title>ANDREAS — uitgaan in Amsterdam</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="ANDREAS bundelt de meest complete agenda van Amsterdam in één app: concerten, clubavonden, exposities, theater, film en literaire events — wat er vanavond is en wat eraan komt, op één plek." />
  <link rel="canonical" href="${PUBLIC_BASE_URL}/" />
  <link rel="icon" type="image/png" sizes="16x16" href="${PUBLIC_BASE_URL}/favicon-16.png" />
  <link rel="icon" type="image/png" sizes="32x32" href="${PUBLIC_BASE_URL}/favicon-32.png" />
  <link rel="icon" type="image/png" sizes="48x48" href="${PUBLIC_BASE_URL}/favicon.png" />
  <link rel="apple-touch-icon" sizes="180x180" href="${PUBLIC_BASE_URL}/apple-touch-icon.png" />
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
      max-width: 1100px; width: 100%;
      margin: 0 auto; padding: 64px 28px 96px;
    }
    /* Hero — bovenaan de linker home-intro kolom, links uitgelijnd. */
    .hero { text-align: left; margin-bottom: 32px; }
    /* Home-grid: links sticky verhaal+stores, rechts scroll-feed met
       events + venues + FAQ. Single column op mobile. */
    .home-grid {
      display: grid;
      gap: 56px;
      grid-template-columns: 1fr;
    }
    @media (min-width: 900px) {
      .home-grid {
        grid-template-columns: minmax(320px, 400px) 1fr;
        gap: 72px;
        align-items: start;
      }
      .home-intro {
        position: sticky;
        /* Onder het topmenu (~48px) met 20px ademruimte. Zelfde formule
           als .page-aside op detail-pagina's. */
        top: 68px;
        align-self: start;
      }
    }
    .home-intro { min-width: 0; }
    .home-feed { min-width: 0; }
    /* Venues als 4-koloms cards-grid op desktop, 2-col tablet, 1-col
       mobile. 1:1 image bovenaan + naam + type/wijk eronder.
       Magazine-feel, geen lange tekst-lijst. */
    .venues-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 14px;
      margin: 0 0 24px;
    }
    @media (min-width: 540px) {
      .venues-grid { grid-template-columns: 1fr 1fr; }
    }
    @media (min-width: 900px) {
      .venues-grid { grid-template-columns: repeat(4, 1fr); gap: 16px; }
    }
    .venue-card {
      display: flex; flex-direction: column;
      background: var(--bg-lift);
      border-radius: 12px;
      overflow: hidden;
      color: var(--fg);
      text-decoration: none;
      transition: transform 220ms, box-shadow 220ms;
    }
    .venue-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
      text-decoration: none;
    }
    .venue-card-img-wrap {
      display: block;
      aspect-ratio: 1 / 1;
      background: var(--bg);
      overflow: hidden;
      position: relative;
    }
    .venue-card-img {
      width: 100%; height: 100%;
      object-fit: cover;
      display: block;
      transition: transform 480ms;
    }
    .venue-card:hover .venue-card-img { transform: scale(1.04); }
    .venue-card-img-placeholder {
      width: 100%; height: 100%;
      display: block; position: relative;
    }
    .venue-card-img-placeholder::before,
    .venue-card-img-placeholder::after {
      content: ""; position: absolute; top: 50%; left: 28%;
      width: 44%; height: 10px; margin-top: -5px;
      background: var(--acid); opacity: 0.35;
    }
    .venue-card-img-placeholder::before { transform: rotate(45deg); }
    .venue-card-img-placeholder::after { transform: rotate(-45deg); }
    .venue-card-body {
      display: flex; flex-direction: column; gap: 2px;
      padding: 10px 12px 14px;
    }
    .venue-card-title {
      font-family: 'Archivo', sans-serif;
      font-weight: 700;
      font-size: 14px;
      letter-spacing: -0.2px;
      line-height: 1.2;
      color: var(--fg);
    }
    .venue-card-meta {
      color: var(--fg-muted);
      font-size: 11px;
      letter-spacing: 0.2px;
      margin-top: 2px;
    }
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
    h1.h1 {
      font-family: 'Archivo', sans-serif;
      font-weight: 900;
      font-size: 26px;
      letter-spacing: -0.6px;
      line-height: 1.2;
      margin: 0 0 14px;
      color: var(--fg);
      max-width: 640px;
    }
    .tagline {
      font-family: 'Archivo', sans-serif;
      font-weight: 600;
      font-size: 19px;
      letter-spacing: -0.3px;
      line-height: 1.3;
      margin: 0 0 24px;
      color: var(--fg-muted);
    }
    .intro {
      font-size: 16px; line-height: 1.55;
      color: var(--fg-read); margin: 0 0 18px;
      max-width: 580px;
    }
    .intro:last-of-type { margin-bottom: 32px; }
    .intro strong { color: var(--fg); font-weight: 700; }
    .intro--cta { font-weight: 600; color: var(--fg); }
    /* Store-buttons */
    .stores {
      display: flex; gap: 10px; flex-wrap: wrap;
      margin: 0 0 80px;
      align-items: center;
    }
    /* QR-blok in de home-stores: standaard verborgen, alleen zichtbaar
       als data-platform="desktop". Vul de hele container-breedte;
       QR-image links, hint-tekst rechts. */
    .home-qr {
      display: none;
      align-items: center; gap: 18px;
      padding: 16px 20px;
      background: var(--bg-lift);
      border-radius: 12px;
      width: 100%;
      box-sizing: border-box;
    }
    .home-qr-image {
      width: 120px; height: 120px;
      padding: 8px;
      background: #fff;
      border-radius: 8px;
      flex-shrink: 0;
    }
    .home-qr-image svg { width: 100%; height: 100%; display: block; }
    .home-qr-body {
      display: flex; flex-direction: column; gap: 6px;
      min-width: 0;
    }
    .home-qr-platforms {
      display: inline-flex; align-items: center; gap: 6px;
      color: var(--acid);
    }
    .home-qr-kicker {
      color: var(--fg-muted);
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 11px; letter-spacing: 1.4px; text-transform: uppercase;
    }
    .home-qr-hint {
      color: var(--fg);
      font-family: 'Archivo', sans-serif;
      font-weight: 700;
      font-size: 16px;
      letter-spacing: -0.2px;
      line-height: 1.3;
    }
    html[data-platform="desktop"] .home-qr { display: flex; }
    html[data-platform="desktop"] .stores .store-btn { display: none; }
    /* Store-knoppen als card-buttons (zoals in de app): bgLift-vlak,
       6px radius, icoon links-uitgelijnd, daarnaast acid-kicker boven
       en witte titel onder. Geen acid-bg meer — alleen het icoon en
       de kicker zijn acid. */
    .store-btn {
      flex: 1; min-width: 180px;
      display: inline-flex; align-items: center; gap: 14px;
      padding: 14px 18px;
      border-radius: 12px;
      background: var(--bg-lift);
      color: var(--fg);
      text-decoration: none;
      transition: background 120ms;
    }
    .store-btn:hover { background: var(--bg-chip); }
    .store-btn .store-icon {
      flex-shrink: 0;
      color: var(--acid);
    }
    .store-btn > div { min-width: 0; }
    .store-btn small {
      display: block;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 10px; letter-spacing: 1.2px; text-transform: uppercase;
      color: var(--acid);
      margin-bottom: 3px;
      font-weight: 600;
    }
    .store-btn span {
      font-weight: 800; font-size: 17px; letter-spacing: -0.2px;
      color: var(--fg);
    }
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
    ${HEADER_STYLES}
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
    /* "Toon alle venues"-toggle — strakke lijn met acid-accent.
       Ademruimte boven zodat 'ie niet plakt op de 4-koloms cards-grid. */
    details.venues-more {
      margin: 32px 0 56px;
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
    ${AI_CONNECT_STYLES}
  </style>
</head>
<body class="has-sticky-cta">
  ${renderAppBanner('andreas://', 'Uitgaan in Amsterdam')}
  ${renderMobileStickyCta('andreas://', 'Uitgaan in Amsterdam')}
  <main>
    <div class="home-grid">
      <aside class="home-intro">
        <header class="hero">
          <div class="logo">
            <span class="logo-text">ANDREAS</span>
            <span class="cross" aria-hidden="true"></span>
          </div>
          <p class="kicker">amsterdam culture</p>
        </header>
        <h1 class="h1">Uitgaan in Amsterdam — alle events in één app</h1>
        <p class="tagline">Heel Amsterdam, in één agenda.</p>
        <p class="intro">
          ANDREAS bundelt <strong>de complete uitgaansagenda van Amsterdam</strong>
          in één app: concerten, clubavonden, exposities, theater, film en
          literaire events. Wat er vanavond is, en wat eraan komt — op één plek.
          Sla je favoriete venues op, krijg een herinnering voor wat je niet
          wilt missen, en zie welke vrienden ook gaan.
        </p>
        <p class="intro intro--cta">
          Download ANDREAS gratis en ontdek meer in Amsterdam.
        </p>

        <div class="stores">
          <a class="store-btn" data-cta="appstore" href="${escapeHtml(APP_STORE_URL)}">
            <svg class="store-icon" width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09ZM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25Z"/></svg>
            <div><small>Download op de</small><span>App Store</span></div>
          </a>
          <a class="store-btn" data-cta="playstore" href="${escapeHtml(PLAY_STORE_URL)}">
            <svg class="store-icon" width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3.609 1.814 13.792 12 3.61 22.186a.996.996 0 0 1-.61-.92V2.734a1 1 0 0 1 .609-.92Zm10.89 10.893 2.302 2.302-10.937 6.333 8.635-8.635Zm3.199-3.198 2.807 1.626a1 1 0 0 1 0 1.73l-2.808 1.626L15.206 12l2.492-2.491ZM5.864 2.658 16.802 8.99l-2.303 2.303-8.635-8.635Z"/></svg>
            <div><small>Verkrijgbaar via</small><span>Google Play</span></div>
          </a>
          <div class="home-qr" data-cta="qr">
            <div class="home-qr-image" aria-hidden="true">${renderQrSvg(PUBLIC_BASE_URL + '/')}</div>
            <div class="home-qr-body">
              <span class="home-qr-platforms" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09ZM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25Z"/></svg>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M17.523 15.34a1.13 1.13 0 1 1 1.131-1.13 1.13 1.13 0 0 1-1.131 1.13Zm-11.06 0a1.13 1.13 0 1 1 1.131-1.13 1.13 1.13 0 0 1-1.131 1.13Zm11.46-6.16 2.26-3.91a.47.47 0 0 0-.81-.47l-2.29 3.96a14.06 14.06 0 0 0-11.18 0L3.62 4.8a.47.47 0 1 0-.81.47l2.26 3.91A13.06 13.06 0 0 0 0 17.66h24a13.06 13.06 0 0 0-5.077-8.48Z"/></svg>
              </span>
              <span class="home-qr-kicker">Beschikbaar voor iPhone en Android</span>
              <span class="home-qr-hint">Scan om ANDREAS te downloaden</span>
            </div>
          </div>
        </div>

        ${renderAiPromo()}
      </aside>

      <div class="home-feed">
    <nav class="hub-nav" aria-label="Browse">
      <a href="/vandaag">Vandaag</a>
      <a href="/dit-weekend">Dit weekend</a>
      <span class="sep">·</span>
      <a href="/muziek">Muziek</a>
      <a href="/artists">Artists</a>
      <a href="/theater">Theater</a>
      <a href="/film">Film</a>
      <a href="/kunst">Kunst</a>
      <a href="/literatuur">Literatuur</a>
      <span class="sep">·</span>
      <a href="/clubs">Clubs</a>
      <a href="/podia">Podia</a>
      <a href="/musea">Musea</a>
      <a href="/galeries">Galeries</a>
      <a href="/filmhuizen">Filmhuizen</a>
    </nav>

    <section>
      <div class="section-head">
        <h2>Komende events</h2>
        <span class="count">eerstvolgende ${upcomingShows.length}</span>
      </div>
      ${showsFeaturedHtml ? `<div class="featured-grid">${showsFeaturedHtml}</div>` : ''}
    </section>

    ${upcomingExhibitions.length > 0 ? `<section>
      <div class="section-head">
        <h2>Lopende exhibitions</h2>
        <span class="count">sluit eerst</span>
      </div>
      ${exhibitionsFeaturedHtml ? `<div class="featured-grid">${exhibitionsFeaturedHtml}</div>` : ''}
    </section>` : ''}

    <section>
      <div class="section-head">
        <h2>Venues in Amsterdam</h2>
        <span class="count">${venues.length} venues</span>
      </div>
      <div class="venues-grid">
        ${venuesVisibleHtml}
      </div>
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
      </div>
    </div>

    <footer class="site">
      <p>
        <a href="/privacy">Privacy</a> · <a href="/voorwaarden">Voorwaarden</a> · <a href="/auteursrecht">Auteursrecht</a> · <a href="/sitemap.xml">Sitemap</a><br/>
        Gemaakt in Amsterdam · gehost in Frankfurt, Ljubljana en Amsterdam.
      </p>
    </footer>
  </main>
  ${renderSiteScripts()}
  <script>${COPY_SCRIPT}</script>
</body>
</html>`;

  return c.body(html, 200, {
    'Content-Type': 'text/html; charset=utf-8',
    // Homepage update niet sneller dan de eerstvolgende event — 15min
    // is ruim genoeg voor publishers en verlaagt DB-load.
    'Cache-Control': 'public, max-age=900, s-maxage=1800, stale-while-revalidate=3600',
  });
});
