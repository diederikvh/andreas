import { and, asc, desc, eq, ilike, inArray, isNotNull, ne, or } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import { auth } from '../auth.js';
import { db, schema } from '../db/index.js';
import { buildOccurrencesByEvent } from './_helpers.js';

async function requireUserId(c: Context): Promise<string | Response> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  return session.user.id;
}

export const friendsRoute = new Hono();

/**
 * Public profile-fields voor friend-views. Phone/email blijven achter.
 */
const publicUserCols = {
  id: schema.users.id,
  name: schema.users.name,
  handle: schema.users.handle,
  avatarUrl: schema.users.avatarUrl,
};

friendsRoute.get('/', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  // Beide richtingen: ik ben de from-kant of de to-kant van een
  // accepted friendship. We projecteren de "andere" user.
  const outgoing = await db
    .select({
      id: publicUserCols.id,
      name: publicUserCols.name,
      handle: publicUserCols.handle,
      avatarUrl: publicUserCols.avatarUrl,
      since: schema.friendships.createdAt,
    })
    .from(schema.friendships)
    .innerJoin(
      schema.users,
      eq(schema.users.id, schema.friendships.toUserId)
    )
    .where(
      and(
        eq(schema.friendships.fromUserId, me),
        eq(schema.friendships.status, 'accepted')
      )
    );

  const incoming = await db
    .select({
      id: publicUserCols.id,
      name: publicUserCols.name,
      handle: publicUserCols.handle,
      avatarUrl: publicUserCols.avatarUrl,
      since: schema.friendships.createdAt,
    })
    .from(schema.friendships)
    .innerJoin(
      schema.users,
      eq(schema.users.id, schema.friendships.fromUserId)
    )
    .where(
      and(
        eq(schema.friendships.toUserId, me),
        eq(schema.friendships.status, 'accepted')
      )
    );

  // Combineer — geen duplicates omdat we maar één row per friendship
  // gebruiken (de from-kant is de aanvrager).
  const friends = [...outgoing, ...incoming].sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  return c.json({ friends });
});

friendsRoute.get('/outgoing', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  const outgoing = await db
    .select({
      id: publicUserCols.id,
      name: publicUserCols.name,
      handle: publicUserCols.handle,
      avatarUrl: publicUserCols.avatarUrl,
      requestedAt: schema.friendships.createdAt,
    })
    .from(schema.friendships)
    .innerJoin(
      schema.users,
      eq(schema.users.id, schema.friendships.toUserId)
    )
    .where(
      and(
        eq(schema.friendships.fromUserId, me),
        eq(schema.friendships.status, 'pending')
      )
    )
    .orderBy(desc(schema.friendships.createdAt));

  return c.json({ outgoing });
});

friendsRoute.get('/requests', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  const requests = await db
    .select({
      id: publicUserCols.id,
      name: publicUserCols.name,
      handle: publicUserCols.handle,
      avatarUrl: publicUserCols.avatarUrl,
      requestedAt: schema.friendships.createdAt,
    })
    .from(schema.friendships)
    .innerJoin(
      schema.users,
      eq(schema.users.id, schema.friendships.fromUserId)
    )
    .where(
      and(
        eq(schema.friendships.toUserId, me),
        eq(schema.friendships.status, 'pending')
      )
    )
    .orderBy(desc(schema.friendships.createdAt));

  return c.json({ requests });
});

friendsRoute.post('/request', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  const body = (await c.req.json()) as { handle?: string };
  const handle = (body.handle ?? '').trim().toLowerCase();
  if (!handle) return c.json({ error: 'handle is verplicht' }, 400);

  const [target] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.handle, handle))
    .limit(1);
  if (!target) return c.json({ error: 'Deze handle bestaat niet.' }, 404);
  if (target.id === me) {
    return c.json({ error: 'Jezelf toevoegen kan niet.' }, 400);
  }

  // Bestaat de andere kant al pending? Dan accepten en klaar.
  const [reverse] = await db
    .select()
    .from(schema.friendships)
    .where(
      and(
        eq(schema.friendships.fromUserId, target.id),
        eq(schema.friendships.toUserId, me)
      )
    )
    .limit(1);
  if (reverse) {
    if (reverse.status !== 'accepted') {
      await db
        .update(schema.friendships)
        .set({ status: 'accepted' })
        .where(
          and(
            eq(schema.friendships.fromUserId, target.id),
            eq(schema.friendships.toUserId, me)
          )
        );
    }
    return c.json({ status: 'accepted' });
  }

  // Bestaat onze richting al? Dan idempotent terug.
  const [existing] = await db
    .select()
    .from(schema.friendships)
    .where(
      and(
        eq(schema.friendships.fromUserId, me),
        eq(schema.friendships.toUserId, target.id)
      )
    )
    .limit(1);
  if (existing) {
    return c.json({ status: existing.status });
  }

  await db.insert(schema.friendships).values({
    fromUserId: me,
    toUserId: target.id,
    status: 'pending',
  });
  return c.json({ status: 'pending' });
});

