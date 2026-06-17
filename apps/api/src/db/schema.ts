import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ─── Enums ────────────────────────────────────────────────────────────────

export const modePref = pgEnum('mode_pref', ['nacht', 'dag']);
export const eventCategory = pgEnum('event_category', [
  'Muziek',
  'Theater',
  'Literatuur',
  'Film',
  'Kunst',
  'Lezing',
]);
export const friendshipStatus = pgEnum('friendship_status', [
  'pending',
  'accepted',
]);
export const inviteStatus = pgEnum('invite_status', [
  'pending',
  'accepted',
  'declined',
]);
/** Drie-status-respons op een uitnodiging (1-op-1 of groep), plus
    `pending` voor nog-niet-gereageerd. Vervangt het oude binaire
    accepted/declined-model van `invites`. */
export const responseStatus = pgEnum('response_status', [
  'pending',
  'going',
  'maybe',
  'not_going',
]);
export const savesVisibility = pgEnum('saves_visibility', [
  'favorites',
  'friends',
  'private',
]);
/** Aparte zichtbaarheids-flag voor de smaak-spiegel (top venues / genres
    / activity-timeline) op het publieke `u/[handle]`-profiel. Los van
    `savesVisibility` zodat een gebruiker hun saves wel met vrienden kan
    delen maar hun spiegel privé kan houden, of vice-versa.
    `favorites` = alleen voor vrienden die mij als favoriet hebben. */
export const mirrorVisibility = pgEnum('mirror_visibility', [
  'favorites',
  'friends',
  'private',
]);
/** Bron-attributie voor een save: welk scherm of welke route leverde de
    save op? Wordt gezet op het moment van saven, niet retro-fillable.
    Voedt de "discovery-trail"-breakdown op de persoonlijke spiegel. */
export const saveSource = pgEnum('save_source', [
  'venue',
  'friend',
  'search',
  'op-gevoel',
  'avond',
  'agenda',
  'kaart',
  'series',
  'gered',
  'other',
]);
export const venueFollowState = pgEnum('venue_follow_state', [
  'volgen',
  'blokken',
]);
export const venueType = pgEnum('venue_type', [
  'galerie',
  'museum',
  'podium',
  'club',
  'film',
  'ruimte',
  'boekhandel-cafe',
]);
export const dayNight = pgEnum('day_night', ['day', 'night', 'both']);
export const wijk = pgEnum('wijk', [
  'centrum',
  'noord',
  'oost',
  'west',
  'zuid',
  'zuidoost',
  'nieuw-west',
  'amstelveen',
  'zaandam',
  'haarlem',
  'diemen',
]);
export const venueScene = pgEnum('venue_scene', [
  'mainstream',
  'alternatief',
  'underground',
  'fringe',
]);
export const venueCapacity = pgEnum('venue_capacity', [
  'klein',
  'middel',
  'groot',
  'xl',
]);
/** Type event:
 *  - `show` = point-in-time (concert, club, voorstelling, film, opening).
 *    Heeft een of meer occurrences die elk een specifiek moment zijn.
 *  - `exhibition` = doorlopend (tentoonstelling). Heeft typisch één
 *    occurrence die de hele lopende periode dekt. UI toont "loopt t/m …"
 *    in plaats van een tijdslot. */
export const eventKind = pgEnum('event_kind', ['show', 'exhibition']);
/** Status van een specifiek moment. Default `scheduled`. */
export const pushPlatform = pgEnum('push_platform', ['ios', 'android']);

export const occurrenceStatus = pgEnum('occurrence_status', [
  'scheduled',
  'cancelled',
  'sold_out',
]);

// ─── Domain ───────────────────────────────────────────────────────────────

export const users = pgTable(
  'users',
  {
    id: text().primaryKey(),
    phoneNumber: text().notNull(),
    phoneNumberVerified: boolean().notNull().default(false),
    /** Andreas-handle. Wordt later in onboarding ingesteld; bij
        phone-OTP signup nog niet bekend. */
    handle: text(),
    /** Display-name. better-auth verwacht dit veld. Default leeg. */
    name: text().notNull().default(''),
    /** Optioneel email-adres als recovery; phone-OTP signup heeft geen email. */
    email: text(),
    emailVerified: boolean().notNull().default(false),
    image: text(),
    avatarUrl: text(),
    modePreference: modePref().notNull().default('nacht'),
    /** Mogen vrienden zien welke events ik heb opgeslagen (friend-pills,
        events-lijst op friend-detail)? Default `friends` (open). */
    savesVisibility: savesVisibility().notNull().default('friends'),
    /** Mogen vrienden mijn smaak-spiegel zien op `u/[handle]` (top venues,
        top genres, activity-timeline)? Apart van `savesVisibility` zodat
        beide flags onafhankelijk te kiezen zijn. Default `private` — opt-
        in voordat dit publiek wordt. */
    mirrorVisibility: mirrorVisibility().notNull().default('private'),
    /** Verschijn ik in `/users/search` voor mensen die mij nog niet
        kennen? Default `true`. Bestaande vrienden + verzoek-flow blijven
        werken ongeacht deze flag. */
    discoverable: boolean().notNull().default(true),
    /** Toegang tot de conversationele zoek ("Andreas-gids"). Default
        `false` — opt-in per gebruiker via het admin-paneel, zodat de
        LLM-kosten beheersbaar blijven tijdens uitrol. De `/zoek`-endpoint
        weigert (403) zonder deze vlag; de mobile-app verbergt de
        "Vraag de gids"-banner. */
    guideEnabled: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
    /** Laatste keer dat deze user een authed API-call deed (via GET /me
        op app-launch + tab-focus). Throttled tot 1× per uur in de
        endpoint zelf om DB-writes te beperken. Voedt DAU/WAU/MAU op
        het admin-insights-dashboard. Null voor users die nooit hebben
        ingelogd sinds de feature is geïntroduceerd. */
    lastSeenAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex('users_phone_number_idx').on(t.phoneNumber),
    uniqueIndex('users_handle_idx').on(t.handle),
  ]
);

