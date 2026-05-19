import { randomUUID } from 'node:crypto';

import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import { auth } from '../auth.js';
import { db, schema } from '../db/index.js';
import { sendPushToUser, sendPushToUsers } from '../push.js';

async function requireUserId(c: Context): Promise<string | Response> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  return session.user.id;
}

/**
 * Display-naam helper — voor push-bodies. "Diederik" / "@dier" / "Iemand".
 */
async function displayName(userId: string): Promise<string> {
  const [u] = await db
    .select({ name: schema.users.name, handle: schema.users.handle })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return u?.name?.trim() || (u?.handle ? `@${u.handle}` : 'Iemand');
}

/**
 * Heeft `userId` deze groep gemuted? Voor 1-op-1 invites (groupId null)
 * is er geen mute-concept en geeft false terug. Wordt gebruikt om push-
 * notificaties te onderdrukken voor leden die hun groep stil hebben
 * gezet — ze zien de invite wel in de app, maar de telefoon piept niet.
 */
async function isMutedInGroup(
  userId: string,
  groupId: string | null
): Promise<boolean> {
  if (!groupId) return false;
  const [row] = await db
    .select({ mutedAt: schema.groupMembers.mutedAt })
    .from(schema.groupMembers)
    .where(
      and(
        eq(schema.groupMembers.groupId, groupId),
        eq(schema.groupMembers.userId, userId),
        isNull(schema.groupMembers.leftAt)
      )
    )
    .limit(1);
  return row?.mutedAt !== null && row?.mutedAt !== undefined;
}

/**
 * Vrienden-filter — accepteer alleen accepted-friends als 1-op-1
 * uitnodig-doel. Group-invites filteren niet op friendship: leden van
 * dezelfde groep mogen elkaar uitnodigen ongeacht onderlinge friendship-
 * status (de groep is de sociale band).
 */
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

export const invitationsRoute = new Hono();

/**
 * Mijn invitations — inbox (waar ik een response op heb) en outbox (door
 * mij verstuurd). Beide filteren op `revokedAt IS NULL` én niet-verlopen
 * occurrence (`endsAt > now() OR endsAt IS NULL`). Verlopen + ingetrokken
 * staan in `/invitations?past=1`.
 *
 * Voor groep-invitations bevatten de responses alle leden van de groep
 * (incl. initiator) zodat de UI direct "X gaat, Y misschien, Z pending"
 * kan tonen zonder follow-up call.
 */
