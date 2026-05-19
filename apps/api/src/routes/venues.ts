import {
  and,
  arrayContains,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { Hono } from 'hono';

import { auth } from '../auth.js';
import { db, schema } from '../db/index.js';
import {
  buildFriendsByOccurrence,
  buildSeriesByEvent,
  findEventsWithOccurrencesInRange,
} from './_helpers.js';
import { getVenueFollowState } from './venue-follows.js';

export const venuesRoute = new Hono();

/**
 * Lijst van alle venues, alfabetisch op naam, optioneel gefilterd op
 * `q` (naam of adres, substring-match). Gebruikt voor de bladerbare
 * venue-lijst. Geblokkeerde venues blijven zichtbaar zodat je ze kan
 * deblokkeren — er staat een hint op de UI dat ze geblokkeerd zijn.
 */
const VALID_CATEGORIES = new Set(['Muziek', 'Theater', 'Literatuur', 'Film', 'Kunst', 'Lezing']);
const VALID_VENUE_TYPES = new Set([
  'galerie',
  'museum',
  'podium',
  'club',
  'film',
  'ruimte',
  'boekhandel-cafe',
]);
const VALID_DAY_NIGHT = new Set(['day', 'night', 'both']);
const VALID_WIJKEN = new Set([
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
]);
const VALID_SCENES = new Set([
  'mainstream',
  'alternatief',
  'underground',
  'fringe',
]);

venuesRoute.get('/', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  const category = c.req.query('category');
  const type = c.req.query('type');
  const dn = c.req.query('dayNight');
  const wijk = c.req.query('wijk');
  const scene = c.req.query('scene');

  const conditions: SQL[] = [eq(schema.venues.published, true)];
  if (q.length > 0) {
    const needle = `%${q}%`;
    const matchName = ilike(schema.venues.name, needle);
    const matchAddress = ilike(schema.venues.address, needle);
    const combined = or(matchName, matchAddress);
    if (combined) conditions.push(combined);
  }
  if (category && VALID_CATEGORIES.has(category)) {
    conditions.push(
      arrayContains(schema.venues.categories, [
        category as 'Muziek' | 'Theater' | 'Literatuur' | 'Film' | 'Kunst' | 'Lezing',
      ])
    );
  }
  if (type && VALID_VENUE_TYPES.has(type)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    conditions.push(eq(schema.venues.type, type as any));
  }
  // dayNight-filter: 'day' of 'night' includeert ook 'both' (venues
  // die beide kanten op kunnen). Alleen ophalen waar dayNight expliciet
  // is gezet — venues zonder waarde vallen buiten de filter.
  if (dn && VALID_DAY_NIGHT.has(dn)) {
    if (dn === 'both') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      conditions.push(eq(schema.venues.dayNight, 'both' as any));
    } else {
      const matchDn = or(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        eq(schema.venues.dayNight, dn as any),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        eq(schema.venues.dayNight, 'both' as any)
      );
      if (matchDn) conditions.push(matchDn);
    }
  }
  if (wijk && VALID_WIJKEN.has(wijk)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    conditions.push(eq(schema.venues.wijk, wijk as any));
  }
  if (scene && VALID_SCENES.has(scene)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    conditions.push(eq(schema.venues.scene, scene as any));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      id: schema.venues.id,
      slug: schema.venues.slug,
      name: schema.venues.name,
      address: schema.venues.address,
      lat: schema.venues.lat,
      lng: schema.venues.lng,
      imageUrl: schema.venues.imageUrl,
      description: schema.venues.description,
      categories: schema.venues.categories,
      type: schema.venues.type,
      dayNight: schema.venues.dayNight,
      wijk: schema.venues.wijk,
      scene: schema.venues.scene,
      capacity: schema.venues.capacity,
      subtype: schema.venues.subtype,
      website: schema.venues.website,
      instagram: schema.venues.instagram,
      priceNote: schema.venues.priceNote,
    })
    .from(schema.venues)
    .where(where)
    .orderBy(asc(schema.venues.name));

  // Hang per-venue follow-state aan voor ingelogde users.
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  let followMap = new Map<string, 'volgen' | 'blokken'>();
  if (session && rows.length > 0) {
    const venueIds = rows.map((r) => r.id);
    const follows = await db
      .select({
        venueId: schema.venueFollows.venueId,
        state: schema.venueFollows.state,
      })
      .from(schema.venueFollows)
      .where(
        and(
          eq(schema.venueFollows.userId, session.user.id),
          inArray(schema.venueFollows.venueId, venueIds)
        )
      );
    followMap = new Map(follows.map((f) => [f.venueId, f.state]));
  }

  const venues = rows.map((r) => ({
    ...r,
    myFollowState: followMap.get(r.id) ?? ('normaal' as const),
  }));

  return c.json({ venues });
});

