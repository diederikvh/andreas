import { and, eq, inArray, isNull, not, or, sql } from 'drizzle-orm';
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
 * Bulk-follow — gebruikt door de "Aanbevolen"-onboarding op /voor-jou
 * (en later mogelijk andere bulk-acties). Accepteert een lijst venue-
 * IDs en upsert ze allemaal naar state='volgen'. Niet-bestaande IDs
 * worden stilzwijgend overgeslagen.
 */
venueFollowsRoute.post('/bulk', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;
  const body = (await c.req.json()) as { venueIds?: unknown };
  if (!Array.isArray(body.venueIds)) {
    return c.json({ error: 'venueIds[] is verplicht' }, 400);
  }
  const ids = body.venueIds.filter((x): x is string => typeof x === 'string');
  if (ids.length === 0) return c.json({ followed: 0 });

  // Filter op bestaande venues om geen FK-violations te krijgen.
  const existing = await db
    .select({ id: schema.venues.id })
    .from(schema.venues)
    .where(inArray(schema.venues.id, ids));
  const valid = existing.map((r) => r.id);
  if (valid.length === 0) return c.json({ followed: 0 });

  await db
    .insert(schema.venueFollows)
    .values(valid.map((venueId) => ({ userId: me, venueId, state: 'volgen' as const })))
    .onConflictDoUpdate({
      target: [schema.venueFollows.userId, schema.venueFollows.venueId],
      set: { state: 'volgen' },
    });
  return c.json({ followed: valid.length });
});

/**
 * Bootstrap-suggesties voor de Aanbevolen-onboarding. Geen DB-writes —
 * pure preview op basis van scenes + flavor. Returnt twee lijsten:
 *   - selected: venues die perfect matchen (binnen flavor)
 *   - maybe:    venues op de grens (naburige flavor of ongetagd)
 * User kan zelf in/uit-vinken voor de bulk-follow commit.
 *
 * Query-params:
 *   ?scenes=dansen,concerten,klassiek_jazz,theater,film,kunst,lezingen
 *   ?flavor=mainstream | alternatief | niche
 */
venueFollowsRoute.get('/bootstrap-suggestions', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  type Scene =
    | 'dansen'
    | 'concerten'
    | 'klassiek_jazz'
    | 'theater'
    | 'film'
    | 'kunst'
    | 'lezingen';
  type Flavor = 'mainstream' | 'alternatief' | 'niche';

  const scenesRaw = (c.req.query('scenes') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const flavor = c.req.query('flavor') as Flavor | undefined;
  const validScenes = (
    ['dansen', 'concerten', 'klassiek_jazz', 'theater', 'film', 'kunst', 'lezingen'] as const
  ).filter((s) => scenesRaw.includes(s));
  if (validScenes.length === 0) {
    return c.json({ error: 'minstens één scene is verplicht' }, 400);
  }
  if (flavor !== 'mainstream' && flavor !== 'alternatief' && flavor !== 'niche') {
    return c.json({ error: 'flavor moet mainstream|alternatief|niche zijn' }, 400);
  }

  // Subtype-buckets voor het splitsen van Muziek-podia tussen concerten
  // en klassiek/jazz. Niet exhaustief: een venue zonder subtype valt
  // niet in beide, alleen in "concerten" als 'ie podium is.
  //
  // Inline ARRAY-literal: Drizzle bindt een raw JS-array niet als
  // `text[]` zonder expliciete cast — `&&` werkt dan niet.
  const classicalArr = sql`ARRAY['klassiek','jazz','wereldmuziek','wereld','experimenteel','akoestisch','opera','hedendaags']::text[]`;

  // Bouw een SQL-conditie per scene en OR ze samen.
  const sceneConditions = validScenes.map((s) => {
    switch (s) {
      case 'dansen':
        return and(
          sql`${schema.venues.categories} && ARRAY['Muziek']::event_category[]`,
          eq(schema.venues.type, 'club'),
        );
      case 'concerten':
        return and(
          sql`${schema.venues.categories} && ARRAY['Muziek']::event_category[]`,
          eq(schema.venues.type, 'podium'),
          // Subtype mag null zijn OF niet in klassiek/jazz lijst.
          or(
            sql`${schema.venues.subtype} IS NULL`,
            sql`NOT (${schema.venues.subtype} && ${classicalArr})`,
          ),
        );
      case 'klassiek_jazz':
        return and(
          sql`${schema.venues.categories} && ARRAY['Muziek']::event_category[]`,
          eq(schema.venues.type, 'podium'),
          sql`${schema.venues.subtype} && ${classicalArr}`,
        );
      case 'theater':
        return sql`${schema.venues.categories} && ARRAY['Theater']::event_category[]`;
      case 'film':
        return sql`${schema.venues.categories} && ARRAY['Film']::event_category[]`;
      case 'kunst':
        return sql`${schema.venues.categories} && ARRAY['Kunst']::event_category[]`;
      case 'lezingen':
        return sql`${schema.venues.categories} && ARRAY['Lezing','Literatuur']::event_category[]`;
    }
  });
  const anyScene = sceneConditions.length === 1
    ? sceneConditions[0]
    : or(...sceneConditions);

  // Flavor → venue.scene mapping.
  const FLAVOR_MAIN: Record<Flavor, ('mainstream' | 'alternatief' | 'underground' | 'fringe')[]> = {
    mainstream: ['mainstream'],
    alternatief: ['alternatief'],
    niche: ['underground', 'fringe'],
  };
  const FLAVOR_NEIGHBOR: Record<Flavor, ('mainstream' | 'alternatief' | 'underground' | 'fringe')[]> = {
    mainstream: ['alternatief'],
    alternatief: ['mainstream', 'underground'],
    niche: ['alternatief'],
  };

  // Welke venues volgt deze user al? Skip ze uit suggesties — geen
  // dubbele aanbieding.
  const followed = await db
    .select({ venueId: schema.venueFollows.venueId })
    .from(schema.venueFollows)
    .where(eq(schema.venueFollows.userId, me));
  const followedIds = followed.map((r) => r.venueId);

  const columns = {
    id: schema.venues.id,
    slug: schema.venues.slug,
    name: schema.venues.name,
    type: schema.venues.type,
    scene: schema.venues.scene,
    subtype: schema.venues.subtype,
    imageUrl: schema.venues.imageUrl,
    wijk: schema.venues.wijk,
    categories: schema.venues.categories,
  };

  const baseCond = and(
    eq(schema.venues.published, true),
    anyScene,
    followedIds.length > 0
      ? not(inArray(schema.venues.id, followedIds))
      : undefined,
  );

  const selectedRows = await db
    .select(columns)
    .from(schema.venues)
    .where(
      and(
        baseCond,
        inArray(schema.venues.scene, FLAVOR_MAIN[flavor]),
      ),
    )
    .orderBy(schema.venues.name)
    .limit(40);

  // "Maybe" — naburige flavor + ongetagde venues (scene=null) die de
  // category-match wel hebben. Limit 12 zodat de section overzichtelijk
  // blijft.
  const maybeRows = await db
    .select(columns)
    .from(schema.venues)
    .where(
      and(
        baseCond,
        or(
          inArray(schema.venues.scene, FLAVOR_NEIGHBOR[flavor]),
          isNull(schema.venues.scene),
        ),
      ),
    )
    .orderBy(schema.venues.name)
    .limit(12);

  return c.json({ selected: selectedRows, maybe: maybeRows });
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
