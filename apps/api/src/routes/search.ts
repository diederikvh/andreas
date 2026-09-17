/**
 * Globale zoek voor de SearchOverlay op /avond. Eén endpoint dat
 * parallel venues + events doorzoekt op `q`, returnt twee secties in
 * één response. IMDB-stijl: "Paradiso" → venue Paradiso + events bij
 * Paradiso.
 *
 *  GET /search?q=<text>&eventsOffset=<N>
 *
 * Returns:
 *  {
 *    venues:        ApiSearchVenue[]   // alle matches, max 30 — small enough
 *    events:        ApiSearchEvent[]   // volgende EVENTS_LIMIT, paginated
 *    eventsHasMore: boolean            // client weet of de volgende fetch nut heeft
 *  }
 *
 * `q` is verplicht. Lege `q` → 400. Cap op `q.length` (1..120) zodat een
 * onbedoelde dump-zoek de DB niet stuk maakt.
 */
import { and, asc, eq, gt, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';

import { db, displayGenres, schema } from '../db/index.js';
import { searchSpotifyArtists } from '../spotify-search.js';

export const searchRoute = new Hono();

const VENUE_CAP = 30;
const EVENTS_LIMIT = 20;
const EVENTS_OFFSET_CAP = 500;

searchRoute.get('/', async (c) => {
  const rawQ = (c.req.query('q') ?? '').trim();
  if (rawQ.length === 0) {
    return c.json({ venues: [], events: [], eventsHasMore: false });
  }
  if (rawQ.length > 120) return c.json({ error: 'q-too-long' }, 400);

  const eventsOffset = Math.min(
    Math.max(Number(c.req.query('eventsOffset') ?? 0), 0),
    EVENTS_OFFSET_CAP
  );

  const needle = `%${rawQ}%`;

  // Fuzzy zoeken: `%` is de trigram-operator uit pg_trgm (migratie 0056,
  // drempel 0,3) en gebruikt de GIN-index op title/name. Zo vindt
  // "Pagadiso" alsnog Paradiso.
  //
  // Twee manieren om erbij te komen. De import vráágt erom (`fuzzy=1`),
  // want die zoekt met wat de OCR van een poster las en heeft ook fuzzy
  // nodig als het exacte woord toevallig íéts oplevert. Voor een mens is
  // het een **terugval**: levert je zoekopdracht niets op, dan zoeken we
  // hem nog een keer losser. Zo houdt een goede zoekopdracht z'n rustige,
  // chronologische lijst en krijg je bij een typefout geen leeg scherm.
  const alike = (column: PgColumn, fuzzy: boolean) =>
    fuzzy
      ? [ilike(column, needle), sql`${column} % ${rawQ}`]
      : [ilike(column, needle)];

  // Venues — alleen op de eerste pagina laden (eventsOffset === 0).
  // Voor scroll-pagina's heeft de client de venues al; opnieuw fetchen
  // verspilt round-trip-tijd.
  const findVenues = (fuzzy: boolean) =>
    eventsOffset === 0
      ? db
          .select({
            id: schema.venues.id,
            slug: schema.venues.slug,
            name: schema.venues.name,
            address: schema.venues.address,
            type: schema.venues.type,
            wijk: schema.venues.wijk,
            imageUrl: schema.venues.imageUrl,
            lat: schema.venues.lat,
            lng: schema.venues.lng,
          })
          .from(schema.venues)
          .where(
            and(
              eq(schema.venues.published, true),
              or(...alike(schema.venues.name, fuzzy))
            )
          )
          .orderBy(asc(schema.venues.name))
          .limit(VENUE_CAP)
      : Promise.resolve([]);

  // Events — match op title OF venue-naam. Filter: published events
  // bij published venues, ≥1 toekomstige occurrence. We sorteren op
  // de eerstvolgende occurrence (asc) door een subquery, en paginen
  // met limit/offset.
  const eventWhere = (fuzzy: boolean) => {
    const conditions: SQL[] = [
      eq(schema.events.published, true),
      eq(schema.venues.published, true),
    ];
    const matchEvent = or(
      ...alike(schema.events.title, fuzzy),
      ...alike(schema.venues.name, fuzzy)
    );
    if (matchEvent) conditions.push(matchEvent);
    return and(...conditions);
  };

  // Subquery: voor elk event de eerstvolgende occurrence-startsAt.
  // Sorteer dáár op — anders krijg je events die jaren-oud zijn maar
  // toevallig in de DB op `q` matchen.
  const nextOccSubquery = db
    .select({
      eventId: schema.occurrences.eventId,
      nextStartsAt: sql<Date>`min(${schema.occurrences.startsAt})`.as(
        'next_starts_at'
      ),
    })
    .from(schema.occurrences)
    .where(
      and(
        sql`COALESCE(${schema.occurrences.endsAt}, ${schema.occurrences.startsAt} + INTERVAL '4 hours') >= NOW()`,
        sql`${schema.occurrences.status} <> 'cancelled'`
      )
    )
    .groupBy(schema.occurrences.eventId)
    .as('next_occ');

  const findEvents = (fuzzy: boolean) =>
    db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      kind: schema.events.kind,
      category: schema.events.category,
      featured: schema.events.featured,
      genres: displayGenres,
      imageUrl: schema.events.imageUrl,
      posterUrl: schema.events.posterUrl,
      stillUrl: schema.events.stillUrl,
      nextStartsAt: nextOccSubquery.nextStartsAt,
      venue: {
        id: schema.venues.id,
        slug: schema.venues.slug,
        name: schema.venues.name,
        lat: schema.venues.lat,
        lng: schema.venues.lng,
        type: schema.venues.type,
        imageUrl: schema.venues.imageUrl,
        wijk: schema.venues.wijk,
      },
    })
    .from(schema.events)
    .innerJoin(schema.venues, eq(schema.events.venueId, schema.venues.id))
    .innerJoin(
      nextOccSubquery,
      eq(nextOccSubquery.eventId, schema.events.id)
    )
    .where(eventWhere(fuzzy))
    .orderBy(asc(nextOccSubquery.nextStartsAt))
    .limit(EVENTS_LIMIT + 1)
    .offset(eventsOffset);

  /**
   * Artiesten. Alleen op de eerste pagina, net als venues.
   *
   * Hier komt de volg-knop aan te hangen: zoek je een band, dan is dat
   * meestal geen zoekopdracht naar een avond maar naar die band. Ook
   * artiesten zónder komende avonden komen mee -- juist die wil je
   * kunnen volgen, want daar heb je nog niets van gezien.
   */
  const findArtists = (fuzzy: boolean) =>
    eventsOffset === 0
      ? db
          .select({
            id: schema.artists.id,
            name: schema.artists.name,
            imageUrl: schema.artists.imageUrl,
            genres: schema.artists.genres,
          })
          .from(schema.artists)
          .where(or(...alike(schema.artists.name, fuzzy)))
          .orderBy(asc(schema.artists.name))
          .limit(8)
      : Promise.resolve([]);

  const asked = c.req.query('fuzzy') === '1';
  let [venues, eventRows, artists] = await Promise.all([
    findVenues(asked),
    findEvents(asked),
    findArtists(asked),
  ]);
  // Niets gevonden? Dan lag het misschien aan de spelling. Eén woord van
  // twee letters fuzzy zoeken levert alleen ruis op, vandaar de ondergrens.
  if (
    !asked &&
    venues.length === 0 &&
    eventRows.length === 0 &&
    artists.length === 0 &&
    rawQ.length >= 3
  ) {
    [venues, eventRows, artists] = await Promise.all([
      findVenues(true),
      findEvents(true),
      findArtists(true),
    ]);
  }

  const eventsHasMore = eventRows.length > EVENTS_LIMIT;
  const eventsTrimmed = eventRows.slice(0, EVENTS_LIMIT);

  // Voor de occurrence-shape: 1 entry in occurrencesInRange = de
  // next-occurrence zelf. Client kan dan dezelfde EventListRow render
  // helper hergebruiken (verwacht startsAt op top-level).
  const occByEvent = new Map<string, { startsAt: Date; endsAt: Date | null }>();
  if (eventsTrimmed.length > 0) {
    const ids = eventsTrimmed.map((e) => e.id);
    const rows = await db
      .select({
        eventId: schema.occurrences.eventId,
        startsAt: schema.occurrences.startsAt,
        endsAt: schema.occurrences.endsAt,
      })
      .from(schema.occurrences)
      .where(
        and(
          inArray(schema.occurrences.eventId, ids),
          gt(schema.occurrences.startsAt, sql`NOW() - INTERVAL '4 hours'`),
          sql`${schema.occurrences.status} <> 'cancelled'`
        )
      )
      .orderBy(asc(schema.occurrences.startsAt));
    for (const r of rows) {
      if (occByEvent.has(r.eventId)) continue; // eerstvolgende per event
      occByEvent.set(r.eventId, { startsAt: r.startsAt, endsAt: r.endsAt });
    }
  }

  const events = eventsTrimmed.map((e) => {
    const occ = occByEvent.get(e.id);
    return {
      ...e,
      startsAt: occ?.startsAt ?? null,
      endsAt: occ?.endsAt ?? null,
      // Velden die de ApiEvent-type op de client verwacht; meeste niet
      // zinvol voor search-resultaten — leeg/null returnen.
      priceCents: null,
      priceNote: null,
      ticketUrl: null,
      occurrenceCount: 1,
      occurrencesInRange: [],
      friendsSaved: [],
      friendsSavedCount: 0,
      venueFollowed: false,
      series: [],
      myInvitesCount: 0,
    };
  });

  // Wat mensen tevergeefs zoeken is het eerlijkste signaal dat we hebben
  // over wat er mist. Alleen echt lege uitkomsten, alleen op de eerste
  // pagina, en de term genormaliseerd zodat "Big Thief" en "big thief"
  // dezelfde regel worden.
  if (
    eventsOffset === 0 &&
    venues.length === 0 &&
    artists.length === 0 &&
    events.length === 0 &&
    rawQ.length >= 2
  ) {
    try {
      await db.execute(sql`
        INSERT INTO search_misses (q, hits)
        VALUES (lower(${rawQ}), 1)
        ON CONFLICT (q) DO UPDATE
          SET hits = search_misses.hits + 1, last_at = NOW()
      `);
    } catch {
      /* een niet-geschreven telling mag de zoek niet stukmaken */
    }
  }

  return c.json({ venues, artists, events, eventsHasMore });
});

