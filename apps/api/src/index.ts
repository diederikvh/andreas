import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import { eq } from 'drizzle-orm';

import { auth } from './auth.js';
import { db, schema } from './db/index.js';
import { eventsRoute } from './routes/events.js';
import { friendsRoute, usersRoute } from './routes/friends.js';
import { invitesRoute } from './routes/invites.js';
import { savesRoute } from './routes/saves.js';
import { venuesRoute } from './routes/venues.js';
import { uploadToBunny } from './storage/bunny.js';

const app = new Hono();

app.use('*', logger());
app.use(
  '*',
  cors({
    origin: (origin) => origin ?? '*',
    credentials: true,
  })
);

// better-auth catches its own routes under /api/auth/**
app.on(['POST', 'GET'], '/api/auth/*', (c) => auth.handler(c.req.raw));

app.get('/health', (c) => c.json({ ok: true }));

app.get('/me', async (c) => {
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });
  if (!session) return c.json({ error: 'unauthorized' }, 401);

  // Hydrateer met de Andreas-velden (handle, modePreference) die niet
  // op de better-auth session.user zitten.
  const [row] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, session.user.id))
    .limit(1);
  return c.json({ user: row ?? session.user });
});

app.patch('/me', async (c) => {
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });
  if (!session) return c.json({ error: 'unauthorized' }, 401);

  const body = (await c.req.json()) as { name?: string; handle?: string };
  const name = (body.name ?? '').trim();
  const handle = (body.handle ?? '').trim().toLowerCase();

  if (name.length < 1 || name.length > 60) {
    return c.json({ error: 'Naam is verplicht (1–60 tekens).' }, 400);
  }
  if (!/^[a-z0-9_]{3,20}$/.test(handle)) {
    return c.json(
      {
        error:
          'Handle: 3–20 tekens, alleen kleine letters, cijfers en underscore.',
      },
      400
    );
  }

  try {
    await db
      .update(schema.users)
      .set({ name, handle, updatedAt: new Date() })
      .where(eq(schema.users.id, session.user.id));
  } catch (e) {
    // Postgres unique-violation = 23505. Drizzle's neon-serverless
    // wrapper laat de PG-fout op `.cause` zien; check beide niveaus.
    const code = (e as { code?: string }).code
      ?? ((e as { cause?: { code?: string } }).cause?.code ?? '');
    const msg = `${(e as Error).message ?? ''} ${(e as { cause?: Error }).cause?.message ?? ''}`;
    const isUnique =
      code === '23505' ||
      msg.includes('users_handle_idx') ||
      msg.includes('duplicate key') ||
      msg.includes('unique constraint');
    if (isUnique) {
      return c.json({ error: 'Deze handle is al bezet.' }, 409);
    }
    // eslint-disable-next-line no-console
    console.error('PATCH /me update failed', e);
    throw e;
  }

  const [row] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, session.user.id))
    .limit(1);
  return c.json({ user: row });
});

app.post('/me/avatar', async (c) => {
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });
  if (!session) return c.json({ error: 'unauthorized' }, 401);

  const form = await c.req.formData();
  const file = form.get('avatar');
  if (!file || typeof file === 'string') {
    return c.json({ error: 'Geen afbeelding ontvangen.' }, 400);
  }
  if (file.size > 6 * 1024 * 1024) {
    return c.json({ error: 'Afbeelding is te groot (max 6 MB).' }, 413);
  }
  const contentType = file.type || 'image/jpeg';
  if (!contentType.startsWith('image/')) {
    return c.json({ error: 'Bestand is geen afbeelding.' }, 400);
  }

  const ext = contentType.includes('png')
    ? 'png'
    : contentType.includes('webp')
      ? 'webp'
      : 'jpg';
  const path = `avatars/${session.user.id}.${ext}`;
  const buffer = await file.arrayBuffer();
  const publicBase = await uploadToBunny(path, buffer, contentType);

  // Cache-bust querystring zodat ge-update profielfoto's direct laden.
  const avatarUrl = `${publicBase}?v=${Date.now()}`;

  await db
    .update(schema.users)
    .set({ avatarUrl, updatedAt: new Date() })
    .where(eq(schema.users.id, session.user.id));

  const [row] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, session.user.id))
    .limit(1);
  return c.json({ user: row });
});

app.route('/events', eventsRoute);
app.route('/venues', venuesRoute);
app.route('/saves', savesRoute);
app.route('/friends', friendsRoute);
app.route('/users', usersRoute);
app.route('/invites', invitesRoute);

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`andreas-api listening on :${port}`);
