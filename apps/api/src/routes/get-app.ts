import { Hono } from 'hono';

/**
 * Smart install-link voor de IG-bio en andere "download de app"-CTA's.
 * Eén korte URL — andreas.amsterdam/get — detecteert de User-Agent en
 * stuurt door naar de juiste store:
 *
 *   iOS  → APP_INSTALL_IOS env-var (TestFlight of App Store URL)
 *   Android → APP_INSTALL_ANDROID env-var (Play Store URL)
 *   anders / niet-gezet → publieke web-landing op andreas.amsterdam
 *
 * Beide env-vars zijn optioneel: als 't store-listing nog niet live
 * is, laat je 'm leeg en valt de mobiele bezoeker terug op de
 * web-versie. Dat is netter dan een 404 in de App Store.
 *
 * Aparte env-vars (i.p.v. de bestaande APP_STORE_URL / PLAY_STORE_URL
 * die _seo.ts gebruikt voor JSON-LD) zodat we hier expliciet kunnen
 * sturen op "is de install-flow al klaar". Een SEO-link mag wel
 * placeholder zijn, een redirect echt niet.
 */
export const getAppRoute = new Hono();

const FALLBACK_WEB = process.env.PUBLIC_BASE_URL ?? 'https://andreas.amsterdam';

getAppRoute.get('/', (c) => {
  const ua = c.req.header('user-agent') || '';
  const isIOS = /iPhone|iPad|iPod/.test(ua);
  // "Android" verschijnt ook in iPad-UA's met Chrome desktop-mode,
  // maar in de praktijk testen we eerst iOS dus geen botsing.
  const isAndroid = /Android/.test(ua) && !isIOS;

  if (isIOS) {
    const iosUrl = process.env.APP_INSTALL_IOS;
    if (iosUrl) return c.redirect(iosUrl, 302);
  } else if (isAndroid) {
    const androidUrl = process.env.APP_INSTALL_ANDROID;
    if (androidUrl) return c.redirect(androidUrl, 302);
  }
  return c.redirect(FALLBACK_WEB, 302);
});
