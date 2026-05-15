import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import { eq } from 'drizzle-orm';

import { auth } from './auth.js';
import { db, schema } from './db/index.js';
import { adminRoute } from './routes/admin/index.js';
import { eventsRoute } from './routes/events.js';
import { friendsRoute, usersRoute } from './routes/friends.js';
import { hubsRoute } from './routes/hubs.js';
import { invitesRoute } from './routes/invites.js';
import { legalRoute } from './routes/legal.js';
import { dismissesRoute, mirrorRoute } from './routes/mirror.js';
import { shareInvitesRoute } from './routes/share-invites.js';
import { pushRoute } from './routes/push.js';
import { savesRoute } from './routes/saves.js';
import { seoFeedsRoute } from './routes/seo-feeds.js';
import { seriesRoute } from './routes/series.js';
import { shareRoute } from './routes/share.js';
import { socialRoute } from './routes/social.js';
import { venueFollowsRoute } from './routes/venue-follows.js';
import { venuesRoute } from './routes/venues.js';
import { uploadToBunny } from './storage/bunny.js';

const app = new Hono();

app.use('*', logger());

// CORS — prod-origins (web/share-pagina + Expo dev clients). In dev
// laten we alles toe; in prod lijst we expliciet zodat het session-
// cookie/bearer-pad alleen voor onze eigen domeinen werkt.
const isProd = process.env.NODE_ENV === 'production';
const PROD_ORIGINS = new Set([
  'https://andreas.amsterdam',
  'https://api.andreas.amsterdam',
]);
app.use(
  '*',
  cors({
    origin: (origin) => {
      if (!origin) return origin ?? '*';
      if (!isProd) return origin;
      if (PROD_ORIGINS.has(origin)) return origin;
      // Expo Go / dev-client tijdens TestFlight-test (andreas:// scheme
      // doet geen Origin-header, dus alleen web-origins hier).
      return null;
    },
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

  const body = (await c.req.json()) as {
    name?: string;
    handle?: string;
    savesVisibility?: 'friends' | 'private';
    mirrorVisibility?: 'friends' | 'private';
    discoverable?: boolean;
  };

  // Bouw alleen de update-set op met velden die meekwamen — zo kan
  // de profielpagina alleen naam/handle posten en de privacy-toggles
  // alleen hun eigen veld zonder de rest aan te raken.
  const updates: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (body.name !== undefined) {
    const name = body.name.trim();
    if (name.length < 1 || name.length > 60) {
      return c.json({ error: 'Naam is verplicht (1–60 tekens).' }, 400);
    }
    updates.name = name;
  }

  if (body.handle !== undefined) {
    const handle = body.handle.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(handle)) {
      return c.json(
        {
          error:
            'Handle: 3–20 tekens, alleen kleine letters, cijfers en underscore.',
        },
        400
      );
    }
    updates.handle = handle;
  }

  if (body.savesVisibility !== undefined) {
    if (body.savesVisibility !== 'friends' && body.savesVisibility !== 'private') {
      return c.json({ error: 'savesVisibility moet "friends" of "private" zijn.' }, 400);
    }
    updates.savesVisibility = body.savesVisibility;
  }

  if (body.mirrorVisibility !== undefined) {
    if (body.mirrorVisibility !== 'friends' && body.mirrorVisibility !== 'private') {
      return c.json({ error: 'mirrorVisibility moet "friends" of "private" zijn.' }, 400);
    }
    updates.mirrorVisibility = body.mirrorVisibility;
  }

  if (body.discoverable !== undefined) {
    if (typeof body.discoverable !== 'boolean') {
      return c.json({ error: 'discoverable moet true of false zijn.' }, 400);
    }
    updates.discoverable = body.discoverable;
  }

  try {
    await db
      .update(schema.users)
      .set(updates)
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
app.route('/series', seriesRoute);
app.route('/saves', savesRoute);
app.route('/mirror', mirrorRoute);
app.route('/dismisses', dismissesRoute);
app.route('/social', socialRoute);
app.route('/friends', friendsRoute);
app.route('/users', usersRoute);
app.route('/invites', invitesRoute);
app.route('/share-invites', shareInvitesRoute);
app.route('/venue-follows', venueFollowsRoute);
app.route('/push', pushRoute);
app.route('/admin', adminRoute);

// Publieke web-routes (landing + share-pagina's + AASA + privacy/voorwaarden).
// Geen auth. Mounten als laatste zodat de JSON-API-routes voorrang
// krijgen op `/` matches. Legal eerst zodat /privacy en /voorwaarden
// niet door shareRoute worden opgevangen.
app.route('/', legalRoute);
app.route('/', seoFeedsRoute);
// Hub-pagina's (`/muziek`, `/clubs`, `/vandaag` enz.) mounten vóór
// shareRoute zodat de specifieke slugs voorrang krijgen op de
// catchall-routes (geen die nu bestaan, maar future-safe).
app.route('/', hubsRoute);
app.route('/', shareRoute);

const port = Number(process.env.PORT ?? 8787);
// Op Fly draait de container achter een proxy; bind expliciet op
// 0.0.0.0 zodat het container-network 'm vindt.
serve({ fetch: app.fetch, port, hostname: '0.0.0.0' });
console.log(`andreas-api listening on 0.0.0.0:${port}`);