friendsRoute.post('/accept', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  const body = (await c.req.json()) as { fromUserId?: string };
  const fromUserId = body.fromUserId;
  if (!fromUserId) {
    return c.json({ error: 'fromUserId is verplicht' }, 400);
  }

  const [row] = await db
    .select()
    .from(schema.friendships)
    .where(
      and(
        eq(schema.friendships.fromUserId, fromUserId),
        eq(schema.friendships.toUserId, me),
        eq(schema.friendships.status, 'pending')
      )
    )
    .limit(1);
  if (!row) {
    return c.json({ error: 'Geen openstaand verzoek.' }, 404);
  }

  await db
    .update(schema.friendships)
    .set({ status: 'accepted' })
    .where(
      and(
        eq(schema.friendships.fromUserId, fromUserId),
        eq(schema.friendships.toUserId, me)
      )
    );
  return c.json({ status: 'accepted' });
});

friendsRoute.post('/decline', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  const body = (await c.req.json()) as { fromUserId?: string };
  const fromUserId = body.fromUserId;
  if (!fromUserId) {
    return c.json({ error: 'fromUserId is verplicht' }, 400);
  }

  await db
    .delete(schema.friendships)
    .where(
      and(
        eq(schema.friendships.fromUserId, fromUserId),
        eq(schema.friendships.toUserId, me),
        eq(schema.friendships.status, 'pending')
      )
    );
  return c.json({ ok: true });
});

friendsRoute.get('/:id', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  const friendId = c.req.param('id');
  if (friendId === me) {
    return c.json({ error: 'Niet je eigen profiel via deze route.' }, 400);
  }

  // TODO (privacy): later checken op users.privacy / per-friendship
  // visibility-flag voordat we hun saves teruggeven.
  const [friendship] = await db
    .select()
    .from(schema.friendships)
    .where(
      and(
        eq(schema.friendships.status, 'accepted'),
        or(
          and(
            eq(schema.friendships.fromUserId, me),
            eq(schema.friendships.toUserId, friendId)
          ),
          and(
            eq(schema.friendships.fromUserId, friendId),
            eq(schema.friendships.toUserId, me)
          )
        )
      )
    )
    .limit(1);
  if (!friendship) {
    return c.json({ error: 'Niet bevriend.' }, 403);
  }

  const [user] = await db
    .select({
      ...publicUserCols,
      savesVisibility: schema.users.savesVisibility,
    })
    .from(schema.users)
    .where(eq(schema.users.id, friendId))
    .limit(1);
  if (!user) return c.json({ error: 'user not found' }, 404);

  // Privacy-gate: als de friend z'n saves prive heeft staan, retourneren
  // we een leeg events-lijstje. We tonen wel het profiel zelf — zo weet
  // ik nog dat we vrienden zijn, alleen geen activiteiten.
  const isPrivate = user.savesVisibility === 'private';
  let events: Array<Record<string, unknown>> = [];
  if (!isPrivate) {
    const rows = await db
      .select({
        id: schema.events.id,
        title: schema.events.title,
        description: schema.events.description,
        kind: schema.events.kind,
        imageUrl: schema.events.imageUrl,
        category: schema.events.category,
        featured: schema.events.featured,
        savedAt: schema.saves.createdAt,
        venue: {
          id: schema.venues.id,
          slug: schema.venues.slug,
          name: schema.venues.name,
          address: schema.venues.address,
          lat: schema.venues.lat,
          lng: schema.venues.lng,
          priceNote: schema.venues.priceNote,
        },
      })
      .from(schema.saves)
      .innerJoin(schema.events, eq(schema.events.id, schema.saves.eventId))
      .innerJoin(schema.venues, eq(schema.venues.id, schema.events.venueId))
      .where(
        and(
          eq(schema.saves.userId, friendId),
          eq(schema.events.published, true),
          eq(schema.venues.published, true)
        )
      );

    const occMap = await buildOccurrencesByEvent(rows.map((r) => r.id), {
      includePast: true,
    });
    events = rows
      .map((r) => {
        const occ = occMap.get(r.id);
        return {
          ...r,
          startsAt: occ?.next?.startsAt ?? null,
          endsAt: occ?.next?.endsAt ?? null,
          priceCents: occ?.next?.priceCents ?? null,
          priceNote: occ?.next?.priceNote ?? null,
          ticketUrl: occ?.next?.ticketUrl ?? null,
          occurrenceCount: occ?.count ?? 0,
        };
      })
      .sort((a, b) => {
        const aT = (a.startsAt as Date | null)?.getTime() ?? Infinity;
        const bT = (b.startsAt as Date | null)?.getTime() ?? Infinity;
        return aT - bT;
      });
  }

  // savesVisibility hoeft niet naar de client — gebruikt om events leeg
  // te laten en niets meer.
  const { savesVisibility: _omit, ...publicUser } = user;
  return c.json({
    user: publicUser,
    events,
    savesPrivate: isPrivate,
  });
});