export const venues = pgTable('venues', {
  id: text().primaryKey(),
  slug: text().notNull().unique(),
  name: text().notNull(),
  address: text().notNull(),
  lat: doublePrecision().notNull(),
  lng: doublePrecision().notNull(),
  imageUrl: text(),
  description: text(),
  /** Eén of meer categorieën — venues hebben vaak meerdere genres
      (bv. Paradiso doet Muziek + Film). Gebruikt door de
      Venues-bladerlijst voor categorie-filter. */
  categories: eventCategory()
    .array()
    .notNull()
    .default(sql`ARRAY[]::event_category[]`),
  /** Primaire venue-classifier — galerie / museum / podium / club /
      film / ruimte / boekhandel-cafe. Stuurt de chip-row op de
      Venues-tab. Optioneel zodat oude rijen blijven werken. */
  type: venueType(),
  /** Wanneer past deze venue: overdag, 's nachts, of beide. Auto-
      gefilterd op de huidige app-modus zodat dag-modus geen clubs
      voorstelt en nacht-modus geen musea. `both` is altijd zichtbaar. */
  dayNight: dayNight(),
  /** Stadsdeel — voor "in de buurt"-filter. Optioneel. */
  wijk: wijk(),
  /** Scene-as: mainstream / alternatief / underground / fringe.
      Onderscheidt Paradiso (mainstream) van OCCII (underground) van
      Het Groene Veld (fringe) — types waar `type` alleen overheen
      walst. Filter + zichtbare label in de Venues-tab. */
  scene: venueScene(),
  /** Globale grootte-as: klein (<200) / middel (200–1000) / groot
      (1000–5000) / xl (>5000). Indicatief — alleen ter info op de
      venue-detailpagina, geen filter. Onderscheidt Volta van Paradiso
      binnen dezelfde scene. */
  capacity: venueCapacity(),
  /** Vrije tags: techno / queer / arthouse / artist-run /
      experimenteel / klassiek / etc. Niet enum want lijst groeit. */
  subtype: text()
    .array()
    .notNull()
    .default(sql`ARRAY[]::text[]`),
  /** Officiële website van de venue (bv. https://paradiso.nl). Wordt
      getoond als action-knop op venue-detail en gebruikt door de seed/
      n8n-scrapers als bron. */
  website: text(),
  /** Instagram-handle zonder @ (bv. "paradiso"). UI-link bouwt
      `instagram://user?username=…` met fallback naar https. */
  instagram: text(),
  /** Default prijs-noot voor alle events op deze venue (bv. "lidmaat-
      schap vereist" voor Paradiso). Wordt op event-detail gerenderd
      onder de prijs, tenzij events.priceNote 'm overschrijft. */
  priceNote: text(),
  /** URL naar de agenda-/tentoonstellings-pagina van het venue —
      gebruikt door /admin/import om met één klik dezelfde pagina
      door Claude te laten extraheren. Vooral voor musea + galleries
      waar geen automatische scraper voor is. */
  agendaUrl: text(),
  /** Wanneer er voor 't laatst een succesvolle LLM-import gerund is
      voor deze venue. Wordt geüpdatet door
      /admin/api/import/exhibitions bij elk run met >0 succesvolle
      inserts/updates. Nul = nooit. */
  lastImportedAt: timestamp('last_imported_at', { withTimezone: true }),
  /** Per-platform scraper-config. Aanwezigheid van een sleutel betekent
      dat de bijbehorende scraper deze venue meeneemt in z'n run. Bv.
      `{ stager: { host: "radionamsterdam.stager.co", shopId: 92 } }`
      voor Radion. Andere keys (eventbrite, rss, ical, …) volgen wanneer
      die scrapers er zijn. */
  scraperConfig: jsonb().$type<{
    stager?: { host: string; shopId: number; shopHandle?: string };
    eventbrite?: { organizerId: string };
    rss?: { url: string };
    ical?: { url: string };
    jsonld?: { url: string };
    wpTheatre?: { agendaUrl: string };
    ticketmaster?: { venueIds: string[]; keyword?: string };
    /** Celebratix is een ticket-platform met een publieke API per
        channel. Gebruikt door BRET (channel `fuef7`) en mogelijk
        andere clubs. Eén channel-ID is alles wat we nodig hebben. */
    celebratix?: {
      channel: string;
      /** Optionele venue-specifieke widget-URL voor tickets. De
          scraper appendt `?eventId={sqid}`. Bv. voor BRET:
          `https://www-bret-bar.filesusr.com/html/327b25_3df...html`.
          Default fallback (zonder deze) is generic
          `shop.celebratix.io/event/{sqid}`. */
      ticketUrlBase?: string;
    };
    /** Weeztix is een ticket-platform (Eventix / OpenTicket). Per
        venue is de shop-UUID (uit `shop.weeztix.com/{uuid}/events`) de
        enige config. Image-augmentatie kan optioneel via een eigen
        agenda-page met JSON-LD of og-meta. */
    weeztix?: { shopUuid: string; imageAgendaUrl?: string };
    /** WeTicket is een Next.js ticket-platform (Vercel-hosted) dat
        SSR-render't naar een `<script id="__NEXT_DATA__">` met
        `upcoming_events` per organisatie. Eén subdomain per venue
        (bv. `skatecafe.weticket.io`, `sissisamsterdam.weticket.io`).
        Achter een Vercel Security Checkpoint dus Playwright nodig.
        Lokaal-only (niet in Fly Docker image).
        `locationName` (optional) overschrijft de exact-match filter
        op `shop.location_name`. Sissi's bv. ticketed onder
        "Sissi's Amsterdam (Anthony Fokkerweg 3)" terwijl de venue
        bij ons gewoon `Sissi's` heet — zet 'm dan op de WeTicket-
        string. Default: venue.name. */
    weticket?: { subdomain: string; locationName?: string };
    /** The Events Calendar (Pro) — WP-plugin met publieke REST API:
        `{apiBase}/events?per_page=50&start_date=YYYY-MM-DD`. Eén
        config-veld: `apiBase` = `https://{venue}.nl/wp-json/tribe/events/v1`. */
    eventscalendar?: { apiBase: string };
    /** Volkshotel agenda's (Canvas, Doka, Werkplaats) — custom WP-
        template op `volkshotel.nl/en/agenda/{roomPath}/`. Geen JSON-LD;
        scraper parseert de tile-DOM. `roomPath` is het URL-segment
        ('canvas', 'doka', 'werkplaats'). */
    volkshotel?: { roomPath: string };
    /** Fullhouse.tech — ticket-platform met Next.js shop-pagina's per
        seller. URL-vorm: `shop.fullhouse.tech/seller/{sellerSlug}`.
        Events staan embed'd in __NEXT_DATA__ als pageProps.events[]. */
    fullhouse?: { sellerSlug: string };
    /** Fourvenues is een ticket-platform met iframe-widget per venue.
        URL-vorm: `web.fourvenues.com/en/iframe/{slug}/events?date=YYYY-MM`.
        We scrapen via Playwright omdat events client-side gerenderd
        worden. `slug` is het venue-handle in de URL. */
    fourvenues?: { slug: string };
    /** Amsterdam Alternative services-API. Eén JSON-endpoint deelt
        events voor een groep onafhankelijke venues (Plein Theater,
        OCCII, OT301, Splendor, Cinetol, ...). Config is enkel de
        numerieke `venueId` zoals AA hem intern hanteert (Plein
        Theater = 123). */
    aaservices?: {
      venueId: number;
      /** Optionele venue-eigen site (bv. `https://www.plein-theater.nl`).
          Als gezet fetcht de scraper `{siteUrl}/agenda/{aaEventId}` per
          event om de full-text description uit de embedded App()-config
          te halen. Zonder siteUrl heb je alleen titel+lineup uit de
          AA-services list-API. */
      siteUrl?: string;
    };
    /** Generic theater-scraper: pakt show-URLs uit een sitemap, fetcht
        elke show-page en parseert JSON-LD `Event`-blokken óf
        `data-date` attributes. Gebruikt voor Carré, Meervaart, DeLaMar. */
    theater?: {
      sitemapUrl: string;
      /** Regex om show-URLs uit de sitemap te selecteren. Bv.
          `^https://carre\\.nl/voorstelling/[a-z0-9-]+$`. */
      showUrlPattern: string;
      /** Sommige sites (Carré Vue-SPA, Meervaart Phoenix-LiveView) leveren
          alleen geprerenderde HTML als de UA Googlebot is. */
      useGooglebotUA?: boolean;
      /** Fallback voor sites waar JSON-LD alleen 1 Event-range geeft maar
          de specifieke datums in `data-date="YYYY-MM-DD"` attrs staan. */
      useDataDateAttrs?: boolean;
      /** Regex om uit het laatste URL-segment een prefix te strippen
          vóór het tot eventId-slug wordt. Bv. `^\\d+-` voor Concert-
          gebouw waar elke avond een eigen `45471300-lumi-basement-
          sessions` URL krijgt — zonder strip wordt elke avond een
          eigen event. */
      showSlugStripPattern?: string;
    };
  }>(),
  /** Admin-toggle: false = verbergen uit publieke endpoints zonder
      data te verliezen (saves blijven, events blijven). Default true. */
  published: boolean().notNull().default(true),
  createdAt: timestamp({ withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export const events = pgTable(
  'events',
  {
    id: text().primaryKey(),
    venueId: text()
      .notNull()
      .references(() => venues.id, { onDelete: 'cascade' }),
    title: text().notNull(),
    description: text(),
    /** `show` voor point-in-time events (concert, film, club, opening) of
        `exhibition` voor doorlopende programmering. Stuurt UI-weergave
        van datum/tijd. Default `show`. */
    kind: eventKind().notNull().default('show'),
    /** "Best beschikbare beeld" — legacy gemengd poster/still. Voor
        nieuwe Film-events wordt dit veld leeg gelaten en zijn
        `posterUrl`/`stillUrl` de bron van waarheid. Display-prioriteit:
        lijsten = posterUrl ?? imageUrl, detail = stillUrl ?? imageUrl. */
    imageUrl: text(),
    /** Verticale film-poster (TMDb of venue-poster), gemirrored naar
        Bunny. Nullable; alleen gevuld voor Film-events met een match. */
    posterUrl: text(),
    /** Landscape sfeerbeeld voor de detail-hero (TMDb backdrop of
        venue-still), gemirrored naar Bunny. Nullable. */
    stillUrl: text(),
    /** Full YouTube/Vimeo URL voor films met een trailer beschikbaar
        via TMDb's videos endpoint. Nullable. */
    trailerUrl: text(),
    category: eventCategory().notNull(),
    /** Editorial-pick voor de Avond-tab. Curator zet deze aan. */
    featured: boolean().notNull().default(false),
    /** Specifieke genres binnen `category` — vrije array (zoals
        `venues.subtype`). Voor muziek: techno/hip-hop/jazz; voor
        theater: drama/dans/cabaret; etc. Filter-sheet groepeert
        clientside per category. */
    genres: text()
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    /** Afgeleide labels = eigen `genres` + genres van de gelinkte line-up-
        artiesten (techno/house/…), eigen eerst, gecapt. Bijgewerkt door
        `recomputeEffectiveGenres()` in de daily job. Puur afgeleid — de
        genre-enrich-pipeline bezit `genres`, deze kolom interfereert daar niet
        mee. Publieke endpoints tonen deze set als labels. */
    effectiveGenres: text('effective_genres')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    /** Admin-toggle: false = verbergen uit publieke endpoints
        (Avond/Agenda/Kaart/Gered/detail) zonder saves of invites
        kwijt te raken. Default true. */
    published: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('events_venue_idx').on(t.venueId),
    index('events_featured_idx').on(t.featured),
  ]
);

/**
 * Een specifiek moment van een event: één voorstelling, screening, club-
 * avond, opening, of doorlopende periode (voor `kind=exhibition`). Eén
 * event heeft 1+ occurrences. De Avond/Agenda/Kaart-feeds tonen events
 * met hun `nextOccurrence`, de detail-pagina toont alle occurrences.
 */
export const occurrences = pgTable(
  'occurrences',
  {
    id: text().primaryKey(),
    eventId: text()
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    /** Venue van dit specifieke moment. Voor concerts/theater is dit
        gelijk aan `events.venueId` (één event = één venue). Voor films
        die gelijktijdig in meerdere bioscopen draaien, krijgt elke
        occurrence z'n eigen venue zodat één 'Anora'-event meerdere
        bioscopen kan dekken zonder dat we events dubbelen. Nullable
        voor backwards-compat; de backfill-migratie heeft alle bestaande
        rijen al gevuld met events.venueId. */
    venueId: text().references(() => venues.id, { onDelete: 'set null' }),
    startsAt: timestamp({ withTimezone: true }).notNull(),
    endsAt: timestamp({ withTimezone: true }),
    /** Prijs in centen. Per occurrence omdat film-matinee anders kost
        dan avond, wekelijks feest soms voorverkoop, etc. */
    priceCents: integer(),
    /** Vrije korte noot bij de prijs (bv. "lidmaatschap vereist",
        "pay-what-you-can aan de deur"). */
    priceNote: text(),
    /** Ticket-URL. Per occurrence zodat elk moment z'n eigen link kan
        hebben (films/concerten met aparte tickets per voorstelling). */
    ticketUrl: text(),
    /** Optionele zaal binnen venue (bv. "Kleine Zaal", "Zaal 1"). */
    room: text(),
    /** Optionele lineup voor deze occurrence: DJs, supporting acts,
        cast. Zit op occurrence omdat een wekelijks feest elke week een
        andere lineup kan hebben.

        `artistId` (optioneel) wijst naar `artists.id` — gevuld door
        `_artists-enrich.ts` nadat we de naam gematched hebben (op
        bestaand record OF via MusicBrainz). UI maakt de rij klikbaar
        naar /artist/{slug} alleen als artistId set is. Geen FK want
        JSONB; consistentie is app-side. */
    lineup: jsonb().$type<Array<{
      name: string;
      role?: 'dj' | 'support' | 'headliner' | 'act';
      artistId?: string;
    }>>(),
    status: occurrenceStatus().notNull().default('scheduled'),
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('occurrences_event_idx').on(t.eventId),
    index('occurrences_starts_at_idx').on(t.startsAt),
    index('occurrences_event_starts_at_idx').on(t.eventId, t.startsAt),
    index('occurrences_venue_idx').on(t.venueId),
  ]
);

/**
 * Canonical artist-records, gedeeld over events. Lineup-items in
 * `occurrences.lineup` linken via een optioneel `artistId`-veld in
 * de JSON-blob (geen FK want JSON, app-niveau consistentie).
 *
 * MusicBrainz is de primaire bron voor streaming-links en bio, onder
 * hun CC0-licentie. We cachen die data in deze tabel; dat is expliciet
 * toegestaan en voorkomt N MB-lookups voor één artist die in
 * meerdere events voorkomt.
 *
 * `enrichedAt` is een retry-marker: gezet bij elke enrich-poging
 * (succes of niet). Bij "niet gevonden" gebruiken we 'm om niet
 * dagelijks opnieuw te zoeken — zie `_artists-enrich.ts` voor het
 * retry-window.
 */
export const artists = pgTable(
  'artists',
  {
    id: text().primaryKey(),
    name: text().notNull(),
    /** MusicBrainz UUID. Unique zodat hetzelfde MB-record niet twee
        artist-rows kan voeden. Nullable: een artist kan ook bestaan
        zonder MB-match. */
    mbid: text().unique(),
    description: text(),
    imageUrl: text(),
    /** Streaming + content links. CC0-data (MB) is OK om te cachen. */
    spotifyUrl: text(),
    appleMusicUrl: text(),
    bandcampUrl: text(),
    youtubeUrl: text(),
    officialUrl: text(),
    genres: text()
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    enrichedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  () => [
    // Case-insensitive unique op naam zodat "DJ SWISHA" en "Dj Swisha"
    // naar één record dedupen — drizzle-kit kent geen LOWER()-index,
    // dus die staat in de SQL-migratie (0039_artists.sql) als
    // `artists_name_lower_idx`. Hier geen drizzle-tracking voor.
  ]
);

/**
 * Per-user favoriete vrienden — een gerichte relatie ("ik markeer Alice
 * als favoriet"). Onafhankelijk van of Alice mij óók als favoriet ziet.
 * Vereist een bestaande accepted friendship (afgedwongen in de API,
 * niet door FK — friend_id verwijst gewoon naar users).
 */
export const friendFavorites = pgTable(
  'friend_favorites',
  {
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    friendId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.friendId] }),
    index('friend_favorites_friend_idx').on(t.friendId),
  ]
);

export const friendships = pgTable(
  'friendships',
  {
    fromUserId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    toUserId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: friendshipStatus().notNull().default('pending'),
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    primaryKey({ columns: [t.fromUserId, t.toUserId] }),
    index('friendships_to_idx').on(t.toUserId),
  ]
);

export const saves = pgTable(
  'saves',
  {
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Saves zitten op occurrence-niveau: een film met 7 voorstellingen
        kan je 1× saven (de voorstelling waar je heen wil) of meerdere.
        Een wekelijks feest dat je 4 maandagen wilt zien = 4 saves. Voor
        single-occurrence events (point-in-time of doorlopende exhibition)
        voelt dit identiek aan event-level saves. */
    occurrenceId: text()
      .notNull()
      .references(() => occurrences.id, { onDelete: 'cascade' }),
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
    /** Welk scherm of route leverde deze save op? Gezet op het moment
        van saven, voedt de discovery-trail-breakdown op de persoonlijke
        spiegel. Nullable voor rijen van vóór de attributie-introductie
        (mei 2026); 'other' voor nieuwe call-sites die expliciet "weet ik
        niet" willen aangeven. */
    source: saveSource(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.occurrenceId] }),
    index('saves_occurrence_idx').on(t.occurrenceId),
  ]
);

