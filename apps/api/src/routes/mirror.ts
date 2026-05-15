/**
 * Smaak-spiegel endpoints. Levert geaggregeerde data terug over wat een
 * gebruiker tot dusver heeft gered, gevolgd en weggeswipet — input voor
 * de spiegel-sectie op /jij en (binnenkort) een vriend-zichtbare
 * subset op u/[handle].
 *
 * Geen ML, geen ranking. Pure aggregatie (counts, percentages, tijds-
 * verdeling) over de eigen acties. De UI doet de visualisatie + de
 * identity-zin op basis hiervan.
 *
 * Endpoints:
 *   GET  /mirror/me           — volledige spiegel voor ingelogde user
 *   GET  /mirror/u/:handle    — beperkte spiegel voor vriend-zichtbaar profiel
 *   POST /dismisses           — toggle een dismiss (left-swipe op /op-gevoel)
 */

import { and, eq, or } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import { auth } from '../auth.js';
import { db, schema } from '../db/index.js';

async function requireUserId(c: Context): Promise<string | Response> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  return session.user.id;
}

async function maybeUserId(c: Context): Promise<string | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user.id ?? null;
}

type SaveRow = {
  createdAt: Date;
  source: string | null;
  occurrenceStart: Date | null;
  eventGenres: string[] | null;
  eventCategory: string | null;
  venueId: string;
  venueSlug: string;
  venueName: string;
  venueType: string | null;
  venueWijk: string | null;
  venueDayNight: string | null;
};

async function loadSaveRows(userId: string): Promise<SaveRow[]> {
  return db
    .select({
      createdAt: schema.saves.createdAt,
      source: schema.saves.source,
      occurrenceStart: schema.occurrences.startsAt,
      eventGenres: schema.events.genres,
      eventCategory: schema.events.category,
      venueId: schema.venues.id,
      venueSlug: schema.venues.slug,
      venueName: schema.venues.name,
      venueType: schema.venues.type,
      venueWijk: schema.venues.wijk,
      venueDayNight: schema.venues.dayNight,
    })
    .from(schema.saves)
    .innerJoin(
      schema.occurrences,
      eq(schema.saves.occurrenceId, schema.occurrences.id)
    )
    .innerJoin(schema.events, eq(schema.occurrences.eventId, schema.events.id))
    .innerJoin(schema.venues, eq(schema.events.venueId, schema.venues.id))
    .where(eq(schema.saves.userId, userId));
}

type TopVenue = {
  id: string;
  slug: string;
  name: string;
  type: string | null;
  wijk: string | null;
  count: number;
};

function aggregateTopVenues(rows: SaveRow[], limit: number): TopVenue[] {
  const map = new Map<string, TopVenue>();
  for (const r of rows) {
    const existing = map.get(r.venueId);
    if (existing) {
      existing.count += 1;
    } else {
      map.set(r.venueId, {
        id: r.venueId,
        slug: r.venueSlug,
        name: r.venueName,
        type: r.venueType,
        wijk: r.venueWijk,
        count: 1,
      });
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

function aggregateTopGenres(
  rows: SaveRow[],
  limit: number
): { genre: string; count: number }[] {
  const map = new Map<string, number>();
  for (const r of rows) {
    for (const g of r.eventGenres ?? []) {
      const key = g.trim().toLowerCase();
      if (!key) continue;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([genre, count]) => ({ genre, count }));
}

function aggregateBy<T>(rows: SaveRow[], key: (r: SaveRow) => T | null): {
  key: T;
  count: number;
}[] {
  const map = new Map<T, number>();
  for (const r of rows) {
    const k = key(r);
    if (k === null) continue;
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, count]) => ({ key: k, count }));
}

function buildMonthlyTimeline(rows: SaveRow[]): { ym: string; count: number }[] {
  const map = new Map<string, number>();
  for (const r of rows) {
    const d = r.createdAt;
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    map.set(ym, (map.get(ym) ?? 0) + 1);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ym, count]) => ({ ym, count }));
}

function buildWeekdayHistogram(
  rows: SaveRow[]
): { weekday: number; count: number }[] {
  // 0 = zondag t/m 6 = zaterdag, op basis van occurrence-tijd (wanneer
  // het event plaatsvindt) niet save-tijd (wanneer iemand klikte).
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const r of rows) {
    const d = r.occurrenceStart ?? r.createdAt;
    counts[d.getDay()] += 1;
  }
  return counts.map((count, weekday) => ({ weekday, count }));
}

function buildFullMirror(rows: SaveRow[], followedVenueIds: Set<string>) {
  const topVenues = aggregateTopVenues(rows, 5).map((v) => ({
    ...v,
    isFollowed: followedVenueIds.has(v.id),
  }));
  const topGenres = aggregateTopGenres(rows, 5);
  const wijken = aggregateBy(rows, (r) => r.venueWijk).map((row) => ({
    wijk: row.key,
    count: row.count,
  }));
  const venueTypes = aggregateBy(rows, (r) => r.venueType).map((row) => ({
    type: row.key,
    count: row.count,
  }));
  const categories = aggregateBy(rows, (r) => r.eventCategory).map((row) => ({
    category: row.key,
    count: row.count,
  }));
  const discovery = aggregateBy(rows, (r) => r.source).map((row) => ({
    source: row.key,
    count: row.count,
  }));
  const monthlyTimeline = buildMonthlyTimeline(rows);
  const weekday = buildWeekdayHistogram(rows);
  return {
    totals: {
      saves: rows.length,
      venuesFollowed: followedVenueIds.size,
    },
    topVenues,
    topGenres,
    wijken,
    venueTypes,
    categories,
    discovery,
    monthlyTimeline,
    weekday,
  };
}