/**
 * Distinct subtype-tags per venue-type, met count. Gebruikt door de
 * Venues filter-sheet om de "Sub-types"-chips te bouwen. Caller geeft
 * optioneel een lijst types mee om de subtypes scope-bound te maken
 * (bv. alleen subtypes binnen `galerie` + `museum`); zonder types
 * komen alle subtypes per type terug.
 *
 * MOET vóór `GET /:slug` blijven staan omdat Hono z'n routes in
 * declaratie-volgorde matcht.
 */
venuesRoute.get('/subtypes', async (c) => {
  const types = c.req.queries('type') ?? [];
  const conditions: SQL[] = [eq(schema.venues.published, true)];
  if (types.length > 0) {
    const validTypes = types.filter((t) =>
      VALID_VENUE_TYPES.has(t)
    ) as Array<typeof VENUE_TYPE_VALUES[number]>;
    if (validTypes.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      conditions.push(inArray(schema.venues.type, validTypes as any));
    }
  }

  const rows = await db
    .select({
      subtype: sql<string>`unnest(${schema.venues.subtype})`.as('subtype'),
      type: schema.venues.type,
      n: count(),
    })
    .from(schema.venues)
    .where(and(...conditions))
    .groupBy(sql`unnest(${schema.venues.subtype})`, schema.venues.type)
    .orderBy(desc(count()));

  const subtypes = rows.map((r) => ({
    subtype: r.subtype,
    type: r.type,
    count: Number(r.n),
  }));
  return c.json({ subtypes });
});

const VENUE_TYPE_VALUES = [
  'galerie',
  'museum',
  'podium',
  'club',
  'film',
  'ruimte',
  'boekhandel-cafe',
] as const;

