import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { useSession } from '@/lib/authClient';
import { useNewArrivalsSince } from '@/lib/queries';
import {
  isBootDone,
  setPendingDeepLink,
} from '@/lib/pendingDeepLink';
import { useNewBadgeSince } from '@/store/sessionTimestamps';
import { useInboxToast } from '@/components/InboxToast';
import {
  Notifications,
  registerForPushNotificationsAsync,
} from '@/lib/push';

/** Welke tikken we al hebben afgehandeld. Module-scope, want de
    listener en `getLastNotificationResponseAsync` leveren dezelfde tik
    soms beide aan. */
const handledTaps = new Set<string>();

/**
 * Niet-renderend hulpcomponent dat zich abonneert op push-events.
 *
 *  - Registreert het Expo-token zodra er een sessie is (idempotent).
 *  - Vangt taps op een notificatie op en navigeert via de `data.url`
 *    payload van de server (bv. `/event/abc?o=xyz`, `/u/handle`).
 *
 * Bij een koude start navigeert dit component níet zelf: dan legt het de
 * bestemming neer via `setPendingDeepLink` en pakt de startflow 'm op.
 * Zie `lib/pendingDeepLink.ts` -- anders overschrijft de splash je
 * bestemming een seconde later met de homepage.
 *
 * Mounten in `_layout.tsx` op één plek zodat permissies maar één keer
 * gevraagd worden en handlers globaal actief zijn.
 */
export function PushManager() {
  const qc = useQueryClient();
  const { data: session } = useSession();
  const userId = session?.user?.id ?? null;
  const lastTriedUserId = useRef<string | null>(null);
  const { showToast } = useInboxToast();

  // Registreer bij login. Bij wisseling van user (bv. logout + login)
  // opnieuw aanvragen. Bij logout is er niets actief op te ruimen —
  // de server unregistert via de logout-flow.
  useEffect(() => {
    if (!userId) {
      lastTriedUserId.current = null;
      return;
    }
    if (lastTriedUserId.current === userId) return;
    lastTriedUserId.current = userId;
    void registerForPushNotificationsAsync();
  }, [userId]);

  // Tap-handler. We luisteren altijd, ook zonder sessie — een tap
  // kan binnenkomen vlak voordat session-state geresolved is.
  //
  // Twee bronnen, want een listener alleen is niet genoeg. Startte de
  // app juist dóór jouw tik, dan is die tik al gebeurd voordat dit
  // component bestond en krijgt de listener 'm nooit -- daarvoor is
  // `getLastNotificationResponseAsync`. Dat was de echte reden dat elke
  // ochtendmelding op de homepage uitkwam. Beide wegen lopen langs
  // dezelfde afhandeling, met de identifier als sleutel zodat één tik
  // niet twee keer navigeert.
  useEffect(() => {
    let alive = true;

    const handle = (res: {
      notification: {
        request: { identifier: string; content: { data?: unknown } };
      };
    }) => {
      const id = res.notification.request.identifier;
      if (handledTaps.has(id)) return;
      const data = res.notification.request.content.data as
        | { url?: string }
        | undefined;
      const url = typeof data?.url === 'string' ? data.url : null;
      if (!url) return;
      handledTaps.add(id);
      // Loopt de startflow nog? Dan legt de bestemming zichzelf neer en
      // navigeert die flow er straks heen. Zelf pushen verliest het van
      // de `replace('/avond')` die na de splash volgt.
      if (!isBootDone()) {
        setPendingDeepLink(url);
        return;
      }
      // Korte vertraging zodat router-context al geinitialiseerd is.
      setTimeout(() => {
        try {
          router.push(url as any);
        } catch (err) {
          console.warn('[push] navigate failed', url, err);
        }
      }, 50);
    };

    void Notifications.getLastNotificationResponseAsync()
      .then((res) => {
        if (alive && res) handle(res);
      })
      .catch(() => {
        // Geen laatste respons is de normale situatie, geen fout.
      });

    const sub = Notifications.addNotificationResponseReceivedListener(handle);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  // Getal op het app-icoon: wat er bij is gekomen sinds je /new zag.
  //
  // De dagelijkse push zet 'm mee, maar iOS wist een badge nooit uit
  // zichzelf — zonder deze sync bleef het getal staan tot je 'm
  // handmatig wegveegde.
  //
  // Bewust `useNewBadgeSince` en niet het venster van de lijst zelf. Dat
  // laatste is de sessiegrens en die schuift pas na een half uur weg;
  // het icoon bleef daardoor een getal tonen terwijl je de pagina net
  // open had gehad. Deze grens neemt ook je bezoek aan /new mee, dus
  // kijken is genoeg om 'm op nul te zetten.
  const badgeSince = useNewBadgeSince();
  const { data: arrivals } = useNewArrivalsSince(badgeSince, {
    enabled: Boolean(userId),
  });
  const newCount = badgeSince ? (arrivals?.total ?? 0) : 0;
  useEffect(() => {
    if (!userId) return;
    void Notifications.setBadgeCountAsync(newCount).catch(() => {
      // Sommige Android-launchers kennen geen badge. Geen ramp, geen log.
    });
  }, [userId, newCount]);

  // Inbox-cache fris houden. Triggers:
  //  - binnengekomen push (foreground of background)
  //  - app komt terug uit achtergrond ('active')
  // De queries zelf hebben staleTime: 0 + refetchOnMount: 'always',
  // dus elke remount fetcht ook. Hiermee dekken we ook het geval dat
  // de gebruiker de app open laat staan en iemand anders intussen
  // een verzoek stuurt.
  useEffect(() => {
    const invalidate = () => {
      qc.invalidateQueries({ queryKey: ['friend-requests'] });
      qc.invalidateQueries({ queryKey: ['invitations'] });
      qc.invalidateQueries({ queryKey: ['groups'] });
    };
    const pushSub = Notifications.addNotificationReceivedListener((n) => {
      invalidate();
      // Toon óók een in-app banner — als de app open is voor de server-
      // push komt iOS/Android default niet met een banner over je
      // huidige scherm. Eigen overlay zorgt dat een binnenkomend
      // friend-verzoek of invite ook bij actief gebruik opvalt.
      const content = n.request.content;
      const data = content.data as { url?: unknown } | undefined;
      showToast({
        title: content.title ?? '',
        body: content.body ?? '',
        url: typeof data?.url === 'string' ? data.url : null,
      });
    });
    const appSub = AppState.addEventListener('change', (next) => {
      if (next === 'active') invalidate();
    });
    return () => {
      pushSub.remove();
      appSub.remove();
    };
  }, [qc, showToast]);

  return null;
}