invitationsRoute.get('/', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  const past = c.req.query('past') === '1';
  const now = new Date();

  // Welke invitations raken mij? Twee bronnen:
  //   1) outgoing — ik ben fromUserId
  //   2) incoming — ik heb een response-rij
  // Combineer beide id-sets, fetch alles in één query, en filter op
  // verlopen-status in JS na join.
  const outgoing = await db
    .select({ id: schema.invitations.id })
    .from(schema.invitations)
    .where(
      and(
        eq(schema.invitations.fromUserId, me),
        past
          ? sql`true`
          : isNull(schema.invitations.revokedAt)
      )
    );
  const incoming = await db
    .select({ id: schema.invitations.id })
    .from(schema.invitationResponses)
    .innerJoin(
      schema.invitations,
      eq(schema.invitations.id, schema.invitationResponses.invitationId)
    )
    .where(
      and(
        eq(schema.invitationResponses.userId, me),
        past ? sql`true` : isNull(schema.invitations.revokedAt)
      )
    );

  const idSet = new Set<string>([
    ...outgoing.map((r) => r.id),
    ...incoming.map((r) => r.id),
  ]);
  if (idSet.size === 0) return c.json({ invitations: [] });
  const ids = Array.from(idSet);

  // Hoofd-records met event/occurrence/inviter-info én groepsnaam.
  const rows = await db
    .select({
      id: schema.invitations.id,
      message: schema.invitations.message,
      revokedAt: schema.invitations.revokedAt,
      createdAt: schema.invitations.createdAt,
      from: {
        id: schema.users.id,
        name: schema.users.name,
        handle: schema.users.handle,
        avatarUrl: schema.users.avatarUrl,
      },
      groupId: schema.invitations.groupId,
      groupName: schema.groups.name,
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
    .from(schema.invitations)
    .innerJoin(schema.users, eq(schema.users.id, schema.invitations.fromUserId))
    .innerJoin(
      schema.occurrences,
      eq(schema.occurrences.id, schema.invitations.occurrenceId)
    )
    .innerJoin(schema.events, eq(schema.events.id, schema.occurrences.eventId))
    .innerJoin(schema.venues, eq(schema.venues.id, schema.events.venueId))
    .leftJoin(schema.groups, eq(schema.groups.id, schema.invitations.groupId))
    .where(inArray(schema.invitations.id, ids))
    .orderBy(desc(schema.invitations.createdAt));

  // Filter op verlopen (endsAt fallback startsAt + 4u).
  const filtered = past
    ? rows
    : rows.filter((r) => {
        const end = r.occurrence.endsAt
          ? new Date(r.occurrence.endsAt as unknown as string)
          : new Date(
              new Date(r.occurrence.startsAt as unknown as string).getTime() +
                4 * 3600 * 1000
            );
        return end > now;
      });
  if (filtered.length === 0) return c.json({ invitations: [] });
  const finalIds = filtered.map((r) => r.id);

  const responses = await db
    .select({
      invitationId: schema.invitationResponses.invitationId,
      status: schema.invitationResponses.status,
      replyMessage: schema.invitationResponses.replyMessage,
      reminderSentAt: schema.invitationResponses.reminderSentAt,
      respondedAt: schema.invitationResponses.respondedAt,
      user: {
        id: schema.users.id,
        name: schema.users.name,
        handle: schema.users.handle,
        avatarUrl: schema.users.avatarUrl,
      },
    })
    .from(schema.invitationResponses)
    .innerJoin(
      schema.users,
      eq(schema.users.id, schema.invitationResponses.userId)
    )
    .where(inArray(schema.invitationResponses.invitationId, finalIds));

  const responsesByInvitation = new Map<string, typeof responses>();
  for (const r of responses) {
    const list = responsesByInvitation.get(r.invitationId);
    if (list) list.push(r);
    else responsesByInvitation.set(r.invitationId, [r]);
  }

  return c.json({
    invitations: filtered.map((r) => {
      const all = responsesByInvitation.get(r.id) ?? [];
      const myResponse = all.find((x) => x.user.id === me) ?? null;
      return {
        id: r.id,
        message: r.message,
        revokedAt: r.revokedAt,
        createdAt: r.createdAt,
        isOutgoing: r.from.id === me,
        from: r.from,
        group: r.groupId
          ? { id: r.groupId, name: r.groupName ?? '' }
          : null,
        occurrence: r.occurrence,
        event: r.event,
        myStatus: myResponse?.status ?? null,
        myReplyMessage: myResponse?.replyMessage ?? null,
        responses: all.map((x) => ({
          user: x.user,
          status: x.status,
          replyMessage: x.replyMessage,
          reminderSentAt: x.reminderSentAt,
          respondedAt: x.respondedAt,
        })),
      };
    }),
  });
});

/**
 * Verstuur uitnodigingen — accepteert een mix van groepen en individuen
 * in één call. Per groep: één invitation-rij + response-rij per actief
 * lid (snapshot). Per individu: één invitation-rij (groupId null) +
 * response-rij voor recipient. Initiator krijgt altijd zelf een
 * response-rij met status `going` (default).
 *
 * Idempotent: dezelfde initiator kan niet twee actieve invitations voor
 * dezelfde (occurrence, groupId|userId) hebben. Dubbele calls retourneren
 * de bestaande id's.
 */
invitationsRoute.post('/', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  const body = (await c.req.json()) as {
    occurrenceId?: string;
    groupIds?: string[];
    userIds?: string[];
    message?: string;
  };
  const occurrenceId = body.occurrenceId;
  const groupIds = Array.isArray(body.groupIds) ? body.groupIds : [];
  const userIds = Array.isArray(body.userIds) ? body.userIds : [];
  const message = (body.message ?? '').trim().slice(0, 280) || null;

  if (!occurrenceId || (groupIds.length === 0 && userIds.length === 0)) {
    return c.json(
      { error: 'occurrenceId en minstens één groep of individu zijn verplicht' },
      400
    );
  }

  const [occ] = await db
    .select({ id: schema.occurrences.id, eventId: schema.occurrences.eventId })
    .from(schema.occurrences)
    .where(eq(schema.occurrences.id, occurrenceId))
    .limit(1);
  if (!occ) return c.json({ error: 'occurrence niet gevonden' }, 404);

  // ─── Groep-invitations ────────────────────────────────────────────────
  // Filter: alleen groepen waar ik actief lid van ben. Bestaande
  // (non-revoked) invitations voor dezelfde (me, occ, groep) worden
  // overgeslagen.
  const createdInvitationIds: string[] = [];
  const pushTargets: string[] = [];

  if (groupIds.length > 0) {
    const myGroups = await db
      .select({ groupId: schema.groupMembers.groupId })
      .from(schema.groupMembers)
      .where(
        and(
          eq(schema.groupMembers.userId, me),
          inArray(schema.groupMembers.groupId, groupIds),
          isNull(schema.groupMembers.leftAt)
        )
      );
    const eligibleGroups = new Set(myGroups.map((r) => r.groupId));

    if (eligibleGroups.size > 0) {
      const existing = await db
        .select({ groupId: schema.invitations.groupId })
        .from(schema.invitations)
        .where(
          and(
            eq(schema.invitations.fromUserId, me),
            eq(schema.invitations.occurrenceId, occurrenceId),
            inArray(schema.invitations.groupId, Array.from(eligibleGroups)),
            isNull(schema.invitations.revokedAt)
          )
        );
      const alreadyForGroups = new Set(existing.map((r) => r.groupId as string));

      for (const groupId of eligibleGroups) {
        if (alreadyForGroups.has(groupId)) continue;
        const members = await db
          .select({
            userId: schema.groupMembers.userId,
            mutedAt: schema.groupMembers.mutedAt,
          })
          .from(schema.groupMembers)
          .where(
            and(
              eq(schema.groupMembers.groupId, groupId),
              isNull(schema.groupMembers.leftAt)
            )
          );
        const memberIds = members.map((m) => m.userId);
        // Gemuteden krijgen wel een response-rij (anders missen ze de
        // invite in de app), maar geen push — dat is wat mute betekent
        // op groep-niveau.
        const mutedIds = new Set(
          members.filter((m) => m.mutedAt !== null).map((m) => m.userId)
        );
        const invitationId = randomUUID();
        await db.insert(schema.invitations).values({
          id: invitationId,
          fromUserId: me,
          occurrenceId,
          groupId,
          message,
        });
        await db.insert(schema.invitationResponses).values(
          memberIds.map((userId) => ({
            invitationId,
            userId,
            // Initiator default `going`, anderen `pending`.
            status: (userId === me ? 'going' : 'pending') as
              | 'going'
              | 'pending',
            respondedAt: userId === me ? new Date() : null,
          }))
        );
        createdInvitationIds.push(invitationId);
        for (const m of memberIds) {
          if (m === me) continue;
          if (mutedIds.has(m)) continue;
          pushTargets.push(m);
        }
      }
    }
  }

  // ─── 1-op-1 invitations ──────────────────────────────────────────────
  if (userIds.length > 0) {
    const friends = await filterAcceptedFriends(me, userIds);
    if (friends.size > 0) {
      // Bestaande non-revoked 1-op-1 (groupId IS NULL) waar deze friend
      // al response-rij heeft = al uitgenodigd.
      const existing = await db
        .select({
          invitationId: schema.invitations.id,
          recipientId: schema.invitationResponses.userId,
        })
        .from(schema.invitations)
        .innerJoin(
          schema.invitationResponses,
          eq(schema.invitationResponses.invitationId, schema.invitations.id)
        )
        .where(
          and(
            eq(schema.invitations.fromUserId, me),
            eq(schema.invitations.occurrenceId, occurrenceId),
            isNull(schema.invitations.groupId),
            isNull(schema.invitations.revokedAt),
            inArray(schema.invitationResponses.userId, Array.from(friends))
          )
        );
      const alreadyForUsers = new Set(existing.map((r) => r.recipientId));

      for (const friendId of friends) {
        if (alreadyForUsers.has(friendId)) continue;
        const invitationId = randomUUID();
        await db.insert(schema.invitations).values({
          id: invitationId,
          fromUserId: me,
          occurrenceId,
          groupId: null,
          message,
        });
        await db.insert(schema.invitationResponses).values([
          {
            invitationId,
            userId: me,
            status: 'going',
            respondedAt: new Date(),
          },
          { invitationId, userId: friendId, status: 'pending' },
        ]);
        createdInvitationIds.push(invitationId);
        pushTargets.push(friendId);
      }
    }
  }

  // Push naar alle nieuwe ontvangers — één bericht per persoon, ook al
  // zit een user in meerdere groepen die je in dezelfde call uitnodigt.
  if (pushTargets.length > 0) {
    try {
      const [ev] = await db
        .select({ title: schema.events.title })
        .from(schema.events)
        .where(eq(schema.events.id, occ.eventId))
        .limit(1);
      const display = await displayName(me);
      const eventTitle = ev?.title ?? 'een event';
      const uniqueTargets = Array.from(new Set(pushTargets));
      await sendPushToUsers(uniqueTargets, {
        title: 'Uitnodiging',
        body: `${display} nodigt je uit voor ${eventTitle}`,
        data: { url: `/event/${occ.eventId}?o=${occurrenceId}` },
      });
    } catch (err) {
      console.error('[invitations] send push failed', err);
    }
  }

  return c.json({ created: createdInvitationIds.length, ids: createdInvitationIds });
});

