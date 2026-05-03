import { and, asc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import type { Context } from 'hono';

import { auth } from '../auth.js';
import { db, schema } from '../db/index.js';

export async function maybeUserId(c: Context): Promise<string | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user.id ?? null;
}

const FRIEND_PILL_LIMIT = 3;

export type FriendBadge = {
  id: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
};

/**
 * Voor een gegeven set event-IDs: welke van mijn vrienden hebben elk event
 * opgeslagen? Limiet per event = FRIEND_PILL_LIMIT, in naam-volgorde, plus
 * een totaal-tellertje. Privacy-gate: vrienden met `savesVisibility='private'`
 * worden niet meegerekend.
 */
export async function buildFriendsByEvent(
  meId: string,
  eventIds: string[]
): Promise<Map<string, { friends: FriendBadge[]; count: number }>> {
  const map = new Map<string, { friends: FriendBadge[]; count: number }>();
  if (eventIds.length === 0) return map;

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
        inArray(schema.saves.eventId, eventIds),
        eq(schema.users.savesVisibility, 'friends')
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
  for (const entry of map.values()) {
    entry.friends.sort((a, b) => a.name.localeCompare(b.name));
  }
  return map;
}

export type SeriesBadge = {
  id: string;
  slug: string;
  name: string;
  imageUrl: string | null;
};

/**
 * Voor een gegeven set event-IDs: welke (nog lopende) series horen bij
 * elk event? Eén event kan in meerdere series zitten (M:N). Volgorde:
 * alfabetisch op naam zodat de UI deterministisch de eerste kan tonen.
 *
 * Filtert op `series.endsAt`: afgelopen series (endsAt < now) verdwijnen
 * automatisch uit pills/tags zodat een Paradiso-event in oktober niet
 * blijft hangen met "Onderdeel van ADE 2024". Series zonder `endsAt`
 * gelden als doorlopend en blijven zichtbaar.
 */
export async function buildSeriesByEvent(
  eventIds: string[]
): Promise<Map<string, SeriesBadge[]>> {
  const map = new Map<string, SeriesBadge[]>();
  if (eventIds.length === 0) return map;

  const stillActive = or(
    isNull(schema.series.endsAt),
    gt(schema.series.endsAt, new Date())
  )!;
  const published = eq(schema.series.published, true);

  const rows = await db
    .select({
      eventId: schema.eventsInSeries.eventId,
      id: schema.series.id,
      slug: schema.series.slug,
      name: schema.series.name,
      imageUrl: schema.series.imageUrl,
    })
    .from(schema.eventsInSeries)
    .innerJoin(
      schema.series,
      eq(schema.series.id, schema.eventsInSeries.seriesId)
    )
    .where(
      and(
        inArray(schema.eventsInSeries.eventId, eventIds),
        stillActive,
        published
      )
    )
    .orderBy(asc(schema.series.name));

  for (const r of rows) {
    const list = map.get(r.eventId) ?? [];
    list.push({
      id: r.id,
      slug: r.slug,
      name: r.name,
      imageUrl: r.imageUrl,
    });
    map.set(r.eventId, list);
  }
  return map;
}
