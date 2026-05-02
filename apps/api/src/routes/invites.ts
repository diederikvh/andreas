import { randomUUID } from 'node:crypto';

import { and, asc, eq, inArray, or } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import { auth } from '../auth.js';
import { db, schema } from '../db/index.js';

async function requireUserId(c: Context): Promise<string | Response> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  return session.user.id;
}

export const invitesRoute = new Hono();

/**
 * Mijn ontvangen uitnodigingen — alleen pending, met inviter-profiel
 * en event/venue zodat de UI direct kan renderen.
 */
invitesRoute.get('/', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  const rows = await db
    .select({
      id: schema.invites.id,
      message: schema.invites.message,
      createdAt: schema.invites.createdAt,
      from: {
        id: schema.users.id,
        name: schema.users.name,
        handle: schema.users.handle,
        avatarUrl: schema.users.avatarUrl,
      },
      event: {
        id: schema.events.id,
        title: schema.events.title,
        startsAt: schema.events.startsAt,
        category: schema.events.category,
        imageUrl: schema.events.imageUrl,
        venueId: schema.venues.id,
        venueSlug: schema.venues.slug,
        venueName: schema.venues.name,
      },
    })
    .from(schema.invites)
    .innerJoin(schema.users, eq(schema.users.id, schema.invites.fromUserId))
    .innerJoin(schema.events, eq(schema.events.id, schema.invites.eventId))
    .innerJoin(schema.venues, eq(schema.venues.id, schema.events.venueId))
    .where(
      and(
        eq(schema.invites.toUserId, me),
        eq(schema.invites.status, 'pending')
      )
    )
    .orderBy(asc(schema.invites.createdAt));

  return c.json({ invites: rows });
});

/**
 * Verstuur uitnodigingen — één rij per ontvanger. Skipt self-invites,
 * niet-bevriende ontvangers en duplicaten (idempotent).
 */
invitesRoute.post('/', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  const body = (await c.req.json()) as {
    eventId?: string;
    toUserIds?: string[];
    message?: string;
  };
  const eventId = body.eventId;
  const toUserIds = Array.isArray(body.toUserIds) ? body.toUserIds : [];
  const message = (body.message ?? '').trim().slice(0, 280) || null;

  if (!eventId || toUserIds.length === 0) {
    return c.json({ error: 'eventId en toUserIds zijn verplicht' }, 400);
  }

  // Bestaat het event? Voorkomt dangling rows.
  const [event] = await db
    .select({ id: schema.events.id })
    .from(schema.events)
    .where(eq(schema.events.id, eventId))
    .limit(1);
  if (!event) return c.json({ error: 'event niet gevonden' }, 404);

  // Filter ontvangers: niet ikzelf, alleen accepted-friends.
  const candidates = toUserIds.filter((id) => id && id !== me);
  if (candidates.length === 0) return c.json({ created: 0, sent: [] });

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
          and(
            eq(schema.friendships.fromUserId, me),
            inArray(schema.friendships.toUserId, candidates)
          ),
          and(
            eq(schema.friendships.toUserId, me),
            inArray(schema.friendships.fromUserId, candidates)
          )
        )
      )
    );
  const friendIds = new Set(
    friendships.map((f) => (f.fromUserId === me ? f.toUserId : f.fromUserId))
  );
  const recipients = candidates.filter((id) => friendIds.has(id));
  if (recipients.length === 0) return c.json({ created: 0, sent: [] });

  // Bestaande invites voor dit event uit mijn naam — niet opnieuw versturen.
  const existing = await db
    .select({ toUserId: schema.invites.toUserId })
    .from(schema.invites)
    .where(
      and(
        eq(schema.invites.fromUserId, me),
        eq(schema.invites.eventId, eventId),
        inArray(schema.invites.toUserId, recipients)
      )
    );
  const alreadySent = new Set(existing.map((e) => e.toUserId));
  const fresh = recipients.filter((id) => !alreadySent.has(id));
  if (fresh.length === 0) {
    return c.json({ created: 0, sent: Array.from(alreadySent) });
  }

  await db.insert(schema.invites).values(
    fresh.map((toUserId) => ({
      id: randomUUID(),
      fromUserId: me,
      toUserId,
      eventId,
      message,
      status: 'pending' as const,
    }))
  );
  return c.json({ created: fresh.length, sent: fresh });
});

invitesRoute.post('/:id/accept', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(schema.invites)
    .where(
      and(
        eq(schema.invites.id, id),
        eq(schema.invites.toUserId, me),
        eq(schema.invites.status, 'pending')
      )
    )
    .limit(1);
  if (!row) return c.json({ error: 'Geen openstaande uitnodiging.' }, 404);

  await db
    .update(schema.invites)
    .set({ status: 'accepted' })
    .where(eq(schema.invites.id, id));

  // Bij accept ook automatisch de save aanmaken zodat het event direct
  // in Gered staat. Idempotent (skip als al gesaved).
  const [existingSave] = await db
    .select()
    .from(schema.saves)
    .where(
      and(eq(schema.saves.userId, me), eq(schema.saves.eventId, row.eventId))
    )
    .limit(1);
  if (!existingSave) {
    await db.insert(schema.saves).values({ userId: me, eventId: row.eventId });
  }

  return c.json({ status: 'accepted', eventId: row.eventId });
});

invitesRoute.post('/:id/decline', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  const id = c.req.param('id');
  await db
    .update(schema.invites)
    .set({ status: 'declined' })
    .where(
      and(
        eq(schema.invites.id, id),
        eq(schema.invites.toUserId, me),
        eq(schema.invites.status, 'pending')
      )
    );
  return c.json({ ok: true });
});
