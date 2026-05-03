import { and, asc, eq, gte, ilike, inArray, lte, not, or, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';

import { db, schema } from '../db/index.js';
import {
  buildFriendsByEvent,
  buildSeriesByEvent,
  maybeUserId,
} from './_helpers.js';
import {
  getBlockedVenueIds,
  getFollowedVenueIds,
} from './venue-follows.js';

const VALID_CATEGORIES = new Set(['Muziek', 'Theater', 'Literatuur', 'Film']);

export const eventsRoute = new Hono();

eventsRoute.get('/', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);

  const featured = c.req.query('featured');
  const from = c.req.query('from');
  const to = c.req.query('to');
  const category = c.req.query('category');
  const q = c.req.query('q');

  const conditions: SQL[] = [
    eq(schema.events.published, true),
    eq(schema.venues.published, true),
  ];

  if (featured === 'true') {
    conditions.push(eq(schema.events.featured, true));
  }
  if (from) {
    const d = new Date(from);
    if (!isNaN(d.getTime())) conditions.push(gte(schema.events.startsAt, d));
  }
  if (to) {
    const d = new Date(to);
    if (!isNaN(d.getTime())) conditions.push(lte(schema.events.startsAt, d));
  }
  if (category && VALID_CATEGORIES.has(category)) {
    conditions.push(
      eq(
        schema.events.category,
        category as 'Muziek' | 'Theater' | 'Literatuur' | 'Film'
      )
    );
  }
  if (q && q.trim().length > 0) {
    const needle = `%${q.trim()}%`;
    const matchTitle = ilike(schema.events.title, needle);
    const matchVenue = ilike(schema.venues.name, needle);
    const matchDesc = ilike(schema.events.description, needle);
    const combined = or(matchTitle, matchVenue, matchDesc);
    if (combined) conditions.push(combined);
  }

  // Blokken-filter: events bij venues die ik geblokkeerd heb komen
  // niet in de feed terecht. Anonieme requests zien alles.
  const me = await maybeUserId(c);
  if (me) {
    const blocked = await getBlockedVenueIds(me);
    if (blocked.length > 0) {
      conditions.push(not(inArray(schema.events.venueId, blocked)));
    }
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      description: schema.events.description,
      startsAt: schema.events.startsAt,
      endsAt: schema.events.endsAt,
      priceCents: schema.events.priceCents,
      ticketUrl: schema.events.ticketUrl,
      imageUrl: schema.events.imageUrl,
      category: schema.events.category,
      featured: schema.events.featured,
      venue: {
        id: schema.venues.id,
        slug: schema.venues.slug,
        name: schema.venues.name,
        address: schema.venues.address,
        lat: schema.venues.lat,
        lng: schema.venues.lng,
      },
    })
    .from(schema.events)
    .innerJoin(schema.venues, eq(schema.events.venueId, schema.venues.id))
    .where(where)
    .orderBy(asc(schema.events.startsAt))
    .limit(limit);

  const eventIds = rows.map((r) => r.id);
  const friendsMap = me
    ? await buildFriendsByEvent(me, eventIds)
    : new Map();
  const seriesMap = await buildSeriesByEvent(eventIds);

  // Markeer events bij venues die ik volg — mobile groepeert hierop.
  const followedVenueIds = me
    ? new Set(await getFollowedVenueIds(me))
    : new Set<string>();

  const events = rows.map((r) => {
    const entry = friendsMap.get(r.id);
    return {
      ...r,
      friendsSaved: entry?.friends ?? [],
      friendsSavedCount: entry?.count ?? 0,
      venueFollowed: followedVenueIds.has(r.venue.id),
      series: seriesMap.get(r.id) ?? [],
    };
  });

  return c.json({ events });
});

eventsRoute.get('/:id', async (c) => {
  const id = c.req.param('id');

  const [row] = await db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      description: schema.events.description,
      startsAt: schema.events.startsAt,
      endsAt: schema.events.endsAt,
      priceCents: schema.events.priceCents,
      ticketUrl: schema.events.ticketUrl,
      imageUrl: schema.events.imageUrl,
      category: schema.events.category,
      featured: schema.events.featured,
      venue: {
        id: schema.venues.id,
        slug: schema.venues.slug,
        name: schema.venues.name,
        address: schema.venues.address,
        lat: schema.venues.lat,
        lng: schema.venues.lng,
        description: schema.venues.description,
        imageUrl: schema.venues.imageUrl,
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

  // Mijn eigen verstuurde invites voor dit event — gebruikt op detail
  // (toont wie ik gevraagd heb + status) én op de invite-modal (om
  // dubbele invites te blokkeren).
  const myInvites = me
    ? await db
        .select({
          id: schema.invites.id,
          status: schema.invites.status,
          message: schema.invites.message,
          toUserId: schema.users.id,
          toName: schema.users.name,
          toHandle: schema.users.handle,
          toAvatarUrl: schema.users.avatarUrl,
        })
        .from(schema.invites)
        .innerJoin(schema.users, eq(schema.users.id, schema.invites.toUserId))
        .where(
          and(
            eq(schema.invites.fromUserId, me),
            eq(schema.invites.eventId, row.id)
          )
        )
        .orderBy(asc(schema.invites.createdAt))
    : [];

  return c.json({
    event: {
      ...row,
      friendsSaved: entry?.friends ?? [],
      friendsSavedCount: entry?.count ?? 0,
      series: seriesMap.get(row.id) ?? [],
      myInvites: myInvites.map((i) => ({
        id: i.id,
        status: i.status,
        message: i.message,
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
