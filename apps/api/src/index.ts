import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import { auth } from './auth.js';
import { eventsRoute } from './routes/events.js';
import { venuesRoute } from './routes/venues.js';

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

app.route('/events', eventsRoute);
app.route('/venues', venuesRoute);

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`andreas-api listening on :${port}`);
