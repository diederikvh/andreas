import { randomBytes } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import { auth } from '../auth.js';
import { db, schema } from '../db/index.js';
import { sendPushToUser } from '../push.js';

/**
 * Share-invites: vriend-uitnodigingen via een token-URL die je
 * extern (WhatsApp/iMessage) deelt. Ontvanger downloadt + logt in →
 * app claimt de token → friendship-upsert met status `accepted`.
 *
 * v1 is friend-only (geen event/venue koppeling); de tabel-kolommen
 * zijn al voorbereid voor latere uitbreiding.
 */

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ?? 'https://andreas.amsterdam';
const TOKEN_TTL_DAYS = 30;

async function requireUserId(c: Context): Promise<string | Response> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  return session.user.id;
}

function generateToken(): string {
  // 16 bytes → 22-char base64url string (URL-safe, no padding).
  return randomBytes(16).toString('base64url');
}

function generateId(): string {
  return `si_${randomBytes(8).toString('base64url')}`;
}

export const shareInvitesRoute = new Hono();

/**
 * POST /share-invites — auth-only.
 * Body: { eventId?, venueId? } (beide optioneel, v1 negeert ze).
 * Returns: { token, url, expiresAt }
 */
shareInvitesRoute.post('/', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  let body: { eventId?: string; venueId?: string } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    /* lege body is OK voor pure friend-invite */
  }

  const token = generateToken();
  const id = generateId();
  const expiresAt = new Date(
    Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000
  );

  await db.insert(schema.shareInvites).values({
    id,
    fromUserId: me,
    eventId: body.eventId ?? null,
    venueId: body.venueId ?? null,
    token,
    expiresAt,
  });

  return c.json({
    token,
    url: `${PUBLIC_BASE_URL}/i/${token}`,
    expiresAt: expiresAt.toISOString(),
  });
});

/**
 * POST /share-invites/:token/claim — auth-only, idempotent.
 *
 * Effecten:
 *  - friendship upsert (status `accepted`, beide richtingen worden
 *    bijgewerkt indien al pending)
 *  - share_invite.claimedBy/At gezet (alleen bij eerste claim)
 *  - Push naar de inviter: "X is je nieuwe vriend"
 *
 * Idempotent: meerdere claims door dezelfde user veranderen niets;
 * een claim door een andere user dan de eerste claimt niet alsnog,
 * we returnen wel het friendship-resultaat zodat de UI consistent
 * een 'vrienden'-state kan tonen.
 *
 * Faal-paden:
 *  - 404 token niet gevonden
 *  - 410 token verlopen
 *  - 400 zelf-claim (inviter == claimer)
 */
shareInvitesRoute.post('/:token/claim', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;
  const token = c.req.param('token');

  const [invite] = await db
    .select()
    .from(schema.shareInvites)
    .where(eq(schema.shareInvites.token, token))
    .limit(1);
  if (!invite) return c.json({ error: 'token niet gevonden' }, 404);
  if (invite.expiresAt.getTime() < Date.now()) {
    return c.json({ error: 'token verlopen' }, 410);
  }
  if (invite.fromUserId === me) {
    return c.json({ error: 'kan jezelf niet uitnodigen' }, 400);
  }

  // Inviter-info voor de respons (UI toont "Je bent nu vrienden met X").
  const [inviter] = await db
    .select({
      id: schema.users.id,
      name: schema.users.name,
      handle: schema.users.handle,
      avatarUrl: schema.users.avatarUrl,
    })
    .from(schema.users)
    .where(eq(schema.users.id, invite.fromUserId))
    .limit(1);
  if (!inviter) return c.json({ error: 'inviter bestaat niet meer' }, 410);

  // Friendship: bestaat 'r al een rij in een van beide richtingen?
  // Zo ja, upgrade naar accepted. Zo nee, insert nieuwe rij van
  // inviter → claimer met status accepted (claimer = ik, expliciet
  // akkoord door tappen op de link).
  const [forward] = await db
    .select()
    .from(schema.friendships)
    .where(
      and(
        eq(schema.friendships.fromUserId, invite.fromUserId),
        eq(schema.friendships.toUserId, me)
      )
    )
    .limit(1);
  const [reverse] = await db
    .select()
    .from(schema.friendships)
    .where(
      and(
        eq(schema.friendships.fromUserId, me),
        eq(schema.friendships.toUserId, invite.fromUserId)
      )
    )
    .limit(1);

  let friendshipChange: 'created' | 'upgraded' | 'noop' = 'noop';
  if (forward) {
    if (forward.status !== 'accepted') {
      await db
        .update(schema.friendships)
        .set({ status: 'accepted' })
        .where(
          and(
            eq(schema.friendships.fromUserId, invite.fromUserId),
            eq(schema.friendships.toUserId, me)
          )
        );
      friendshipChange = 'upgraded';
    }
  } else if (reverse) {
    if (reverse.status !== 'accepted') {
      await db
        .update(schema.friendships)
        .set({ status: 'accepted' })
        .where(
          and(
            eq(schema.friendships.fromUserId, me),
            eq(schema.friendships.toUserId, invite.fromUserId)
          )
        );
      friendshipChange = 'upgraded';
    }
  } else {
    await db.insert(schema.friendships).values({
      fromUserId: invite.fromUserId,
      toUserId: me,
      status: 'accepted',
    });
    friendshipChange = 'created';
  }

  // Stempel de claim alleen op de eerste keer. Daarna nooit
  // overschrijven (idempotent).
  if (!invite.claimedAt) {
    await db
      .update(schema.shareInvites)
      .set({ claimedByUserId: me, claimedAt: new Date() })
      .where(eq(schema.shareInvites.id, invite.id));
  }

  // Push naar inviter dat er een nieuwe vriend bij is — alleen als
  // we daadwerkelijk een friendship hebben aangemaakt of upgraded.
  if (friendshipChange !== 'noop') {
    try {
      const [claimer] = await db
        .select({ name: schema.users.name, handle: schema.users.handle })
        .from(schema.users)
        .where(eq(schema.users.id, me))
        .limit(1);
      const display =
        claimer?.name?.trim() || (claimer?.handle ? `@${claimer.handle}` : 'Iemand');
      await sendPushToUser(invite.fromUserId, {
        title: 'Nieuwe vriend',
        body: `${display} heeft je uitnodiging geaccepteerd`,
        data: claimer?.handle
          ? { url: `/u/${claimer.handle}` }
          : { url: '/(tabs)/social' },
      });
    } catch (err) {
      console.error('[share-invites] push failed', err);
    }
  }

  return c.json({
    inviter: {
      id: inviter.id,
      name: inviter.name,
      handle: inviter.handle,
      avatarUrl: inviter.avatarUrl,
    },
    friendshipChange,
  });
});
