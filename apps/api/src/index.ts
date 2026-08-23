// Sentry instrumenteert HTTP/DB — moet vóór alle andere imports laden.
import './instrument.js';

import { serve } from '@hono/node-server';
import * as Sentry from '@sentry/node';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';

import { auth } from './auth.js';
import { db, schema } from './db/index.js';
import { adminRoute } from './routes/admin/index.js';
import { artistsRoute } from './routes/artists.js';
import { eventsRoute } from './routes/events.js';
import { friendsRoute, usersRoute } from './routes/friends.js';
import { groupsRoute } from './routes/groups.js';
import { hubsRoute } from './routes/hubs.js';
import { invitationsRoute } from './routes/invitations.js';
import { invitesRoute } from './routes/invites.js';
import { legalRoute } from './routes/legal.js';
import { dismissesRoute, mirrorRoute } from './routes/mirror.js';
import { shareInvitesRoute } from './routes/share-invites.js';
import { pushRoute } from './routes/push.js';
import { savesRoute } from './routes/saves.js';
import { seoFeedsRoute } from './routes/seo-feeds.js';
import { oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata } from 'better-auth/plugins';
import { mcpRoute } from './routes/mcp.js';
import { mcpLoginRoute } from './routes/mcp-login.js';
import { searchRoute } from './routes/search.js';
import { zoekRoute } from './routes/zoek.js';
import { seriesRoute } from './routes/series.js';
import { aiConnectRoute } from './routes/ai-connect.js';
import { getAppRoute } from './routes/get-app.js';
import { shareRoute } from './routes/share.js';
import { socialRoute } from './routes/social.js';
import { venueFollowsRoute } from './routes/venue-follows.js';
import { venuesRoute } from './routes/venues.js';
import { uploadToBunny } from './storage/bunny.js';

const app = new Hono();

app.use('*', logger());

// Security-headers. Beschermt o.a. de publieke HTML-pagina's en de
// telefoon-OTP-loginpagina (/mcp-login) tegen clickjacking (frame-ancestors
// 'none' + X-Frame-Options DENY), MIME-sniffing (nosniff) en downgrade (HSTS).
// CSP zet ALLEEN frame-ancestors — geen script/style-directives, zodat de
// server-rendered pagina's met inline <style>/<script> blijven werken. De
// cross-origin-* policies staan uit zodat OG-images/cards cross-origin
// laadbaar blijven (social previews, MCP-UI).
app.use(
  '*',
  secureHeaders({
    contentSecurityPolicy: { frameAncestors: ["'none'"] },
    xFrameOptions: 'DENY',
    strictTransportSecurity: 'max-age=15552000; includeSubDomains',
    xContentTypeOptions: 'nosniff',
    referrerPolicy: 'strict-origin-when-cross-origin',
    crossOriginResourcePolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
  })
);

// Sentry — vang thrown errors via Hono's onError-hook. Bind user-id
// uit de better-auth session zodat we per-user kunnen zien wie een
// crash raakt. Bij ontbrekende DSN doet Sentry.* niets — geen overhead.
app.onError(async (err, c) => {
  if (process.env.NODE_ENV === 'production') {
    try {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (session?.user?.id) {
        Sentry.setUser({ id: session.user.id });
      }
    } catch {
      // session-lookup mag geen vervolg-crash veroorzaken.
    }
    Sentry.captureException(err, {
      tags: {
        method: c.req.method,
        path: new URL(c.req.url).pathname,
      },
    });
  }
  console.error('[api] uncaught:', err);
  return c.json({ error: 'internal_server_error' }, 500);
});

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
      // Geen Origin-header (server-to-server / same-origin navigatie) → geen
      // CORS nodig, dus géén ACAO-header (nooit '*' samen met credentials).
      if (!origin) return null;
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

