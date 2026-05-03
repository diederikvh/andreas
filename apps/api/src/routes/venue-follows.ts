import { and, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import { auth } from '../auth.js';
import { db, schema } from '../db/index.js';

async function requireUserId(c: Context): Promise<string | Response> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  return session.user.id;
}

export type VenueFollowState = 'volgen' | 'normaal' | 'blokken';

export const venueFollowsRoute = new Hono();

/**
 * Set my follow-state voor een venue. `normaal` verwijdert de rij
 * (geen rij = default, geen voorkeur). Andere states upserten.
 */
venueFollowsRoute.post('/', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  const body = (await c.req.json()) as {
    venueId?: string;
    state?: VenueFollowState;
  };
  const venueId = body.venueId;
  const state = body.state;

  if (!venueId) return c.json({ error: 'venueId is verplicht' }, 400);
  if (state !== 'volgen' && state !== 'normaal' && state !== 'blokken') {
    return c.json(
      { error: 'state moet "volgen", "normaal" of "blokken" zijn' },
      400
    );
  }

  // Bestaat de venue? Voorkomt dangling rows.
  const [venue] = await db
    .select({ id: schema.venues.id })
    .from(schema.venues)
    .where(eq(schema.venues.id, venueId))
    .limit(1);
  if (!venue) return c.json({ error: 'venue niet gevonden' }, 404);

  if (state === 'normaal') {
    await db
      .delete(schema.venueFollows)
      .where(
        and(
          eq(schema.venueFollows.userId, me),
          eq(schema.venueFollows.venueId, venueId)
        )
      );
    return c.json({ state: 'normaal' as const });
  }

  // Upsert volgen / blokken — ON CONFLICT update state.
  await db
    .insert(schema.venueFollows)
    .values({ userId: me, venueId, state })
    .onConflictDoUpdate({
      target: [schema.venueFollows.userId, schema.venueFollows.venueId],
      set: { state },
    });

  return c.json({ state });
});

/**
 * Helper: lijst venue-IDs die ik geblokkeerd heb. Gebruikt door /events
 * + /events/:id om geblokkeerde venues volledig uit te filteren.
 */
export async function getBlockedVenueIds(meId: string): Promise<string[]> {
  const rows = await db
    .select({ venueId: schema.venueFollows.venueId })
    .from(schema.venueFollows)
    .where(
      and(
        eq(schema.venueFollows.userId, meId),
        eq(schema.venueFollows.state, 'blokken')
      )
    );
  return rows.map((r) => r.venueId);
}

/**
 * Helper: venue-IDs die ik actief volg (state=volgen). Gebruikt door
 * /events om events bij gevolgde venues te markeren met `venueFollowed`,
 * zodat de mobile-feed ze in een eigen sectie kan groeperen.
 */
export async function getFollowedVenueIds(meId: string): Promise<string[]> {
  const rows = await db
    .select({ venueId: schema.venueFollows.venueId })
    .from(schema.venueFollows)
    .where(
      and(
        eq(schema.venueFollows.userId, meId),
        eq(schema.venueFollows.state, 'volgen')
      )
    );
  return rows.map((r) => r.venueId);
}

/**
 * Helper: state voor één specifieke venue (gebruikt door /venues/:slug
 * om `myFollowState` op het detail-antwoord te zetten).
 */
export async function getVenueFollowState(
  meId: string,
  venueId: string
): Promise<VenueFollowState> {
  const [row] = await db
    .select({ state: schema.venueFollows.state })
    .from(schema.venueFollows)
    .where(
      and(
        eq(schema.venueFollows.userId, meId),
        eq(schema.venueFollows.venueId, venueId)
      )
    )
    .limit(1);
  return row?.state ?? 'normaal';
}
