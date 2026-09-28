/**
 * Spotify koppelen: wie je volgt en wie je het meest luistert, volgen in
 * Andreas, en daarna elke nacht bijhouden.
 *
 *   POST   /spotify/start     — de inlog-URL bij Spotify (met jou in `state`)
 *   GET    /spotify/callback  — Spotify stuurt je hierheen; wij bewaren de
 *                               koppeling, volgen de artiesten en sturen je
 *                               terug naar de app (`andreas://spotify-import`)
 *   GET    /spotify/status    — gekoppeld? wanneer bijgewerkt?
 *   DELETE /spotify           — ontkoppelen (de sleutel gaat weg)
 *
 * We bewaren de refresh-token van Spotify, versleuteld, zodat de nachtelijke
 * klus (`syncSpotifyLinks`) nieuwe artiesten kan oppikken. Wie we al eens
 * overnamen staat in `seen`: ontvolg je iemand in Andreas, dan zetten we die
 * niet terug.
 *
 * `state` is ondertekend (HMAC met het auth-geheim) en tien minuten
 * geldig, zodat niemand anders een import op jouw account kan starten.
 *
 * Let op: de Spotify-app staat in development mode. Alleen wie in het
 * Spotify-dashboard is toegevoegd (max 25) kan koppelen; de rest krijgt
 * van Spotify een 403, en dat melden we netjes.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { Hono } from 'hono';

import { auth } from '../auth.js';
import { db } from '../db/index.js';
import { followArtistByName, relink } from './artist-follows.js';

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

/** De refresh-token versleuteld opslaan: AES-256-GCM met een sleutel
    afgeleid van het auth-geheim. Lekt de database, dan lekt de toegang tot
    iemands Spotify niet mee. */
const tokenKey = () => createHash('sha256').update(`${process.env.BETTER_AUTH_SECRET ?? ''}:spotify`).digest();
function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', tokenKey(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}
function decrypt(blob: string): string {
  const [iv, tag, enc] = blob.split('.').map((p) => Buffer.from(p, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', tokenKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

type SpotifyArtist = { name: string; external_urls?: { spotify?: string } };

const basic = () =>
  'Basic ' + Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');

async function token(body: Record<string, string>): Promise<{ access_token?: string; refresh_token?: string } | null> {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', Authorization: basic() },
    body: new URLSearchParams(body),
  });
  return r.ok ? ((await r.json()) as { access_token?: string; refresh_token?: string }) : null;
}

/** Wie je volgt (tot MAX_ARTISTS) en je top 50 van het afgelopen half jaar.
    `'forbidden'` als je niet op de testlijst van de development-app staat. */
async function fetchArtists(accessToken: string): Promise<SpotifyArtist[] | 'forbidden'> {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const found = new Map<string, SpotifyArtist>();
  const add = (a: SpotifyArtist) => {
    const key = a.name.trim().toLowerCase();
    if (key && !found.has(key)) found.set(key, a);
  };
  let next: string | null = 'https://api.spotify.com/v1/me/following?type=artist&limit=50';
  while (next && found.size < MAX_ARTISTS) {
    const r = await fetch(next, { headers });
    if (r.status === 403) return 'forbidden';
    if (!r.ok) break;
    const data = (await r.json()) as { artists?: { items?: SpotifyArtist[]; next?: string | null } };
    for (const a of data.artists?.items ?? []) add(a);
    next = data.artists?.next ?? null;
  }
  const top = await fetch('https://api.spotify.com/v1/me/top/artists?limit=50&time_range=medium_term', { headers });
  if (top.ok) {
    const data = (await top.json()) as { items?: SpotifyArtist[] };
    for (const a of data.items ?? []) add(a);
  }
  return [...found.values()].slice(0, MAX_ARTISTS);
}

/** Volg wie we nog niet eerder van Spotify overnamen. Geeft het aantal
    nieuwe en de bijgewerkte lijst van overgenomen namen terug. */
async function followNew(userId: string, artists: SpotifyArtist[], seen: string[]) {
  const known = new Set(seen);
  let added = 0;
  for (const a of artists) {
    const key = a.name.trim().toLowerCase();
    if (known.has(key)) continue;
    if (await followArtistByName(userId, a.name.trim(), a.external_urls?.spotify, 'spotify')) added++;
    known.add(key);
  }
  return { added, seen: [...known] };
}

spotifyImportRoute.get('/callback', async (c) => {
  const userId = readState(c.req.query('state') ?? '');
  if (!userId) return c.redirect(back({ error: 'verlopen' }));
  const code = c.req.query('code');
  // Geweigerd in het Spotify-scherm.
  if (!code) return c.redirect(back({ error: 'geweigerd' }));

  const t = await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
  if (!t?.access_token) return c.redirect(back({ error: 'spotify' }));
  const artists = await fetchArtists(t.access_token);
  if (artists === 'forbidden') return c.redirect(back({ error: 'geen-toegang' }));

  // Opnieuw koppelen: wie we al eens overnamen blijft overgenomen.
  const [prev] = (
    await db.execute<{ seen: string[] }>(sql`SELECT seen FROM spotify_links WHERE user_id = ${userId}`)
  ).rows;
  const { added, seen } = await followNew(userId, artists, prev?.seen ?? []);
  if (t.refresh_token) {
    await db.execute(sql`
      INSERT INTO spotify_links (user_id, refresh_token_enc, seen, last_sync_at, last_added)
      VALUES (${userId}, ${encrypt(t.refresh_token)}, ${JSON.stringify(seen)}::jsonb, NOW(), ${added})
      ON CONFLICT (user_id) DO UPDATE SET
        refresh_token_enc = EXCLUDED.refresh_token_enc, seen = EXCLUDED.seen,
        last_sync_at = NOW(), last_added = EXCLUDED.last_added
    `);
  }
  if (added > 0) relink();
  return c.redirect(back({ added }));
});

spotifyImportRoute.get('/status', async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  const [row] = (
    await db.execute<{ connected_at: string; last_sync_at: string | null; last_added: number; n: number }>(sql`
      SELECT connected_at, last_sync_at, last_added, jsonb_array_length(seen)::int AS n
      FROM spotify_links WHERE user_id = ${session.user.id}`)
  ).rows;
  return c.json(
    row
      ? { connected: true, connectedAt: row.connected_at, lastSyncAt: row.last_sync_at, lastAdded: row.last_added, artists: row.n }
      : { connected: false }
  );
});

