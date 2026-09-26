/**
 * Spotify koppelen: wie je volgt en wie je het meest luistert, in één keer
 * volgen in Andreas.
 *
 *   POST /spotify/start     — de inlog-URL bij Spotify (met jou in `state`)
 *   GET  /spotify/callback  — Spotify stuurt je hierheen; wij halen de
 *                             artiesten op, volgen ze en sturen je terug
 *                             naar de app (`andreas://spotify-import`)
 *
 * Eenmalig: de sleutel die Spotify ons geeft gebruiken we voor deze twee
 * vragen en gooien we daarna weg. Geen opgeslagen toegang tot iemands
 * Spotify.
 *
 * `state` is ondertekend (HMAC met het auth-geheim) en tien minuten
 * geldig, zodat niemand anders een import op jouw account kan starten.
 *
 * Let op: de Spotify-app staat in development mode. Alleen wie in het
 * Spotify-dashboard is toegevoegd (max 25) kan koppelen; de rest krijgt
 * van Spotify een 403, en dat melden we netjes.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import { Hono } from 'hono';

import { auth } from '../auth.js';
import { followArtistByName } from './artist-follows.js';

export const spotifyImportRoute = new Hono();

const API_BASE = 'https://api.andreas.amsterdam';
const REDIRECT_URI = `${API_BASE}/spotify/callback`;
const APP_RETURN = 'andreas://spotify-import';
const SCOPES = 'user-follow-read user-top-read';
const STATE_TTL_MS = 10 * 60_000;
/** Genoeg voor wie veel volgt, zonder dat een import minuten duurt. */
const MAX_ARTISTS = 300;

const sign = (payload: string) =>
  createHmac('sha256', process.env.BETTER_AUTH_SECRET ?? '').update(payload).digest('base64url');

function makeState(userId: string): string {
  const payload = `${userId}.${Date.now()}`;
  return Buffer.from(`${payload}.${sign(payload)}`).toString('base64url');
}

function readState(state: string): string | null {
  const [userId, ts, mac] = Buffer.from(state, 'base64url').toString().split('.');
  if (!userId || !ts || !mac) return null;
  const want = Buffer.from(sign(`${userId}.${ts}`));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  if (Date.now() - Number(ts) > STATE_TTL_MS) return null;
  return userId;
}

const back = (params: Record<string, string | number>) =>
  `${APP_RETURN}?${new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]))}`;

spotifyImportRoute.post('/start', async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  if (!clientId) return c.json({ error: 'Spotify is niet ingesteld.' }, 503);
  const url = new URL('https://accounts.spotify.com/authorize');
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state: makeState(session.user.id),
  }).toString();
  return c.json({ url: url.toString(), returnUrl: APP_RETURN });
});

type SpotifyArtist = { name: string; external_urls?: { spotify?: string } };

spotifyImportRoute.get('/callback', async (c) => {
  const userId = readState(c.req.query('state') ?? '');
  if (!userId) return c.redirect(back({ error: 'verlopen' }));
  const code = c.req.query('code');
  // Geweigerd in het Spotify-scherm.
  if (!code) return c.redirect(back({ error: 'geweigerd' }));

  const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      Authorization:
        'Basic ' +
        Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64'),
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
  });
  if (!tokenRes.ok) return c.redirect(back({ error: 'spotify' }));
  const { access_token } = (await tokenRes.json()) as { access_token?: string };
  if (!access_token) return c.redirect(back({ error: 'spotify' }));
  const headers = { Authorization: `Bearer ${access_token}` };

  const found = new Map<string, SpotifyArtist>();
  const add = (a: SpotifyArtist) => {
    const key = a.name.trim().toLowerCase();
    if (key && !found.has(key)) found.set(key, a);
  };

  // Wie je volgt: gepagineerd met een cursor.
  let next: string | null = 'https://api.spotify.com/v1/me/following?type=artist&limit=50';
  while (next && found.size < MAX_ARTISTS) {
    const r = await fetch(next, { headers });
    // 403: niet toegevoegd aan de development-app.
    if (r.status === 403) return c.redirect(back({ error: 'geen-toegang' }));
    if (!r.ok) break;
    const data = (await r.json()) as { artists?: { items?: SpotifyArtist[]; next?: string | null } };
    for (const a of data.artists?.items ?? []) add(a);
    next = data.artists?.next ?? null;
  }
  // Wie je het meest luistert, het afgelopen half jaar.
  const top = await fetch('https://api.spotify.com/v1/me/top/artists?limit=50&time_range=medium_term', { headers });
  if (top.ok) {
    const data = (await top.json()) as { items?: SpotifyArtist[] };
    for (const a of data.items ?? []) add(a);
  }

  let added = 0;
  for (const a of [...found.values()].slice(0, MAX_ARTISTS)) {
    const id = await followArtistByName(userId, a.name.trim(), a.external_urls?.spotify);
    if (id) added++;
  }
  return c.redirect(back({ added }));
});