venuesRoute.get('/:slug', async (c) => {
  const slug = c.req.param('slug');

  const [venue] = await db
    .select()
    .from(schema.venues)
    .where(
      and(eq(schema.venues.slug, slug), eq(schema.venues.published, true))
    )
    .limit(1);

  if (!venue) return c.json({ error: 'venue not found' }, 404);

  // Events die hier spelen = events met ten minste één occurrence waar
  // de effectieve venue (occurrence.venueId óf, als die NULL is,
  // event.venueId) gelijk is aan deze venue. Voor films-met-multi-venue
  // (event.venueId blijft "eerste scraper", maar occurrences kunnen
  // overal draaien) is dit de enige correcte filter. Voor concerts/
  // theater valt occurrence.venueId samen met event.venueId, dus zelfde
  // resultaat als de oude query.
  const eventRows = await db
    .selectDistinct({
      id: schema.events.id,
      title: schema.events.title,
      description: schema.events.description,
      kind: schema.events.kind,
      imageUrl: schema.events.imageUrl,
      category: schema.events.category,
      featured: schema.events.featured,
      genres: schema.events.genres,
    })
    .from(schema.events)
    .innerJoin(
      schema.occurrences,
      eq(schema.occurrences.eventId, schema.events.id)
    )
    .where(
      and(
        sql`COALESCE(${schema.occurrences.venueId}, ${schema.events.venueId}) = ${venue.id}`,
        eq(schema.events.published, true)
      )
    );

  // Scope occurrences op deze venue zodat Anora's Kriterion-rij níet
  // op /v/eye-filmmuseum verschijnt — alleen de Eye-screenings tellen.
  const occRange = await findEventsWithOccurrencesInRange({
    eventIds: eventRows.map((e) => e.id),
    venueId: venue.id,
  });

  // myFollowState: alleen als ingelogd. Default voor anonieme requests
  // is `normaal` zodat de UI zonder auth-context ook werkt.
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const me = session?.user.id ?? null;
  const myFollowState = me
    ? await getVenueFollowState(me, venue.id)
    : 'normaal';

  // Per occurrence z'n eigen friends-pill + per event de series-pill,
  // zodat ProgramRow op /venue/[slug] dezelfde rijke labels krijgt als
  // Avond/Agenda. Bouwt op alle occurrences in range zodat een
  // ?o=switch later zonder extra fetch werkt.
  const allOccurrenceIds = occRange.eventIds.flatMap((id) => {
    const occ = occRange.byEvent.get(id);
    return occ?.all.map((o) => o.id) ?? [];
  });
  const friendsByOcc = me
    ? await buildFriendsByOccurrence(me, allOccurrenceIds)
    : new Map();
  const seriesMap = await buildSeriesByEvent(occRange.eventIds);

  const eventById = new Map(eventRows.map((e) => [e.id, e]));
  const events = occRange.eventIds
    .map((id) => {
      const event = eventById.get(id);
      const occ = occRange.byEvent.get(id);
      if (!event || !occ) return null;
      const headFriends = occ.next ? friendsByOcc.get(occ.next.id) : undefined;
      // occurrencesInRange = alle occurrences-bij-deze-venue voor dit
      // event (occRange is al gescoped). UI gebruikt occ[0].id om
      // `?o=…` mee te geven bij een rij-tap zodat event-detail de
      // eerstvolgende voorstelling AT THIS VENUE selecteert — anders
      // valt 't terug op de globale next, die voor een multi-venue film
      // bij een ander venue kan zitten (zoals Theater de Omval i.p.v. Eye).
      const occurrencesInRange = occ.all.map((o) => {
        const f = friendsByOcc.get(o.id);
        return {
          ...o,
          friendsSaved: f?.friends ?? [],
          friendsSavedCount: f?.count ?? 0,
        };
      });
      return {
        ...event,
        startsAt: occ.next?.startsAt ?? null,
        endsAt: occ.next?.endsAt ?? null,
        priceCents: occ.next?.priceCents ?? null,
        priceNote: occ.next?.priceNote ?? null,
        ticketUrl: occ.next?.ticketUrl ?? null,
        occurrenceCount: occ.count,
        nextOccurrenceVenue: occ.next?.venue ?? null,
        occurrencesInRange,
        friendsSaved: headFriends?.friends ?? [],
        friendsSavedCount: headFriends?.count ?? 0,
        series: seriesMap.get(event.id) ?? [],
      };
    })
    .filter((x) => x !== null);

  // Welke series spelen er in deze venue? Distinct op series.id, alleen
  // als er minstens één toekomstig event in deze venue speelt dat in
  // die serie zit. Series waarvan `endsAt` in het verleden ligt komen
  // niet meer terug — anders blijft "Hier speelt: ADE" hangen lang
  // nadat ADE voorbij is. We koppelen via occurrences zodat we toekomst
  // bepalen op basis van occurrence.startsAt.
  const now = new Date();
  const seriesRows = await db
    .selectDistinct({
      id: schema.series.id,
      slug: schema.series.slug,
      name: schema.series.name,
      imageUrl: schema.series.imageUrl,
    })
    .from(schema.series)
    .innerJoin(
      schema.eventsInSeries,
      eq(schema.eventsInSeries.seriesId, schema.series.id)
    )
    .innerJoin(
      schema.events,
      eq(schema.events.id, schema.eventsInSeries.eventId)
    )
    .innerJoin(
      schema.occurrences,
      eq(schema.occurrences.eventId, schema.events.id)
    )
    .where(
      and(
        // Zelfde effectieve-venue-logica als hierboven: een serie hoort
        // bij deze venue als 't event hier speelt op event- óf
        // occurrence-niveau (films-multi-venue).
        sql`COALESCE(${schema.occurrences.venueId}, ${schema.events.venueId}) = ${venue.id}`,
        eq(schema.events.published, true),
        eq(schema.series.published, true),
        gte(schema.occurrences.startsAt, now),
        or(isNull(schema.series.endsAt), gt(schema.series.endsAt, now))
      )
    )
    .orderBy(asc(schema.series.name));

  return c.json({ venue, events, myFollowState, series: seriesRows });
});