/**
 * Wegswipets: events die de gebruiker actief heeft afgewezen op het
 * `/op-gevoel`-swipescherm (links-swipe). Gebruikt om dezelfde
 * occurrence niet opnieuw te tonen in toekomstige sessies, en als input
 * voor het smaak-profiel (welke patronen wijst de gebruiker af).
 */
export const dismisses = pgTable(
  'dismisses',
  {
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    occurrenceId: text()
      .notNull()
      .references(() => occurrences.id, { onDelete: 'cascade' }),
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
    /** Net als bij saves: welk scherm leverde de dismiss op? Default
        'op-gevoel' want dat is het enige scherm met een dismiss-gebaar,
        maar het veld is uitbreidbaar voor toekomstige plekken. */
    source: saveSource().notNull().default('op-gevoel'),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.occurrenceId] }),
    index('dismisses_occurrence_idx').on(t.occurrenceId),
  ]
);

export const invites = pgTable(
  'invites',
  {
    id: text().primaryKey(),
    fromUserId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    toUserId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Verwijst naar een specifieke occurrence (= moment), niet naar
        het master-event. "Ga je mee dinsdag 19:30?" niet "ga je mee
        naar Hamlet?" */
    occurrenceId: text()
      .notNull()
      .references(() => occurrences.id, { onDelete: 'cascade' }),
    message: text(),
    /** Optioneel reply-bericht dat de invitee meestuurt bij accept of
        decline. One-shot — geen thread of follow-up. Wordt in de
        push naar de inviter meegeleverd zodat ze een persoonlijke
        reactie terug zien ("Yes, ben er!" / "Sorry, kan niet"). */
    replyMessage: text(),
    status: inviteStatus().notNull().default('pending'),
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex('invites_unique_idx').on(t.fromUserId, t.toUserId, t.occurrenceId),
    index('invites_to_status_idx').on(t.toUserId, t.status),
    index('invites_occurrence_idx').on(t.occurrenceId),
  ]
);

