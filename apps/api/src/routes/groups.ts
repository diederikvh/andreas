import { randomUUID } from 'node:crypto';

import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import { auth } from '../auth.js';
import { db, schema } from '../db/index.js';
import { sendPushToUsers } from '../push.js';

async function requireUserId(c: Context): Promise<string | Response> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  return session.user.id;
}

/**
 * Geeft de actieve leden van een groep (incl. de creator) met basisprofiel.
 * `leftAt IS NULL` filtert vertrokken leden weg. Sortering: creator eerst,
 * daarna alfabetisch op naam zodat de UI een stabiele lijst krijgt.
 */
async function fetchActiveMembers(groupId: string) {
  return db
    .select({
      id: schema.users.id,
      name: schema.users.name,
      handle: schema.users.handle,
      avatarUrl: schema.users.avatarUrl,
      joinedAt: schema.groupMembers.joinedAt,
      mutedAt: schema.groupMembers.mutedAt,
    })
    .from(schema.groupMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.groupMembers.userId))
    .where(
      and(
        eq(schema.groupMembers.groupId, groupId),
        isNull(schema.groupMembers.leftAt)
      )
    )
    .orderBy(asc(schema.users.name));
}

/** Filter inkomende user-ids op accepted-friends van `me`. */
async function filterAcceptedFriends(me: string, ids: string[]): Promise<Set<string>> {
  const cleaned = Array.from(new Set(ids.filter((id) => id && id !== me)));
  if (cleaned.length === 0) return new Set();
  const rows = await db
    .select({
      fromUserId: schema.friendships.fromUserId,
      toUserId: schema.friendships.toUserId,
    })
    .from(schema.friendships)
    .where(
      and(
        eq(schema.friendships.status, 'accepted'),
        or(
          and(
            eq(schema.friendships.fromUserId, me),
            inArray(schema.friendships.toUserId, cleaned)
          ),
          and(
            eq(schema.friendships.toUserId, me),
            inArray(schema.friendships.fromUserId, cleaned)
          )
        )
      )
    );
  return new Set(rows.map((r) => (r.fromUserId === me ? r.toUserId : r.fromUserId)));
}

export const groupsRoute = new Hono();

/**
 * Mijn groepen — groepen waar ik een actief lidmaatschap in heb.
 * Inclusief actieve members (max ~50 verwacht per groep) zodat de
 * Groepen-tab in één call kan renderen zonder per-groep follow-up.
 */
groupsRoute.get('/', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  const myGroups = await db
    .select({
      id: schema.groups.id,
      name: schema.groups.name,
      creatorId: schema.groups.creatorId,
      createdAt: schema.groups.createdAt,
      mutedAt: schema.groupMembers.mutedAt,
    })
    .from(schema.groupMembers)
    .innerJoin(schema.groups, eq(schema.groups.id, schema.groupMembers.groupId))
    .where(
      and(
        eq(schema.groupMembers.userId, me),
        isNull(schema.groupMembers.leftAt)
      )
    )
    .orderBy(asc(schema.groups.name));

  if (myGroups.length === 0) return c.json({ groups: [] });

  const groupIds = myGroups.map((g) => g.id);
  const allMembers = await db
    .select({
      groupId: schema.groupMembers.groupId,
      id: schema.users.id,
      name: schema.users.name,
      handle: schema.users.handle,
      avatarUrl: schema.users.avatarUrl,
    })
    .from(schema.groupMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.groupMembers.userId))
    .where(
      and(
        inArray(schema.groupMembers.groupId, groupIds),
        isNull(schema.groupMembers.leftAt)
      )
    );

  const byGroup = new Map<string, typeof allMembers>();
  for (const m of allMembers) {
    const list = byGroup.get(m.groupId);
    if (list) list.push(m);
    else byGroup.set(m.groupId, [m]);
  }

  return c.json({
    groups: myGroups.map((g) => ({
      ...g,
      isCreator: g.creatorId === me,
      muted: g.mutedAt !== null,
      members: (byGroup.get(g.id) ?? []).map(({ groupId: _g, ...rest }) => rest),
    })),
  });
});

/**
 * Maak een nieuwe groep. Body: { name, memberIds }. Initiator wordt
 * creator én eerste lid. `memberIds` moeten accepted-friends zijn (anders
 * worden ze gefilterd, niet geweigerd — partial succes voorkomt
 * verwarrend gedrag waar één onbekende id de hele call faalt).
 */
groupsRoute.post('/', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  const body = (await c.req.json()) as { name?: string; memberIds?: string[] };
  const name = (body.name ?? '').trim().slice(0, 80);
  if (!name) return c.json({ error: 'name is verplicht' }, 400);
  const memberIds = Array.isArray(body.memberIds) ? body.memberIds : [];

  const friends = await filterAcceptedFriends(me, memberIds);

  const groupId = randomUUID();
  await db.insert(schema.groups).values({ id: groupId, name, creatorId: me });
  await db.insert(schema.groupMembers).values([
    { groupId, userId: me },
    ...Array.from(friends).map((userId) => ({ groupId, userId })),
  ]);

  return c.json({ id: groupId, name, memberCount: friends.size + 1 }, 201);
});

