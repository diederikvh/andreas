import { and, asc, count, desc, eq, gt, ilike, inArray, not, or, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';

import { db, schema } from '../db/index.js';
import {
  buildFriendsByEvent,
  buildOccurrencesByEvent,
  buildSeriesByEvent,
  findEventsWithOccurrencesInRange,
  maybeUserId,
} from './_helpers.js';
import {
  getBlockedVenueIds,
  getFollowedVenueIds,
} from './venue-follows.js';

const VALID_CATEGORIES = new Set(['Muziek', 'Theater', 'Literatuur', 'Film', 'Kunst']);

export const eventsRoute = new Hono();

eventsRoute.get('/', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);

  const featured = c.req.query('featured');
  const from = c.req.query('from');
  const to = c.req.query('to');
  const category = c.req.query('category');
  const q = c.req.query('q');
  // ?genre= kan herhaald worden voor multi-select OR-filter.
  const genres = c.req.queries('genre') ?? [];

  // Bepaal eerst welke events relevant zijn op basis van event-properties
  // (published, venue published, category, genre, search, blocked venues).
  // Daarna filteren we op occurrences in de date-range.
  const eventConditions: SQL[] = [
    eq(schema.events.published, true),
    eq(schema.venues.published, true),
  ];

  if (featured === 'true') {
    eventConditions.push(eq(schema.events.featured, true));
  }
  if (category && VALID_CATEGORIES.has(category)) {
    eventConditions.push(
      eq(
        schema.events.category,
        category as 'Muziek' | 'Theater' | 'Literatuur' | 'Film' | 'Kunst'
      )
    );
  }
  if (q && q.trim().length > 0) {
    const needle = `%${q.trim()}%`;
    const matchTitle = ilike(schema.events.title, needle);
    const matchVenue = ilike(schema.venues.name, needle);
    const matchDesc = ilike(schema.events.description, needle);
    const combined = or(matchTitle, matchVenue, matchDesc);
    if (combined) eventConditions.push(combined);
  }
  if (genres.length > 0) {
    eventConditions.push(
      sql`${schema.events.genres} && ARRAY[${sql.join(
        genres.map((g) => sql`${g}`),
        sql`, `
      )}]::text[]`
    );
  }

  const me = await maybeUserId(c);
  if (me) {
    const blocked = await getBlockedVenueIds(me);
    if (blocked.length > 0) {
      eventConditions.push(not(inArray(schema.events.venueId, blocked)));
    }
  }

  const eligibleEvents = await db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      description: schema.events.description,
      kind: schema.events.kind,
      imageUrl: schema.events.imageUrl,
      category: schema.events.category,
      featured: schema.events.featured,
      genres: schema.events.genres,
      venue: {
        id: schema.venues.id,
        slug: schema.venues.slug,
        name: schema.venues.name,
        address: schema.venues.address,
        lat: schema.venues.lat,
        lng: schema.venues.lng,
        priceNote: schema.venues.priceNote,
      },
    })
    .from(schema.events)
    .innerJoin(schema.venues, eq(schema.events.venueId, schema.venues.id))
    .where(and(...eventConditions));

  if (eligibleEvents.length === 0) return c.json({ events: [] });

  const fromDate = from ? new Date(from) : new Date();
  const toDate = to ? new Date(to) : undefined;
  const occRange = await findEventsWithOccurrencesInRange({
    from: !isNaN(fromDate.getTime()) ? fromDate : new Date(),
    to: toDate && !isNaN(toDate.getTime()) ? toDate : undefined,
    eventIds: eligibleEvents.map((e) => e.id),
  });

  // Sorteer events op next-occurrence startsAt (asc) — events zonder
  // toekomstige occurrence vallen weg.
  const eventById = new Map(eligibleEvents.map((e) => [e.id, e]));
  const ordered = occRange.eventIds
    .slice(0, limit)
    .map((id) => ({ event: eventById.get(id)!, occ: occRange.byEvent.get(id)! }))
    .filter((x) => x.event);

  const eventIds = ordered.map((x) => x.event.id);
  const friendsMap = me
    ? await buildFriendsByEvent(me, eventIds)
    : new Map();
  const seriesMap = await buildSeriesByEvent(eventIds);
  const followedVenueIds = me
    ? new Set(await getFollowedVenueIds(me))
    : new Set<string>();

  const events = ordered.map(({ event, occ }) => {
    const friends = friendsMap.get(event.id);
    return {
      ...event,
      // gedenormaliseerd vanuit nextOccurrence
      startsAt: occ.next?.startsAt ?? null,
      endsAt: occ.next?.endsAt ?? null,
      priceCents: occ.next?.priceCents ?? null,
      priceNote: occ.next?.priceNote ?? null,
      ticketUrl: occ.next?.ticketUrl ?? null,
      occurrenceCount: occ.count,
      // Volledige lijst occurrences in de gevraagde range — Agenda en
      // Avond gebruiken dit om per moment één rij te tonen ipv één per
      // event. Een 3-daags festival verschijnt zo op alle 3 dagen.
      occurrencesInRange: occ.all,
      friendsSaved: friends?.friends ?? [],
      friendsSavedCount: friends?.count ?? 0,
      venueFollowed: followedVenueIds.has(event.venue.id),
      series: seriesMap.get(event.id) ?? [],
    };
  });

  return c.json({ events });
});

/**
 * Distinct genre-lijst voor de filter-sheet in de Agenda. Groepeert
 * per category zodat de mobile UI muziek-genres scheidt van theater
 * en kunst. Alleen toekomstige, gepubliceerde events meegerekend.
 */