/**
 * Een door een user opgerichte groep — een vaste club waar hij/zij vaak
 * dingen mee onderneemt ("Vrijdagclub", "Bandvrienden"). Alleen de
 * creator mag de groep beheren (naam wijzigen, leden toevoegen/kicken).
 * Andere leden kunnen wel zelf vertrekken en/of muten. Groepen zijn
 * gedeeld: alle leden zien wie er nog meer in zit.
 */
export const groups = pgTable(
  'groups',
  {
    id: text().primaryKey(),
    name: text().notNull(),
    creatorId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index('groups_creator_idx').on(t.creatorId)]
);

/**
 * Lidmaatschap-tabel — soft-delete via `leftAt` zodat responses op oude
 * uitnodigingen blijven bestaan nadat iemand de groep heeft verlaten.
 * `mutedAt` is per-user mute (geen push, wel zichtbaar in app).
 */
export const groupMembers = pgTable(
  'group_members',
  {
    groupId: text()
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    joinedAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
    leftAt: timestamp({ withTimezone: true }),
    mutedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.userId] }),
    index('group_members_user_idx').on(t.userId),
  ]
);

/**
 * Een verzonden uitnodiging — één rij per "verzending":
 *   * `groupId = null` → 1-op-1; `invitation_responses` bevat exact twee
 *     rijen (initiator + recipient).
 *   * `groupId` gezet → groep-invite; `invitation_responses` bevat een
 *     rij per groepslid dat op het moment van versturen actief was
 *     (snapshot), plus de initiator.
 *
 * Wijzigingen in groep-samenstelling na de verzending hebben geen
 * effect: later toegetreden leden krijgen geen response-slot, vertrokken
 * leden behouden hun bestaande respons (read-only).
 *
 * `revokedAt`: spec staat toe dat de initiator z'n verstuurde invite
 * intrekt. Soft-delete zodat we save-cleanup en push-suppressie kunnen
 * doen voordat het record echt verdwijnt. List-endpoints filteren op
 * `revokedAt IS NULL`.
 */