/**
 * Artiesten die wij niet kennen, opgezocht in de Spotify-catalogus.
 *
 * Apart endpoint en niet in `/search`: de app roept dit alleen aan als de
 * eigen zoek niets opleverde. Zo kost het geen extra netwerkgang bij elke
 * toetsaanslag, en blijft de zoek werken als Spotify hapert.
 *
 * Dit vraagt géén inloggen: het zijn app-credentials, dus er is geen
 * gebruikers-OAuth en geen limiet van 25 mensen.
 */
searchRoute.get('/elsewhere', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  if (q.length < 2) return c.json({ artists: [] });

  const found = await searchSpotifyArtists(q, 5);
  if (found.length === 0) return c.json({ artists: [] });

  // Wie we zelf al hebben, hoort hier niet nog een keer te staan.
  const names = found.map((a) => a.name.toLowerCase());
  const mine = await db.execute<{ lower: string }>(sql`
    SELECT lower(name) AS lower FROM artists WHERE lower(name) = ANY(${names})
  `);
  const known = new Set((mine.rows ?? []).map((r) => r.lower));

  return c.json({
    artists: found
      .filter((a) => !known.has(a.name.toLowerCase()))
      .map((a) => ({
        name: a.name,
        imageUrl: a.imageUrl,
        genres: a.genres.slice(0, 3),
        spotifyUrl: `https://open.spotify.com/artist/${a.spotifyId}`,
      })),
  });
});
