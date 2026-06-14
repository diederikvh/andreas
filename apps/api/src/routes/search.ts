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
import { Hono } from 'hono';

import { db, schema } from '../db/index.js';

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

  // Venues — alleen op de eerste pagina laden (eventsOffset === 0).
  // Voor scroll-pagina's heeft de client de venues al; opnieuw fetchen
  // verspilt round-trip-tijd.
  const venues =
    eventsOffset === 0
      ? await db
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
              ilike(schema.venues.name, needle)
            )
          )
          .orderBy(asc(schema.venues.name))
          .limit(VENUE_CAP)
      : [];

  // Events — match op title OF venue-naam. Filter: published events
  // bij published venues, ≥1 toekomstige occurrence. We sorteren op
  // de eerstvolgende occurrence (asc) door een subquery, en paginen
  // met limit/offset.
  const eventConditions: SQL[] = [
    eq(schema.events.published, true),
    eq(schema.venues.published, true),
  ];
  const matchEvent = or(
    ilike(schema.events.title, needle),
    ilike(schema.venues.name, needle)
  );
  if (matchEvent) eventConditions.push(matchEvent);

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

  const eventRows = await db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      kind: schema.events.kind,
      category: schema.events.category,
      featured: schema.events.featured,
      genres: schema.events.genres,
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
    .where(and(...eventConditions))
    .orderBy(asc(nextOccSubquery.nextStartsAt))
    .limit(EVENTS_LIMIT + 1)
    .offset(eventsOffset);

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

  return c.json({ venues, events, eventsHasMore });
});
