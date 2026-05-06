import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import { auth } from '../auth.js';
import { db, schema } from '../db/index.js';

async function requireUserId(c: Context): Promise<string | Response> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  return session.user.id;
}

export const pushRoute = new Hono();

const VALID_PLATFORMS = new Set(['ios', 'android']);

/**
 * Mobile registreert hier z'n Expo-push-token na een succesvolle
 * permission-grant. Idempotent: als hetzelfde token al bestaat updaten
 * we userId + lastSeenAt (token kan van user wisselen na logout/login
 * op hetzelfde device, of `deviceId` wordt rijker bekend).
 */
pushRoute.post('/register', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  const body = (await c.req.json()) as {
    token?: string;
    platform?: string;
    deviceId?: string | null;
  };
  const token = (body.token ?? '').trim();
  const platform = body.platform;
  const deviceId = body.deviceId ?? null;

  if (!token) return c.json({ error: 'token is verplicht' }, 400);
  if (!platform || !VALID_PLATFORMS.has(platform)) {
    return c.json({ error: 'platform moet "ios" of "android" zijn' }, 400);
  }
  if (!token.startsWith('ExponentPushToken[') && !token.startsWith('ExpoPushToken[')) {
    return c.json({ error: 'geen geldig Expo-push-token' }, 400);
  }

  await db
    .insert(schema.pushTokens)
    .values({
      id: randomUUID(),
      userId: me,
      token,
      platform: platform as 'ios' | 'android',
      deviceId,
    })
    .onConflictDoUpdate({
      target: schema.pushTokens.token,
      set: {
        userId: me,
        platform: platform as 'ios' | 'android',
        deviceId,
        lastSeenAt: new Date(),
      },
    });

  return c.json({ ok: true });
});

/**
 * Aangeroepen bij logout of `Notifications.deny`. Verwijdert het token
 * zodat we niet blijven pushen naar een uitgelogd device.
 */
pushRoute.post('/unregister', async (c) => {
  const me = await requireUserId(c);
  if (typeof me !== 'string') return me;

  const body = (await c.req.json()) as { token?: string };
  const token = (body.token ?? '').trim();
  if (!token) return c.json({ error: 'token is verplicht' }, 400);

  await db
    .delete(schema.pushTokens)
    .where(
      and(
        eq(schema.pushTokens.userId, me),
        eq(schema.pushTokens.token, token)
      )
    );
  return c.json({ ok: true });
});