export const invitations = pgTable(
  'invitations',
  {
    id: text().primaryKey(),
    fromUserId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    occurrenceId: text()
      .notNull()
      .references(() => occurrences.id, { onDelete: 'cascade' }),
    groupId: text().references(() => groups.id, { onDelete: 'cascade' }),
    message: text(),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('invitations_from_idx').on(t.fromUserId),
    index('invitations_occurrence_idx').on(t.occurrenceId),
    index('invitations_group_idx').on(t.groupId),
  ]
);

/**
 * Per-user respons op een uitnodiging. Initiator zit hier ook in (default
 * `going`, maar mag wijzigen). Status is mutable tot de occurrence is
 * verlopen. `reminderSentAt` = één reminder per (invitation, user) zoals
 * de spec voorschrijft.
 */
export const invitationResponses = pgTable(
  'invitation_responses',
  {
    invitationId: text()
      .notNull()
      .references(() => invitations.id, { onDelete: 'cascade' }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: responseStatus().notNull().default('pending'),
    replyMessage: text(),
    reminderSentAt: timestamp({ withTimezone: true }),
    respondedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    primaryKey({ columns: [t.invitationId, t.userId] }),
    index('invitation_responses_user_idx').on(t.userId),
    index('invitation_responses_status_idx').on(t.status),
  ]
);

/**
 * Share-invites: bevriendings-tokens die je extern (WhatsApp, iMessage)
 * deelt. Inviter creëert een record → URL = andreas.amsterdam/i/<token>.
 * Ontvanger downloadt + logt in → app claimt token → friendship-upsert
 * (status accepted) + share_invite.claimedBy/At gezet.
 *
 * `eventId` en `venueId` zijn nullable: v1 is alleen friend-only
 * (beide null). Toekomstige slice koppelt context.
 */
export const shareInvites = pgTable(
  'share_invites',
  {
    id: text().primaryKey(),
    fromUserId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    eventId: text().references(() => events.id, { onDelete: 'cascade' }),
    venueId: text().references(() => venues.id, { onDelete: 'cascade' }),
    /** URL-safe random string van 16-24 chars. Uniek over de tabel. */
    token: text().notNull().unique(),
    claimedByUserId: text().references(() => users.id, {
      onDelete: 'set null',
    }),
    claimedAt: timestamp({ withTimezone: true }),
    /** Tokens verlopen na 30 dagen — voorkomt dat oude WhatsApp-links
        voor altijd open blijven. */
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('share_invites_token_idx').on(t.token),
    index('share_invites_from_idx').on(t.fromUserId),
  ]
);

export const series = pgTable('series', {
  id: text().primaryKey(),
  slug: text().notNull().unique(),
  name: text().notNull(),
  description: text(),
  imageUrl: text(),
  /** Optionele datum-range (bv. ADE 14 – 18 okt). Eén of beide kunnen leeg
      zijn voor doorlopende cycli zonder vast eindpunt. */
  startsAt: timestamp({ withTimezone: true }),
  endsAt: timestamp({ withTimezone: true }),
  categories: eventCategory()
    .array()
    .notNull()
    .default(sql`ARRAY[]::event_category[]`),
  /** Admin-toggle: false = verbergen uit publieke endpoints
      (pills + Venues-tab) zonder de koppelingen kwijt te raken. */
  published: boolean().notNull().default(true),
  /** Curatorische pin: true = toont in de Series-strook bovenaan de
      Venues-tab. Bedoeld voor periode-festivals zoals Holland
      Festival, ADE, IDFA, Grachten Festival. Mini-series die alleen
      een opening en een tentoonstelling koppelen blijven default off
      — de pills bij events tonen ze nog wel via `event.series`. */
  featured: boolean().notNull().default(false),
  createdAt: timestamp({ withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export const eventsInSeries = pgTable(
  'events_in_series',
  {
    eventId: text()
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    seriesId: text()
      .notNull()
      .references(() => series.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.seriesId] }),
    index('eis_series_idx').on(t.seriesId),
    index('eis_event_idx').on(t.eventId),
  ]
);

export const venueFollows = pgTable(
  'venue_follows',
  {
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    venueId: text()
      .notNull()
      .references(() => venues.id, { onDelete: 'cascade' }),
    /** Expliciete staat: `volgen` (boost in feed) of `blokken`
        (verbergt deze venue overal). Geen rij = `normaal` (default,
        geen voorkeur). */
    state: venueFollowState().notNull().default('volgen'),
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [primaryKey({ columns: [t.userId, t.venueId] })]
);

// ─── better-auth tables ───────────────────────────────────────────────────
// Mirrors the schema better-auth expects. The `account` table is required
// even for phone-OTP because better-auth uses it to link authenticators
// (phone, future Apple Sign-In, etc.) to a user.

export const session = pgTable('session', {
  id: text().primaryKey(),
  userId: text()
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  token: text().notNull().unique(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  ipAddress: text(),
  userAgent: text(),
  createdAt: timestamp({ withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export const account = pgTable('account', {
  id: text().primaryKey(),
  userId: text()
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  providerId: text().notNull(),
  accountId: text().notNull(),
  password: text(),
  createdAt: timestamp({ withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

// ─── OAuth/OIDC (better-auth mcp-plugin) ────────────────────────────────────
// Tabellen die de better-auth `mcp`-plugin (OAuth-provider voor MCP-clients)
// verwacht. Velden 1-op-1 uit het oidc-provider-schema; kolomnamen volgen de
// snake_case-casing van de drizzle-adapter. Gemapt in auth.ts.

export const oauthApplication = pgTable('oauth_application', {
  id: text().primaryKey(),
  name: text().notNull(),
  icon: text(),
  metadata: text(),
  clientId: text().notNull().unique(),
  clientSecret: text(),
  redirectUrls: text().notNull(),
  type: text().notNull(),
  disabled: boolean().notNull().default(false),
  userId: text().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp({ withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp({ withTimezone: true }).notNull().default(sql`now()`),
});

export const oauthAccessToken = pgTable('oauth_access_token', {
  id: text().primaryKey(),
  accessToken: text().notNull().unique(),
  refreshToken: text().notNull().unique(),
  accessTokenExpiresAt: timestamp({ withTimezone: true }).notNull(),
  refreshTokenExpiresAt: timestamp({ withTimezone: true }).notNull(),
  clientId: text().notNull(),
  userId: text().references(() => users.id, { onDelete: 'cascade' }),
  scopes: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp({ withTimezone: true }).notNull().default(sql`now()`),
});

export const oauthConsent = pgTable('oauth_consent', {
  id: text().primaryKey(),
  clientId: text().notNull(),
  userId: text()
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  scopes: text().notNull(),
  consentGiven: boolean().notNull().default(false),
  createdAt: timestamp({ withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp({ withTimezone: true }).notNull().default(sql`now()`),
});

/**
 * Expo Push tokens per device — een user kan meerdere devices hebben
 * (iPhone + iPad bv.) dus geen unique op (userId), wel op (token).
 * Token is de Expo-Push-token (`ExponentPushToken[…]`) die we naar de
 * Expo push-service sturen. APNS-credentials zijn EAS-managed.
 */
export const pushTokens = pgTable(
  'push_tokens',
  {
    id: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text().notNull().unique(),
    platform: pushPlatform().notNull(),
    /** Expo's `deviceId` (best-effort) zodat we tokens van hetzelfde
        device kunnen mergen als de OS een nieuw token uitgeeft. */
    deviceId: text(),
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
    /** Bijgewerkt elke keer dat de app het token opnieuw aanmeldt;
        gebruik je later om stale tokens (>90d) op te schonen. */
    lastSeenAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index('push_tokens_user_idx').on(t.userId)]
);

/**
 * Sociale automatisering — IG-posts gegenereerd uit het event-aanbod.
 * Eén rij = één post (single of carousel). Cron-job genereert 's
 * ochtends een concept (status 'draft'), admin keurt goed via de
 * `/admin/social`-UI (→ 'approved'), tweede cron 's middags publiceert
 * naar IG (→ 'posted' of 'failed' + error). 'skipped' = handmatig
 * overgeslagen door admin.
 *
 * `eventIds` is een array zodat een carousel-post met 3 events in
 * één rij past. Voor single-posts is het 1-elements. `imageUrls` volgt
 * dezelfde shape — cover- en outro-slides tellen mee als extra
 * elementen (`imageUrls.length` kan dus > `eventIds.length` zijn).
 *
 * `meta` is een vrije JSONB voor per-post debug-info: score-breakdown
 * van de selectie, template-versie, etc. Niet gebruikt door publieke
 * endpoints, alleen door de admin-UI.
 */
export const socialPosts = pgTable(
  'social_posts',
  {
    id: text().primaryKey(),
    slot: text().notNull(), // 'morning' | 'afternoon' | 'evening' — check constraint in SQL
    eventIds: text()
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    imageUrls: text()
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    caption: text(),
    igMediaId: text(),
    scheduledFor: timestamp({ withTimezone: true }).notNull(),
    postedAt: timestamp({ withTimezone: true }),
    status: text().notNull().default('draft'), // 'draft' | 'approved' | 'posted' | 'skipped' | 'failed'
    error: text(),
    meta: jsonb().$type<{
      scoreBreakdown?: Record<string, number>;
      templateVersion?: string;
      occurrenceIds?: string[];
      skippedEventIds?: string[];
      permalink?: string;
      themeKey?: string;
      windowDays?: number;
      kind?: string;
      /** 9:16 carousel-set voor TikTok (parallel met `imageUrls` 4:5 voor IG). */
      tiktokImageUrls?: string[];
      tiktokPublishId?: string;
      tiktokSentAt?: string;
    }>(),
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('social_posts_status_idx').on(t.status),
    index('social_posts_scheduled_for_idx').on(t.scheduledFor),
    index('social_posts_posted_at_idx').on(t.postedAt),
  ]
);

/**
 * Single-row tabel met de huidige Instagram Graph API access-token.
 * IG long-lived tokens vervallen na ~60 dagen en moeten worden
 * verlengd via `graph.instagram.com/refresh_access_token`. Door de
 * token in DB te houden i.p.v. een Fly secret kunnen we 'm
 * programmatisch vernieuwen (zonder app-restart). Primary key is een
 * vaste sentinel 'main'.
 */
export const igTokens = pgTable('ig_tokens', {
  id: text().primaryKey(),
  accessToken: text().notNull(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  refreshedAt: timestamp({ withTimezone: true })
    .notNull()
    .default(sql`now()`),
  createdAt: timestamp({ withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

/**
 * TikTok Content Posting API OAuth tokens. Eén rij (id='main') voor
 * de geconnecte Andreas-TikTok-account. Refresh-token is geldig 365d,
 * access-token 24h; we refreshen automatisch wanneer access binnen
 * 1h verloopt.
 */
export const tiktokTokens = pgTable('tiktok_tokens', {
  id: text().primaryKey(),
  accessToken: text().notNull(),
  refreshToken: text().notNull(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  refreshExpiresAt: timestamp({ withTimezone: true }).notNull(),
  /** open_id van de geconnecte TikTok-user (uniek per app+user). */
  openId: text().notNull(),
  /** Display name uit user.info — voor admin-UI ("verbonden met @X"). */
  displayName: text(),
  refreshedAt: timestamp({ withTimezone: true })
    .notNull()
    .default(sql`now()`),
  createdAt: timestamp({ withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

/**
 * Log per gids-vraag (conversationele zoek). Dient twee doelen:
 *  1. Kostenrem — de `/zoek`-endpoint telt de rijen van de afgelopen 24u
 *     en weigert boven een dagelijkse drempel (kill-switch).
 *  2. Productinzicht (brief §10) — welke avonden zoeken mensen, en dekt
 *     het aanbod dat? `userId` mag null zijn als de user intussen is
 *     verwijderd (set null), zodat de telling/historie blijft staan.
 */
export const zoekLogs = pgTable(
  'zoek_logs',
  {
    id: text().primaryKey(),
    userId: text().references(() => users.id, { onDelete: 'set null' }),
    /** De zoekzin van de gebruiker. */
    message: text().notNull(),
    /** Profiel ná de beurt-update — voedt v2-personalisatie. */
    profile: jsonb(),
    /** Getoonde event-ids (de gevalideerde keuze van het LLM). */
    shownEventIds: text()
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('zoek_logs_created_at_idx').on(t.createdAt),
    index('zoek_logs_user_idx').on(t.userId),
  ]
);

export const verification = pgTable('verification', {
  id: text().primaryKey(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  createdAt: timestamp({ withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .default(sql`now()`),
});
