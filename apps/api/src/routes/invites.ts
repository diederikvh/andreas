import { randomUUID } from 'node:crypto';

import { and, asc, eq, inArray, or } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import { auth } from '../auth.js';
import { db, schema } from '../db/index.js';
import { sendPushToUser, sendPushToUsers } from '../push.js';

async function requireUserId(c: Context): Promise<string | Response> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  return session.user.id;
}

export const invitesRoute = new Hono();

/**
 * Mijn ontvangen uitnodigingen — alleen pending, met inviter-profiel,
 * occurrence (datum/tijd/zaal) én event (titel/venue/categorie). De
 * mobile-UI rendert "X nodigt je uit voor [event] op [datum]".
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
      occurrence: {
        id: schema.occurrences.id,
        startsAt: schema.occurrences.startsAt,
        endsAt: schema.occurrences.endsAt,
        room: schema.occurrences.room,
      },
      event: {
        id: schema.events.id,
        title: schema.events.title,
        kind: schema.events.kind,
        category: schema.events.category,
        imageUrl: schema.events.imageUrl,
        venueId: schema.venues.id,
        venueSlug: schema.venues.slug,
        venueName: schema.venues.name,
      },
    })
    .from(schema.invites)
    .innerJoin(schema.users, eq(schema.users.id, schema.invites.fromUserId))
    .innerJoin(
      schema.occurrences,
      eq(schema.occurrences.id, schema.invites.occurrenceId)
    )
    .innerJoin(schema.events, eq(schema.events.id, schema.occurrences.eventId))
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
 * Verstuur uitnodigingen — één rij per ontvanger, voor een specifieke
 * occurrence (= datum/tijd/zaal). Skipt self-invites, niet-bevriende
 * ontvangers en duplicaten (idempotent).
 */
invitesRoute.post('/', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  const body = (await c.req.json()) as {
    occurrenceId?: string;
    toUserIds?: string[];
    message?: string;
  };
  const occurrenceId = body.occurrenceId;
  const toUserIds = Array.isArray(body.toUserIds) ? body.toUserIds : [];
  const message = (body.message ?? '').trim().slice(0, 280) || null;

  if (!occurrenceId || toUserIds.length === 0) {
    return c.json({ error: 'occurrenceId en toUserIds zijn verplicht' }, 400);
  }

  // Bestaat de occurrence? Voorkomt dangling rows.
  const [occ] = await db
    .select({ id: schema.occurrences.id, eventId: schema.occurrences.eventId })
    .from(schema.occurrences)
    .where(eq(schema.occurrences.id, occurrenceId))
    .limit(1);
  if (!occ) return c.json({ error: 'occurrence niet gevonden' }, 404);

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

  // Bestaande invites voor deze occurrence uit mijn naam — niet opnieuw versturen.
  const existing = await db
    .select({ toUserId: schema.invites.toUserId })
    .from(schema.invites)
    .where(
      and(
        eq(schema.invites.fromUserId, me),
        eq(schema.invites.occurrenceId, occurrenceId),
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
      occurrenceId,
      message,
      status: 'pending' as const,
    }))
  );

  // Push de ontvangers. Eén query voor mijn naam + event-titel zodat
  // de body persoonlijk + concreet is. Failures negeren.
  try {
    const [me_user] = await db
      .select({ name: schema.users.name, handle: schema.users.handle })
      .from(schema.users)
      .where(eq(schema.users.id, me))
      .limit(1);
    const [ev] = await db
      .select({ title: schema.events.title })
      .from(schema.events)
      .where(eq(schema.events.id, occ.eventId))
      .limit(1);
    const display =
      me_user?.name?.trim() ||
      (me_user?.handle ? `@${me_user.handle}` : 'Iemand');
    const eventTitle = ev?.title ?? 'een event';
    await sendPushToUsers(fresh, {
      title: 'Uitnodiging',
      body: `${display} nodigt je uit voor ${eventTitle}`,
      // Tap op een uitnodiging-push opent altijd de Inbox; daar kan de
      // gebruiker accepteren/decline'n vóór ze naar het event gaan.
      data: { url: '/inbox' },
    });
  } catch (err) {
    console.error('[invites] push failed', err);
  }

  return c.json({ created: fresh.length, sent: fresh });
});

invitesRoute.post('/:id/accept', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  const id = c.req.param('id');
  const [row] = await db
    .select({
      id: schema.invites.id,
      fromUserId: schema.invites.fromUserId,
      occurrenceId: schema.invites.occurrenceId,
      eventId: schema.occurrences.eventId,
      eventTitle: schema.events.title,
    })
    .from(schema.invites)
    .innerJoin(
      schema.occurrences,
      eq(schema.occurrences.id, schema.invites.occurrenceId)
    )
    .innerJoin(schema.events, eq(schema.events.id, schema.occurrences.eventId))
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

  // Bij accept ook automatisch het master-event saven zodat het in Gered
  // staat. Saves zijn op event-niveau (niet occurrence) — je redt
  // "Hamlet", niet één voorstelling. Idempotent (skip als al gesaved).
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

  // Push de oorspronkelijke uitnodiger ("X gaat met je mee naar [event]").
  try {
    const [meUser] = await db
      .select({ name: schema.users.name, handle: schema.users.handle })
      .from(schema.users)
      .where(eq(schema.users.id, me))
      .limit(1);
    const display =
      meUser?.name?.trim() ||
      (meUser?.handle ? `@${meUser.handle}` : 'Iemand');
    await sendPushToUser(row.fromUserId, {
      title: 'Uitnodiging geaccepteerd',
      body: `${display} gaat met je mee naar ${row.eventTitle}`,
      data: { url: `/event/${row.eventId}?o=${row.occurrenceId}` },
    });
  } catch (err) {
    console.error('[invites] accept push failed', err);
  }

  return c.json({
    status: 'accepted',
    eventId: row.eventId,
    occurrenceId: row.occurrenceId,
  });
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
