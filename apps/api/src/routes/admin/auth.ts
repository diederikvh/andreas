import { createHash, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

/**
 * Eén-user superadmin auth. Twee paden:
 *
 * 1. **Webview** — wachtwoord-formulier zet een httpOnly cookie met
 *    `sha256(ADMIN_PASSWORD)`. Elke request hasht het env var opnieuw
 *    en vergelijkt timing-safe. Cookie roteert dus automatisch als je
 *    `ADMIN_PASSWORD` op Fly wisselt — alle bestaande sessies vallen
 *    om en je moet opnieuw inloggen.
 *
 * 2. **API** — `Authorization: Bearer <ADMIN_API_KEY>` voor n8n.
 *    Geen cookie, geen sessie — bedoeld voor server-to-server.
 *
 * Beide secrets staan in Fly secrets (apps/api/.env voor lokaal dev).
 * Geen 2FA, geen rate-limit (één user, low-risk).
 */

const COOKIE_NAME = 'andreas_admin';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 dagen

function passwordHash(password: string): string {
  return createHash('sha256').update(password).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function expectedSessionToken(): string | null {
  const pwd = process.env.ADMIN_PASSWORD;
  if (!pwd) return null;
  return passwordHash(pwd);
}

export function checkPassword(input: string): boolean {
  const pwd = process.env.ADMIN_PASSWORD;
  if (!pwd) return false;
  return safeEqual(input, pwd);
}

export function setSessionCookie(c: Context): void {
  const token = expectedSessionToken();
  if (!token) return;
  const isProd = process.env.NODE_ENV === 'production';
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'Lax',
    path: '/admin',
    maxAge: COOKIE_MAX_AGE,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, COOKIE_NAME, { path: '/admin' });
}

export function isAuthedByCookie(c: Context): boolean {
  const token = getCookie(c, COOKIE_NAME);
  const expected = expectedSessionToken();
  if (!token || !expected) return false;
  return safeEqual(token, expected);
}

export function isAuthedByBearer(c: Context): boolean {
  const key = process.env.ADMIN_API_KEY;
  if (!key) return false;
  const auth = c.req.header('authorization') ?? '';
  if (!auth.toLowerCase().startsWith('bearer ')) return false;
  return safeEqual(auth.slice(7).trim(), key);
}

/** Middleware voor HTML-routes — redirect naar /admin/login bij geen cookie. */
export const requireAdminCookie: MiddlewareHandler = async (c, next) => {
  if (isAuthedByCookie(c)) return next();
  return c.redirect('/admin/login');
};

/** Middleware voor JSON-routes — 401 bij geen cookie of bearer. */
export const requireAdminAny: MiddlewareHandler = async (c, next) => {
  if (isAuthedByCookie(c) || isAuthedByBearer(c)) return next();
  return c.json({ error: 'unauthorized' }, 401);
};