spotifyImportRoute.delete('/', async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  // Alleen de koppeling; wie je volgt blijft je volgen.
  await db.execute(sql`DELETE FROM spotify_links WHERE user_id = ${session.user.id}`);
  return c.json({ connected: false });
});

/**
 * De nachtelijke ronde: per koppeling een nieuwe toegangssleutel, en volgen
 * wie er op Spotify bij kwam. Een ingetrokken koppeling (de gebruiker haalde
 * Andreas weg bij Spotify) ruimen we op.
 */
export async function syncSpotifyLinks(): Promise<{ users: number; added: number; dropped: number }> {
  const links = (
    await db.execute<{ user_id: string; refresh_token_enc: string; seen: string[] }>(
      sql`SELECT user_id, refresh_token_enc, seen FROM spotify_links`
    )
  ).rows;
  let added = 0;
  let dropped = 0;
  for (const l of links) {
    let refresh: string;
    try {
      refresh = decrypt(l.refresh_token_enc);
    } catch {
      continue;
    }
    const t = await token({ grant_type: 'refresh_token', refresh_token: refresh });
    if (!t?.access_token) {
      // Ingetrokken of verlopen: weg met de koppeling, dan toont de app weer de knop.
      await db.execute(sql`DELETE FROM spotify_links WHERE user_id = ${l.user_id}`);
      dropped++;
      continue;
    }
    const artists = await fetchArtists(t.access_token);
    if (artists === 'forbidden') continue;
    const r = await followNew(l.user_id, artists, l.seen ?? []);
    added += r.added;
    await db.execute(sql`
      UPDATE spotify_links SET seen = ${JSON.stringify(r.seen)}::jsonb, last_sync_at = NOW(), last_added = ${r.added}
        ${t.refresh_token ? sql`, refresh_token_enc = ${encrypt(t.refresh_token)}` : sql``}
      WHERE user_id = ${l.user_id}
    `);
    // Rustig aan: dezelfde app-sleutel als de zoek in de app.
    await new Promise((x) => setTimeout(x, 500));
  }
  if (added > 0) relink();
  return { users: links.length, added, dropped };
}
