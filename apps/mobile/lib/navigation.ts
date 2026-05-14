import { router } from 'expo-router';

/**
 * Veilige back-navigatie voor schermen die zowel via de in-app stack
 * als via een externe universal-link (WhatsApp, mail, browser) kunnen
 * worden geopend. Zonder back-stack zou `router.back()` no-op'pen en
 * de gebruiker vast laten zitten op het detail-scherm.
 *
 * `/avond` is de hoofd-tab voor returning users (de start-flow op `/`
 * is alleen voor nieuwe gebruikers); replace zodat een nieuwe back-tap
 * dan ook niets meer doet i.p.v. terug naar het deeplink-detail.
 */
export function safeBack(): void {
  if (router.canGoBack()) router.back();
  else router.replace('/avond');
}