/**
 * Reageer op een uitnodiging. Status: `going` | `maybe` | `not_going`
 * (terugzetten naar `pending` mag niet). Mag tot occurrence-end. Bij
 * `going` wordt automatisch een save aangemaakt (zoals het oude accept-
 * gedrag). We verwijderen géén save bij transition weg-van-`going` —
 * users kunnen handmatig unsaven; auto-unsave zou onverwacht voelen
 * (een save kan ook van vóór de uitnodiging af komen).
 */
invitationsRoute.post('/:id/respond', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as
    | { status?: string; replyMessage?: unknown }
    | null;
  const status = body?.status;
  if (status !== 'going' && status !== 'maybe' && status !== 'not_going') {
    return c.json({ error: 'status moet going|maybe|not_going zijn' }, 400);
  }
  let replyMessage: string | null = null;
  if (typeof body?.replyMessage === 'string') {
    const trimmed = body.replyMessage.trim().slice(0, 280);
    replyMessage = trimmed.length > 0 ? trimmed : null;
  }

  // Resolve invitation + verify dat ik een response-rij heb.
  const [inv] = await db
    .select({
      id: schema.invitations.id,
      fromUserId: schema.invitations.fromUserId,
      occurrenceId: schema.invitations.occurrenceId,
      groupId: schema.invitations.groupId,
      revokedAt: schema.invitations.revokedAt,
      eventId: schema.occurrences.eventId,
      occurrenceEndsAt: schema.occurrences.endsAt,
      occurrenceStartsAt: schema.occurrences.startsAt,
      eventTitle: schema.events.title,
    })
    .from(schema.invitations)
    .innerJoin(
      schema.occurrences,
      eq(schema.occurrences.id, schema.invitations.occurrenceId)
    )
    .innerJoin(schema.events, eq(schema.events.id, schema.occurrences.eventId))
    .where(eq(schema.invitations.id, id))
    .limit(1);
  if (!inv) return c.json({ error: 'invitation niet gevonden' }, 404);
  if (inv.revokedAt) return c.json({ error: 'invitation ingetrokken' }, 410);

  const end = inv.occurrenceEndsAt
    ? new Date(inv.occurrenceEndsAt as unknown as string)
    : new Date(
        new Date(inv.occurrenceStartsAt as unknown as string).getTime() +
          4 * 3600 * 1000
      );
  if (end < new Date()) {
    return c.json({ error: 'event al voorbij' }, 410);
  }

  const [existing] = await db
    .select({
      status: schema.invitationResponses.status,
    })
    .from(schema.invitationResponses)
    .where(
      and(
        eq(schema.invitationResponses.invitationId, id),
        eq(schema.invitationResponses.userId, me)
      )
    )
    .limit(1);
  if (!existing) return c.json({ error: 'forbidden' }, 403);

  await db
    .update(schema.invitationResponses)
    .set({ status, replyMessage, respondedAt: new Date() })
    .where(
      and(
        eq(schema.invitationResponses.invitationId, id),
        eq(schema.invitationResponses.userId, me)
      )
    );

  // Save aanmaken bij overgang naar `going` (idempotent).
  if (status === 'going') {
    const [hasSave] = await db
      .select()
      .from(schema.saves)
      .where(
        and(
          eq(schema.saves.userId, me),
          eq(schema.saves.occurrenceId, inv.occurrenceId)
        )
      )
      .limit(1);
    if (!hasSave) {
      await db.insert(schema.saves).values({
        userId: me,
        occurrenceId: inv.occurrenceId,
        source: 'friend',
      });
    }
  }

  // Push naar de initiator wanneer dit een echte reactie van iemand
  // anders is. Eigen status-wijziging (initiator) niet pingen — die ziet
  // 't direct in z'n UI.
  if (inv.fromUserId !== me) {
    try {
      const display = await displayName(me);
      const verb =
        status === 'going'
          ? `gaat mee naar ${inv.eventTitle}`
          : status === 'maybe'
            ? `denkt misschien — ${inv.eventTitle}`
            : `gaat niet mee naar ${inv.eventTitle}`;
      const pushBody = replyMessage
        ? `${display}: ‘${replyMessage}’`
        : `${display} ${verb}`;
      // `not_going` zonder reply = stil (zoals oud-decline-gedrag).
      const silent = status === 'not_going' && !replyMessage;
      // Respecteer mute: als de initiator deze groep stil heeft gezet
      // gaat 'r geen push uit (de respons is wel zichtbaar in de app).
      const muted = await isMutedInGroup(inv.fromUserId, inv.groupId);
      if (!silent && !muted) {
        await sendPushToUser(inv.fromUserId, {
          title: 'Reactie op uitnodiging',
          body: pushBody,
          data: { url: `/event/${inv.eventId}?o=${inv.occurrenceId}` },
        });
      }
    } catch (err) {
      console.error('[invitations] respond push failed', err);
    }
  }

  return c.json({ ok: true, status });
});