// OAuth/MCP discovery op de root, zodat MCP-clients (Claude/ChatGPT) de
// authorization-server + protected-resource automatisch vinden. De
// better-auth mcp-plugin levert de inhoud; we exposen 'm hier.
app.get('/.well-known/oauth-authorization-server', (c) =>
  oAuthDiscoveryMetadata(auth)(c.req.raw)
);
app.get('/.well-known/oauth-protected-resource', (c) =>
  oAuthProtectedResourceMetadata(auth)(c.req.raw)
);
// Web-login voor de OAuth-flow (telefoon-OTP in de browser).
app.route('/mcp-login', mcpLoginRoute);

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

  // Activity-tracking: noteer `lastSeenAt` voor DAU/WAU/MAU. Throttled
  // tot 1× per uur per user — bij intense polling-burst niet meer dan
  // één write. Fire-and-forget (geen await) zodat de response-latency
  // niet meebeweegt.
  if (row) {
    const lastSeen = row.lastSeenAt as Date | null;
    const stale =
      !lastSeen || Date.now() - lastSeen.getTime() > 60 * 60 * 1000;
    if (stale) {
      db.update(schema.users)
        .set({ lastSeenAt: new Date() })
        .where(eq(schema.users.id, session.user.id))
        .catch(() => {
          // Throttle-update is non-essentieel — log niet.
        });
    }
  }

  return c.json({ user: row ?? session.user });
});

/**
 * Markeer /new als gezien. Client roept dit aan bij het verlaten van de
 * pagina, náást z'n eigen lokale timestamp.
 *
 * Alleen zinvol voor echte accounts: bij een anonieme gebruiker leeft de
 * identiteit toch op dit ene toestel, en dan voegt een server-kopie
 * niets toe boven de lokale opslag.
 */
app.post('/me/seen-new', async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  await db
    .update(schema.users)
    .set({ lastSeenNewAt: new Date() })
    .where(eq(schema.users.id, session.user.id));
  return c.json({ ok: true });
});

app.patch('/me', async (c) => {
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });
  if (!session) return c.json({ error: 'unauthorized' }, 401);

  const body = (await c.req.json()) as {
    name?: string;
    handle?: string;
    savesVisibility?: 'favorites' | 'friends' | 'private';
    mirrorVisibility?: 'favorites' | 'friends' | 'private';
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

  const VISIBILITIES = ['favorites', 'friends', 'private'] as const;
  if (body.savesVisibility !== undefined) {
    if (!(VISIBILITIES as readonly string[]).includes(body.savesVisibility)) {
      return c.json(
        { error: 'savesVisibility moet "favorites", "friends" of "private" zijn.' },
        400
      );
    }
    updates.savesVisibility = body.savesVisibility;
  }

  if (body.mirrorVisibility !== undefined) {
    if (!(VISIBILITIES as readonly string[]).includes(body.mirrorVisibility)) {
      return c.json(
        { error: 'mirrorVisibility moet "favorites", "friends" of "private" zijn.' },
        400
      );
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
app.route('/artists', artistsRoute);
app.route('/venues', venuesRoute);
app.route('/search', searchRoute);
app.route('/zoek', zoekRoute);
app.route('/mcp', mcpRoute);
app.route('/series', seriesRoute);
app.route('/saves', savesRoute);
app.route('/mirror', mirrorRoute);
app.route('/dismisses', dismissesRoute);
app.route('/social', socialRoute);
app.route('/friends', friendsRoute);
app.route('/users', usersRoute);
app.route('/invites', invitesRoute);
app.route('/invitations', invitationsRoute);
app.route('/groups', groupsRoute);
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
// AI-connector-pagina (`/ai`) — mount vóór shareRoute zodat de slug
// niet als event/venue wordt opgevat.
app.route('/', aiConnectRoute);
// Install-link voor IG-bio / CTA's — `/get` doet UA-detect en
// stuurt door naar App Store / Play Store / web-landing.
app.route('/get', getAppRoute);
app.route('/', shareRoute);

const port = Number(process.env.PORT ?? 8787);
// Op Fly draait de container achter een proxy; bind expliciet op
// 0.0.0.0 zodat het container-network 'm vindt.
serve({ fetch: app.fetch, port, hostname: '0.0.0.0' });
console.log(`andreas-api listening on 0.0.0.0:${port}`);
