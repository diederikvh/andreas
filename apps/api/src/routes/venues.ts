import {
  and,
  arrayContains,
  asc,
  eq,
  gte,
  ilike,
  inArray,
  or,
  type SQL,
} from 'drizzle-orm';
import { Hono } from 'hono';

import { auth } from '../auth.js';
import { db, schema } from '../db/index.js';
import { getVenueFollowState } from './venue-follows.js';

export const venuesRoute = new Hono();

/**
 * Lijst van alle venues, alfabetisch op naam, optioneel gefilterd op
 * `q` (naam of adres, substring-match). Gebruikt voor de bladerbare
 * venue-lijst. Geblokkeerde venues blijven zichtbaar zodat je ze kan
 * deblokkeren — er staat een hint op de UI dat ze geblokkeerd zijn.
 */
const VALID_CATEGORIES = new Set(['Muziek', 'Theater', 'Literatuur', 'Film']);

venuesRoute.get('/', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  const category = c.req.query('category');

  const conditions: SQL[] = [];
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
        category as 'Muziek' | 'Theater' | 'Literatuur' | 'Film',
      ])
    );
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

venuesRoute.get('/:slug', async (c) => {
  const slug = c.req.param('slug');

  const [venue] = await db
    .select()
    .from(schema.venues)
    .where(eq(schema.venues.slug, slug))
    .limit(1);

  if (!venue) return c.json({ error: 'venue not found' }, 404);

  const events = await db
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
    })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.venueId, venue.id),
        gte(schema.events.startsAt, new Date())
      )
    )
    .orderBy(asc(schema.events.startsAt));

  // myFollowState: alleen als ingelogd. Default voor anonieme requests
  // is `normaal` zodat de UI zonder auth-context ook werkt.
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const myFollowState = session
    ? await getVenueFollowState(session.user.id, venue.id)
    : 'normaal';

  return c.json({ venue, events, myFollowState });
});
