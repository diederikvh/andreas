import { Hono } from 'hono';

import { APP_STORE_URL, PLAY_STORE_URL, PUBLIC_BASE_URL } from './_seo.js';

/**
 * Smart install-link voor de IG-bio en andere "download de app"-CTA's.
 * Eén korte URL — andreas.amsterdam/get — detecteert de User-Agent en
 * stuurt door naar de juiste store:
 *
 *   iOS   → APP_STORE_URL  (env, fallback in _seo.ts)
 *   Android → PLAY_STORE_URL (env, fallback in _seo.ts)
 *   desktop → PUBLIC_BASE_URL (de web-landing)
 *
 * Dezelfde constants als _seo.ts gebruikt voor JSON-LD/OG, zodat alle
 * "naar de app"-links in de codebase één bron van waarheid hebben.
 */
export const getAppRoute = new Hono();

getAppRoute.get('/', (c) => {
  const ua = c.req.header('user-agent') || '';
  const isIOS = /iPhone|iPad|iPod/.test(ua);
  // "Android" verschijnt soms in iPad-UA's via Chrome desktop-mode;
  // iOS-check eerst voorkomt foute redirects.
  const isAndroid = /Android/.test(ua) && !isIOS;

  if (isIOS) return c.redirect(APP_STORE_URL, 302);
  if (isAndroid) return c.redirect(PLAY_STORE_URL, 302);
  return c.redirect(PUBLIC_BASE_URL, 302);
});