/**
 * Detail van een groep. Alleen actieve leden mogen lezen (privacy:
 * niet-leden weten niet eens dat de groep bestaat).
 */
groupsRoute.get('/:id', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;
  const id = c.req.param('id');

  const [membership] = await db
    .select({
      groupId: schema.groupMembers.groupId,
      mutedAt: schema.groupMembers.mutedAt,
    })
    .from(schema.groupMembers)
    .where(
      and(
        eq(schema.groupMembers.groupId, id),
        eq(schema.groupMembers.userId, me),
        isNull(schema.groupMembers.leftAt)
      )
    )
    .limit(1);
  if (!membership) return c.json({ error: 'not found' }, 404);

  const [group] = await db
    .select()
    .from(schema.groups)
    .where(eq(schema.groups.id, id))
    .limit(1);
  if (!group) return c.json({ error: 'not found' }, 404);

  const members = await fetchActiveMembers(id);
  return c.json({
    id: group.id,
    name: group.name,
    creatorId: group.creatorId,
    isCreator: group.creatorId === me,
    muted: membership.mutedAt !== null,
    members,
  });
});

/**
 * Rename — alleen creator.
 */
groupsRoute.patch('/:id', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;
  const id = c.req.param('id');
  const body = (await c.req.json()) as { name?: string };
  const name = (body.name ?? '').trim().slice(0, 80);
  if (!name) return c.json({ error: 'name is verplicht' }, 400);

  const [group] = await db
    .select({ creatorId: schema.groups.creatorId })
    .from(schema.groups)
    .where(eq(schema.groups.id, id))
    .limit(1);
  if (!group) return c.json({ error: 'not found' }, 404);
  if (group.creatorId !== me) return c.json({ error: 'forbidden' }, 403);

  await db.update(schema.groups).set({ name }).where(eq(schema.groups.id, id));
  return c.json({ ok: true });
});

/**
 * Groep verwijderen — alleen creator. Cascade verwijdert automatisch
 * group_members en invitations (zie schema-FKs). Andere actieve leden
 * krijgen een push "X heeft de groep opgeheven" zodat ze niet later
 * met een dode link blijven zitten.
 */
groupsRoute.delete('/:id', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;
  const id = c.req.param('id');

  const [group] = await db
    .select({ creatorId: schema.groups.creatorId, name: schema.groups.name })
    .from(schema.groups)
    .where(eq(schema.groups.id, id))
    .limit(1);
  if (!group) return c.json({ error: 'not found' }, 404);
  if (group.creatorId !== me) return c.json({ error: 'forbidden' }, 403);

  // Verzamel andere actieve leden vóór de delete — anders kunnen we
  // ze daarna niet meer pushen.
  const others = await db
    .select({ userId: schema.groupMembers.userId })
    .from(schema.groupMembers)
    .where(
      and(
        eq(schema.groupMembers.groupId, id),
        isNull(schema.groupMembers.leftAt)
      )
    );
  const otherIds = others.map((o) => o.userId).filter((u) => u !== me);

  await db.delete(schema.groups).where(eq(schema.groups.id, id));

  if (otherIds.length > 0) {
    try {
      const [meUser] = await db
        .select({ name: schema.users.name, handle: schema.users.handle })
        .from(schema.users)
        .where(eq(schema.users.id, me))
        .limit(1);
      const display =
        meUser?.name?.trim() ||
        (meUser?.handle ? `@${meUser.handle}` : 'Iemand');
      await sendPushToUsers(otherIds, {
        title: group.name,
        body: `${display} heeft de groep opgeheven`,
        data: { url: '/(tabs)/social' },
      });
    } catch (err) {
      console.error('[groups] delete push failed', err);
    }
  }

  return c.json({ ok: true });
});

/**
 * Voeg leden toe — alleen creator (per beslissing 1). Nieuwe leden
 * moeten accepted-friends van de creator zijn. Bestaande actieve leden
 * worden stil overgeslagen (idempotent). Eerder vertrokken leden worden
 * teruggezet door `leftAt` op NULL te zetten.
 */