export const mirrorRoute = new Hono();

mirrorRoute.get('/me', async (c) => {
  const userId = await requireUserId(c);
  if (typeof userId !== 'string') return userId;

  const [rows, follows] = await Promise.all([
    loadSaveRows(userId),
    db
      .select({ venueId: schema.venueFollows.venueId })
      .from(schema.venueFollows)
      .where(
        and(
          eq(schema.venueFollows.userId, userId),
          eq(schema.venueFollows.state, 'volgen')
        )
      ),
  ]);
  const followedVenueIds = new Set(follows.map((f) => f.venueId));

  return c.json(buildFullMirror(rows, followedVenueIds));
});

mirrorRoute.get('/u/:handle', async (c) => {
  const me = await maybeUserId(c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);

  const rawHandle = c.req.param('handle');
  const handle = rawHandle.toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (!handle) return c.json({ error: 'handle ongeldig' }, 400);

  const [target] = await db
    .select({
      id: schema.users.id,
      mirrorVisibility: schema.users.mirrorVisibility,
    })
    .from(schema.users)
    .where(eq(schema.users.handle, handle))
    .limit(1);
  if (!target) return c.json({ error: 'gebruiker niet gevonden' }, 404);

  // Eigen profiel altijd zichtbaar. Anders gate op visibility-keuze.
  if (target.id !== me) {
    if (target.mirrorVisibility === 'private') {
      return c.json({ error: 'profielinzicht niet gedeeld' }, 403);
    }
    const [friendship] = await db
      .select({ status: schema.friendships.status })
      .from(schema.friendships)
      .where(
        and(
          eq(schema.friendships.status, 'accepted'),
          or(
            and(
              eq(schema.friendships.fromUserId, me),
              eq(schema.friendships.toUserId, target.id)
            ),
            and(
              eq(schema.friendships.fromUserId, target.id),
              eq(schema.friendships.toUserId, me)
            )
          )
        )
      )
      .limit(1);
    if (!friendship) return c.json({ error: 'geen vriend' }, 403);

    // 'favorites' vereist dat de target mij in friend_favorites heeft.
    if (target.mirrorVisibility === 'favorites') {
      const [fav] = await db
        .select({ userId: schema.friendFavorites.userId })
        .from(schema.friendFavorites)
        .where(
          and(
            eq(schema.friendFavorites.userId, target.id),
            eq(schema.friendFavorites.friendId, me)
          )
        )
        .limit(1);
      if (!fav) return c.json({ error: 'profielinzicht niet gedeeld' }, 403);
    }
  }

  const rows = await loadSaveRows(target.id);
  // Publieke subset: namen-only, geen counts, geen timeline.
  return c.json({
    topVenues: aggregateTopVenues(rows, 3).map((v) => ({
      id: v.id,
      slug: v.slug,
      name: v.name,
    })),
    topGenres: aggregateTopGenres(rows, 3).map((g) => ({ genre: g.genre })),
  });
});

export const dismissesRoute = new Hono();

/**
 * Toggle een dismiss voor een occurrence. Idempotent als saves: bestond
 * de dismiss al? Dan verwijder 'm (un-dismiss). Anders insert.
 *
 * Een dismiss zorgt dat de occurrence niet opnieuw verschijnt op
 * `/op-gevoel` in latere sessies, en is input voor het smaak-profiel
 * (welke patronen wijst de gebruiker af).
 *
 * Body: `{ occurrenceId, source? }`. Source default 'op-gevoel' want dat
 * is het enige scherm met een dismiss-gebaar in v1.
 */
dismissesRoute.post('/', async (c) => {
  const userId = await requireUserId(c);
  if (typeof userId !== 'string') return userId;

  const body = (await c.req.json()) as { occurrenceId?: string };
  const occurrenceId = body.occurrenceId;
  if (!occurrenceId) {
    return c.json({ error: 'occurrenceId is verplicht' }, 400);
  }

  const existing = await db
    .select()
    .from(schema.dismisses)
    .where(
      and(
        eq(schema.dismisses.userId, userId),
        eq(schema.dismisses.occurrenceId, occurrenceId)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    await db
      .delete(schema.dismisses)
      .where(
        and(
          eq(schema.dismisses.userId, userId),
          eq(schema.dismisses.occurrenceId, occurrenceId)
        )
      );
    return c.json({ dismissed: false });
  }

  // Verifieer dat de occurrence bestaat zodat we geen dangling rows
  // creëren (FK is cascade-delete, maar belast onnodig de DB).
  const [occ] = await db
    .select({ id: schema.occurrences.id })
    .from(schema.occurrences)
    .where(eq(schema.occurrences.id, occurrenceId))
    .limit(1);
  if (!occ) return c.json({ error: 'occurrence niet gevonden' }, 404);

  await db.insert(schema.dismisses).values({ userId, occurrenceId });
  return c.json({ dismissed: true });
});

/**
 * GET — alle dismisses voor de ingelogde user. Levert alleen de IDs op,
 * voldoende voor /op-gevoel om ze te filteren.
 */
dismissesRoute.get('/', async (c) => {
  const userId = await requireUserId(c);
  if (typeof userId !== 'string') return userId;

  const rows = await db
    .select({ occurrenceId: schema.dismisses.occurrenceId })
    .from(schema.dismisses)
    .where(eq(schema.dismisses.userId, userId));

  return c.json({ occurrenceIds: rows.map((r) => r.occurrenceId) });
});
