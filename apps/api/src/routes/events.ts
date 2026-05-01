import { and, asc, eq, gte, ilike, lte, or, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';

import { db, schema } from '../db/index.js';

const VALID_CATEGORIES = new Set(['Muziek', 'Theater', 'Literatuur', 'Film']);

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

  return c.json({ events: rows });
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

  return c.json({ event: row });
});
