import { router, usePathname } from 'expo-router';
import { useShareIntentContext } from 'expo-share-intent';
import { useEffect } from 'react';

import {
  normalizeShareIntent,
  pruneImportDir,
  usePendingShare,
} from '@/lib/pendingShare';

/**
 * Vangt content die via de native share-sheet binnenkomt en zet hem in de
 * pending-share store, daarna naar `/import`.
 *
 * Waarom via de store en niet rechtstreeks vanuit de context in het
 * scherm: `ShareIntentProvider` reset zichzelf zodra de app naar de
 * achtergrond gaat (`resetOnBackground`). Zou `/import` uit de context
 * lezen, dan valt het scherm leeg bij de eerste app-switch — precies wat
 * je doet als je even terug naar Instagram gaat om te checken wat je nou
 * eigenlijk deelde. De store is de eigenaar van de payload, de provider
 * alleen de postbode.
 *
 * Hangt naast `<ShareInviteClaimer />` in de root-layout, dus pas gemount
 * als fonts en stores gehydrateerd zijn. Bij een cold start heeft
 * `+native-intent.ts` de gebruiker dan al naar `/import` gestuurd; dat
 * scherm wacht netjes tot de payload er staat.
 *
 * Ruimt daarnaast de import-map op: alles behalve het bestand van de
 * huidige share. Dat gebeurt pas als `isReady` van de provider aangeeft
 * dat duidelijk is óf er een share binnenkomt — eerder zou de prune het
 * bestand kunnen wissen dat net is gekopieerd.
 */
export function ShareImportCapture() {
  const { isReady, hasShareIntent, shareIntent, resetShareIntent } =
    useShareIntentContext();
  const pathname = usePathname();

  useEffect(() => {
    if (!isReady) return;
    if (hasShareIntent) {
      const pending = normalizeShareIntent(shareIntent);
      // Altijd resetten, ook bij een payload die we niet snappen — anders
      // blijft dezelfde share bij elke app-focus opnieuw binnenkomen.
      resetShareIntent();
      if (pending) {
        usePendingShare.getState().setPending(pending);
        if (pathname !== '/import') router.push('/import');
      }
    }
    pruneImportDir(usePendingShare.getState().pending?.fileUri ?? null);
  }, [isReady, hasShareIntent, shareIntent, resetShareIntent, pathname]);

  return null;
}
