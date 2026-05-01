import { and, asc, eq, gte, ilike, inArray, lte, or, type SQL } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import { auth } from '../auth.js';
import { db, schema } from '../db/index.js';

const VALID_CATEGORIES = new Set(['Muziek', 'Theater', 'Literatuur', 'Film']);

const FRIEND_PILL_LIMIT = 3;

type FriendBadge = {
  id: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
};

/**
 * Voor een gegeven set event-IDs: welke van mijn vrienden hebben elk
 * event opgeslagen? Limiet per event = FRIEND_PILL_LIMIT, in
 * naam-volgorde, plus een totaal-tellertje.
 *
 * TODO (privacy): later checken op users.privacy / per-friendship
 * "kan zien wat ik save" voordat hier een save zichtbaar wordt.
 */
async function buildFriendsByEvent(
  meId: string,
  eventIds: string[]
): Promise<Map<string, { friends: FriendBadge[]; count: number }>> {
  const map = new Map<string, { friends: FriendBadge[]; count: number }>();
  if (eventIds.length === 0) return map;

  // Mijn vrienden — beide richtingen, accepted.
  const friendships = await db
    .select({
      fromUserId: schema.friendships.fromUserId,
      toUserId: schema.friendships.toUserId,
    })
    .from(schema.friendships)
    .where(
      and(
        eq(schema.friendships.status, 'accepted'),
        or(
          eq(schema.friendships.fromUserId, meId),
          eq(schema.friendships.toUserId, meId)
        )
      )
    );
  const friendIds = friendships.map((f) =>
    f.fromUserId === meId ? f.toUserId : f.fromUserId
  );
  if (friendIds.length === 0) return map;

  const rows = await db
    .select({
      eventId: schema.saves.eventId,
      id: schema.users.id,
      name: schema.users.name,
      handle: schema.users.handle,
      avatarUrl: schema.users.avatarUrl,
    })
    .from(schema.saves)
    .innerJoin(schema.users, eq(schema.users.id, schema.saves.userId))
    .where(
      and(
        inArray(schema.saves.userId, friendIds),
        inArray(schema.saves.eventId, eventIds)
      )
    );

  for (const r of rows) {
    const entry = map.get(r.eventId) ?? { friends: [], count: 0 };
    entry.count += 1;
    if (entry.friends.length < FRIEND_PILL_LIMIT) {
      entry.friends.push({
        id: r.id,
        name: r.name,
        handle: r.handle,
        avatarUrl: r.avatarUrl,
      });
    }
    map.set(r.eventId, entry);
  }
  // Stabiele volgorde: naam alfabetisch.
  for (const entry of map.values()) {
    entry.friends.sort((a, b) => a.name.localeCompare(b.name));
  }
  return map;
}

async function maybeUserId(c: Context): Promise<string | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user.id ?? null;
}

export const eventsRoute = new Hono();

eventsRoute.get('/', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);

  const featured = c.req.query('featured');
  const from = c.req.query('from');
  const to = c.req.query('to');
  const category = c.req.query('category');
  const q = c.req.query('q');

  const conditions: SQL[] = [];

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

  const me = await maybeUserId(c);
  const friendsMap = me
    ? await buildFriendsByEvent(
        me,
        rows.map((r) => r.id)
      )
    : new Map();

  const events = rows.map((r) => {
    const entry = friendsMap.get(r.id);
    return {
      ...r,
      friendsSaved: entry?.friends ?? [],
      friendsSavedCount: entry?.count ?? 0,
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
    .where(eq(schema.events.id, id))
    .limit(1);

  if (!row) return c.json({ error: 'event not found' }, 404);

  const me = await maybeUserId(c);
  const friendsMap = me ? await buildFriendsByEvent(me, [row.id]) : new Map();
  const entry = friendsMap.get(row.id);

  return c.json({
    event: {
      ...row,
      friendsSaved: entry?.friends ?? [],
      friendsSavedCount: entry?.count ?? 0,
    },
  });
});