eventsRoute.get('/genres', async (c) => {
  // Genres-buckets: alleen events met minstens één toekomstige (of nog
  // lopende, voor exhibitions) occurrence tellen mee.
  const rows = await db
    .select({
      genre: sql<string>`unnest(${schema.events.genres})`.as('genre'),
      category: schema.events.category,
      n: count(),
    })
    .from(schema.events)
    .innerJoin(schema.venues, eq(schema.events.venueId, schema.venues.id))
    .innerJoin(
      schema.occurrences,
      eq(schema.occurrences.eventId, schema.events.id)
    )
    .where(
      and(
        eq(schema.events.published, true),
        eq(schema.venues.published, true),
        // Show: strict starts_at; exhibition: ends_at-fallback.
        sql`(
          (${schema.events.kind} = 'exhibition'
            AND COALESCE(${schema.occurrences.endsAt}, ${schema.occurrences.startsAt}) >= NOW())
          OR (${schema.events.kind} <> 'exhibition'
            AND ${schema.occurrences.startsAt} >= NOW())
        )`,
        sql`${schema.occurrences.status} <> 'cancelled'`
      )
    )
    .groupBy(sql`unnest(${schema.events.genres})`, schema.events.category)
    .orderBy(schema.events.category, desc(count()));

  const genres = rows.map((r) => ({
    genre: r.genre,
    category: r.category,
    count: Number(r.n),
  }));
  return c.json({ genres });
});

eventsRoute.get('/:id', async (c) => {
  const id = c.req.param('id');

  const [row] = await db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      description: schema.events.description,
      kind: schema.events.kind,
      imageUrl: schema.events.imageUrl,
      category: schema.events.category,
      featured: schema.events.featured,
      genres: schema.events.genres,
      venue: {
        id: schema.venues.id,
        slug: schema.venues.slug,
        name: schema.venues.name,
        address: schema.venues.address,
        lat: schema.venues.lat,
        lng: schema.venues.lng,
        description: schema.venues.description,
        imageUrl: schema.venues.imageUrl,
        priceNote: schema.venues.priceNote,
      },
    })
    .from(schema.events)
    .innerJoin(schema.venues, eq(schema.events.venueId, schema.venues.id))
    .where(
      and(
        eq(schema.events.id, id),
        eq(schema.events.published, true),
        eq(schema.venues.published, true)
      )
    )
    .limit(1);

  if (!row) return c.json({ error: 'event not found' }, 404);

  const me = await maybeUserId(c);
  const friendsMap = me ? await buildFriendsByEvent(me, [row.id]) : new Map();
  const entry = friendsMap.get(row.id);
  const seriesMap = await buildSeriesByEvent([row.id]);
  // Detail-page: ook afgelopen events kunnen geopend worden via een
  // share-link of saved-link, dus pak ook past-occurrences als fallback.
  const occMap = await buildOccurrencesByEvent([row.id], { includePast: true });
  const occ = occMap.get(row.id);

  // Mijn eigen verstuurde invites voor dit event — gebruikt op detail
  // (toont wie ik gevraagd heb + status) én op de invite-modal (om
  // dubbele invites te blokkeren). Filtert op de occurrences van dit
  // event zodat invites voor andere events nooit lekken.
  const occurrenceIds = (occ?.all ?? []).map((o) => o.id);
  const myInvites =
    me && occurrenceIds.length > 0
      ? await db
          .select({
            id: schema.invites.id,
            status: schema.invites.status,
            message: schema.invites.message,
            occurrenceId: schema.invites.occurrenceId,
            occurrenceStartsAt: schema.occurrences.startsAt,
            toUserId: schema.users.id,
            toName: schema.users.name,
            toHandle: schema.users.handle,
            toAvatarUrl: schema.users.avatarUrl,
          })
          .from(schema.invites)
          .innerJoin(schema.users, eq(schema.users.id, schema.invites.toUserId))
          .innerJoin(
            schema.occurrences,
            eq(schema.occurrences.id, schema.invites.occurrenceId)
          )
          .where(
            and(
              eq(schema.invites.fromUserId, me),
              inArray(schema.invites.occurrenceId, occurrenceIds)
            )
          )
          .orderBy(asc(schema.invites.createdAt))
      : [];

  return c.json({
    event: {
      ...row,
      // Gedenormaliseerd vanuit nextOccurrence — voor list-clients die
      // ook detail krijgen via dezelfde shape.
      startsAt: occ?.next?.startsAt ?? null,
      endsAt: occ?.next?.endsAt ?? null,
      priceCents: occ?.next?.priceCents ?? null,
      priceNote: occ?.next?.priceNote ?? null,
      ticketUrl: occ?.next?.ticketUrl ?? null,
      occurrenceCount: occ?.count ?? 0,
      occurrences: occ?.all ?? [],
      friendsSaved: entry?.friends ?? [],
      friendsSavedCount: entry?.count ?? 0,
      series: seriesMap.get(row.id) ?? [],
      myInvites: myInvites.map((i) => ({
        id: i.id,
        status: i.status,
        message: i.message,
        occurrenceId: i.occurrenceId,
        occurrenceStartsAt: i.occurrenceStartsAt,
        to: {
          id: i.toUserId,
          name: i.toName,
          handle: i.toHandle,
          avatarUrl: i.toAvatarUrl,
        },
      })),
    },
  });
});
