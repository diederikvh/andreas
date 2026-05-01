import { and, asc, eq, gte } from 'drizzle-orm';
import { Hono } from 'hono';

import { db, schema } from '../db/index.js';

export const venuesRoute = new Hono();

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

  return c.json({ venue, events });
});