groupsRoute.post('/:id/members', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;
  const id = c.req.param('id');
  const body = (await c.req.json()) as { userIds?: string[] };
  const requested = Array.isArray(body.userIds) ? body.userIds : [];

  const [group] = await db
    .select({ creatorId: schema.groups.creatorId, name: schema.groups.name })
    .from(schema.groups)
    .where(eq(schema.groups.id, id))
    .limit(1);
  if (!group) return c.json({ error: 'not found' }, 404);
  if (group.creatorId !== me) return c.json({ error: 'forbidden' }, 403);

  const friends = await filterAcceptedFriends(me, requested);
  if (friends.size === 0) return c.json({ added: 0 });

  // Splits in "nooit lid geweest" en "rejoinen". leftAt-membership houden
  // we niet als "actief", maar de PK conflicteert wel — dus rejoin = update.
  const existing = await db
    .select({ userId: schema.groupMembers.userId, leftAt: schema.groupMembers.leftAt })
    .from(schema.groupMembers)
    .where(
      and(
        eq(schema.groupMembers.groupId, id),
        inArray(schema.groupMembers.userId, Array.from(friends))
      )
    );
  const existingMap = new Map(existing.map((e) => [e.userId, e.leftAt]));

  const fresh: string[] = [];
  const rejoin: string[] = [];
  for (const uid of friends) {
    const leftAt = existingMap.get(uid);
    if (leftAt === undefined) fresh.push(uid);
    else if (leftAt !== null) rejoin.push(uid);
    // actieve members (leftAt === null) → skip
  }

  if (fresh.length > 0) {
    await db.insert(schema.groupMembers).values(
      fresh.map((userId) => ({ groupId: id, userId }))
    );
  }
  if (rejoin.length > 0) {
    await db
      .update(schema.groupMembers)
      .set({ leftAt: null, joinedAt: new Date() })
      .where(
        and(
          eq(schema.groupMembers.groupId, id),
          inArray(schema.groupMembers.userId, rejoin)
        )
      );
  }

  return c.json({ added: fresh.length + rejoin.length });
});

/**
 * Lid verwijderen — self-leave of door creator (kick).
 * Andere leden krijgen een push ("X heeft de groep verlaten").
 */
groupsRoute.delete('/:id/members/:userId', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;
  const id = c.req.param('id');
  const targetUserId = c.req.param('userId');

  const [group] = await db
    .select({ creatorId: schema.groups.creatorId, name: schema.groups.name })
    .from(schema.groups)
    .where(eq(schema.groups.id, id))
    .limit(1);
  if (!group) return c.json({ error: 'not found' }, 404);

  const isSelf = targetUserId === me;
  const isCreator = group.creatorId === me;
  if (!isSelf && !isCreator) return c.json({ error: 'forbidden' }, 403);
  // Creator mag zichzelf wel verwijderen, maar de groep moet niet
  // creator-loos achterblijven — eerste optie is "verlaten = groep weg"
  // maar dat is destructief en zit niet in de spec. Voor v1: weiger
  // self-leave als je creator bent én er nog andere leden zijn.
  if (isSelf && isCreator) {
    const remaining = await db
      .select({ userId: schema.groupMembers.userId })
      .from(schema.groupMembers)
      .where(
        and(
          eq(schema.groupMembers.groupId, id),
          isNull(schema.groupMembers.leftAt)
        )
      );
    if (remaining.length > 1) {
      return c.json(
        {
          error:
            'Je bent de creator van deze groep. Verwijder eerst de andere leden, of wijs een nieuwe creator aan (nog niet ondersteund).',
        },
        409
      );
    }
  }

  await db
    .update(schema.groupMembers)
    .set({ leftAt: new Date() })
    .where(
      and(
        eq(schema.groupMembers.groupId, id),
        eq(schema.groupMembers.userId, targetUserId),
        isNull(schema.groupMembers.leftAt)
      )
    );

  // Push naar overige actieve leden — alleen voor self-leave (spec).
  // Bij kick door creator: ook stilzwijgend, geen aparte melding. We
  // sturen alleen wanneer iemand zichzelf weghaalt.
  if (isSelf) {
    try {
      const others = await db
        .select({ userId: schema.groupMembers.userId })
        .from(schema.groupMembers)
        .where(
          and(
            eq(schema.groupMembers.groupId, id),
            isNull(schema.groupMembers.leftAt)
          )
        );
      const [meUser] = await db
        .select({ name: schema.users.name, handle: schema.users.handle })
        .from(schema.users)
        .where(eq(schema.users.id, me))
        .limit(1);
      const display =
        meUser?.name?.trim() ||
        (meUser?.handle ? `@${meUser.handle}` : 'Iemand');
      await sendPushToUsers(
        others.map((o) => o.userId),
        {
          title: group.name,
          body: `${display} heeft de groep verlaten`,
          data: { url: `/group/${id}` },
        }
      );
    } catch (err) {
      console.error('[groups] leave push failed', err);
    }
  }

  return c.json({ ok: true });
});

/**
 * Mute / unmute — per-user notificaties van deze groep uit/aan zonder
 * eruit te stappen. Andere leden zien hier niets van.
 */
groupsRoute.post('/:id/mute', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;
  const id = c.req.param('id');
  await db
    .update(schema.groupMembers)
    .set({ mutedAt: new Date() })
    .where(
      and(
        eq(schema.groupMembers.groupId, id),
        eq(schema.groupMembers.userId, me),
        isNull(schema.groupMembers.leftAt)
      )
    );
  return c.json({ ok: true, muted: true });
});

groupsRoute.delete('/:id/mute', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;
  const id = c.req.param('id');
  await db
    .update(schema.groupMembers)
    .set({ mutedAt: null })
    .where(
      and(
        eq(schema.groupMembers.groupId, id),
        eq(schema.groupMembers.userId, me),
        isNull(schema.groupMembers.leftAt)
      )
    );
  return c.json({ ok: true, muted: false });
});