friendsRoute.delete('/:userId', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  const userId = c.req.param('userId');
  // Verwijder elke friendship tussen mij en deze user, in beide richtingen.
  await db
    .delete(schema.friendships)
    .where(
      or(
        and(
          eq(schema.friendships.fromUserId, me),
          eq(schema.friendships.toUserId, userId)
        ),
        and(
          eq(schema.friendships.fromUserId, userId),
          eq(schema.friendships.toUserId, me)
        )
      )
    );
  return c.json({ ok: true });
});

// Aparte voor user-search; op handle prefix-match. Geeft ook de
// huidige relatie-status terug zodat de UI per resultaat de juiste
// actie kan tonen.
export const usersRoute = new Hono();

usersRoute.get('/search', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  const q = (c.req.query('q') ?? '').trim().toLowerCase();
  if (q.length < 2) return c.json({ users: [] });

  // Privacy-gate: alleen users met `discoverable = true` verschijnen
  // in zoekresultaten. Bestaande vrienden blijven via /friends bereik-
  // baar; mensen die jou een verzoek hebben gestuurd staan in
  // /friends/requests.
  const rows = await db
    .select({
      id: publicUserCols.id,
      name: publicUserCols.name,
      handle: publicUserCols.handle,
      avatarUrl: publicUserCols.avatarUrl,
    })
    .from(schema.users)
    .where(
      and(
        ne(schema.users.id, me),
        isNotNull(schema.users.handle),
        ilike(schema.users.handle, `${q}%`),
        eq(schema.users.discoverable, true)
      )
    )
    .limit(20);

  // Voor elke gevonden user: relatie-status met mij.
  const ids = rows.map((r) => r.id);
  const relations = ids.length
    ? await db
        .select()
        .from(schema.friendships)
        .where(
          or(
            and(
              eq(schema.friendships.fromUserId, me),
              inArray(schema.friendships.toUserId, ids)
            ),
            and(
              eq(schema.friendships.toUserId, me),
              inArray(schema.friendships.fromUserId, ids)
            )
          )
        )
    : [];

  const relMap = new Map<string, 'accepted' | 'incoming' | 'outgoing'>();
  for (const rel of relations) {
    if (rel.status === 'accepted') {
      const other = rel.fromUserId === me ? rel.toUserId : rel.fromUserId;
      relMap.set(other, 'accepted');
    } else if (rel.fromUserId === me) {
      relMap.set(rel.toUserId, 'outgoing');
    } else {
      relMap.set(rel.fromUserId, 'incoming');
    }
  }

  return c.json({
    users: rows.map((r) => ({
      ...r,
      relation: relMap.get(r.id) ?? null,
    })),
  });
});