/**
 * Reminder — initiator stuurt één-shot herinnering naar een pending
 * invitee. `reminderSentAt` op de response-rij voorkomt herhaalde reminders.
 * Push-tekst is uitnodigend per spec, niet pushy: bevat sociale bewijslast
 * ("X en N anderen gaan misschien").
 */
invitationsRoute.post('/:id/remind/:userId', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;
  const id = c.req.param('id');
  const targetUserId = c.req.param('userId');

  const [inv] = await db
    .select({
      id: schema.invitations.id,
      fromUserId: schema.invitations.fromUserId,
      occurrenceId: schema.invitations.occurrenceId,
      groupId: schema.invitations.groupId,
      revokedAt: schema.invitations.revokedAt,
      eventId: schema.occurrences.eventId,
      eventTitle: schema.events.title,
      venueName: schema.venues.name,
      startsAt: schema.occurrences.startsAt,
    })
    .from(schema.invitations)
    .innerJoin(
      schema.occurrences,
      eq(schema.occurrences.id, schema.invitations.occurrenceId)
    )
    .innerJoin(schema.events, eq(schema.events.id, schema.occurrences.eventId))
    .innerJoin(schema.venues, eq(schema.venues.id, schema.events.venueId))
    .where(eq(schema.invitations.id, id))
    .limit(1);
  if (!inv) return c.json({ error: 'invitation niet gevonden' }, 404);
  if (inv.fromUserId !== me) return c.json({ error: 'forbidden' }, 403);
  if (inv.revokedAt) return c.json({ error: 'invitation ingetrokken' }, 410);

  const [target] = await db
    .select({
      status: schema.invitationResponses.status,
      reminderSentAt: schema.invitationResponses.reminderSentAt,
    })
    .from(schema.invitationResponses)
    .where(
      and(
        eq(schema.invitationResponses.invitationId, id),
        eq(schema.invitationResponses.userId, targetUserId)
      )
    )
    .limit(1);
  if (!target) return c.json({ error: 'doelwit niet gevonden' }, 404);
  if (target.status !== 'pending') {
    return c.json({ error: 'al gereageerd' }, 409);
  }
  if (target.reminderSentAt) {
    return c.json({ error: 'al herinnerd' }, 409);
  }

  // Sociale bewijslast samenstellen — andere going/maybe-responses op
  // dezelfde invitation, exclusief target.
  const peers = await db
    .select({
      status: schema.invitationResponses.status,
      name: schema.users.name,
      handle: schema.users.handle,
    })
    .from(schema.invitationResponses)
    .innerJoin(schema.users, eq(schema.users.id, schema.invitationResponses.userId))
    .where(eq(schema.invitationResponses.invitationId, id));
  // Splits going vs maybe — going is concreter ("X gaat"), maybe valt
  // terug op zachter ("X denkt erover"). Per spec uitnodigend, niet
  // pushy: nooit "je hebt nog niet geantwoord". Sociale bewijslast +
  // open uitnodiging.
  const going = peers.filter((p) => p.status === 'going');
  const maybe = peers.filter((p) => p.status === 'maybe');
  const positives = going.length > 0 ? going : maybe;
  const positiveVerb = going.length > 0 ? 'gaat' : 'denkt erover';
  const positiveVerbPlural = going.length > 0 ? 'gaan' : 'denken erover';
  const firstName = positives[0]?.name?.split(' ')[0] ?? null;
  const extras = Math.max(0, positives.length - 1);
  const dayLabel = formatWeekday(inv.startsAt as unknown as string);
  let body: string;
  if (firstName && extras > 0) {
    body = `${firstName} en nog ${extras} ${positiveVerbPlural} ${dayLabel} naar ${inv.venueName}. Ga je mee?`;
  } else if (firstName) {
    body = `${firstName} ${positiveVerb} ${dayLabel} naar ${inv.venueName}. Ga je mee?`;
  } else {
    body = `${inv.eventTitle} ${dayLabel} bij ${inv.venueName}. Ga je mee?`;
  }

  await db
    .update(schema.invitationResponses)
    .set({ reminderSentAt: new Date() })
    .where(
      and(
        eq(schema.invitationResponses.invitationId, id),
        eq(schema.invitationResponses.userId, targetUserId)
      )
    );

  // Respecteer mute: target heeft groep stilgezet → reminderSentAt
  // wordt wel bijgewerkt (één-shot regel blijft staan), maar geen push.
  const targetMuted = await isMutedInGroup(targetUserId, inv.groupId);
  if (targetMuted) {
    return c.json({ ok: true });
  }

  try {
    await sendPushToUser(targetUserId, {
      title: inv.eventTitle,
      body,
      data: { url: `/event/${inv.eventId}?o=${inv.occurrenceId}` },
    });
  } catch (err) {
    console.error('[invitations] reminder push failed', err);
  }

  return c.json({ ok: true });
});

/**
 * Intrekken — alleen initiator. Soft-delete via `revokedAt`. Pending
 * invitees worden gepusht ("X heeft de uitnodiging ingetrokken")? Nee,
 * spec zegt daar niks over en het voelt ongemakkelijk. We laten 't stil
 * — de uitnodiging verdwijnt simpelweg uit hun inbox bij refresh.
 */
invitationsRoute.delete('/:id', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;
  const id = c.req.param('id');

  const [inv] = await db
    .select({ fromUserId: schema.invitations.fromUserId, revokedAt: schema.invitations.revokedAt })
    .from(schema.invitations)
    .where(eq(schema.invitations.id, id))
    .limit(1);
  if (!inv) return c.json({ error: 'not found' }, 404);
  if (inv.fromUserId !== me) return c.json({ error: 'forbidden' }, 403);
  if (inv.revokedAt) return c.json({ ok: true });

  await db
    .update(schema.invitations)
    .set({ revokedAt: new Date() })
    .where(eq(schema.invitations.id, id));
  return c.json({ ok: true });
});

function formatWeekday(iso: string): string {
  const d = new Date(iso);
  const names = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
  return names[d.getDay()] ?? '';
}
