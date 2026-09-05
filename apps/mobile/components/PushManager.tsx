import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { useSession } from '@/lib/authClient';
import { useNewArrivals } from '@/lib/queries';
import { useInboxToast } from '@/components/InboxToast';
import {
  Notifications,
  registerForPushNotificationsAsync,
} from '@/lib/push';

/**
 * Niet-renderend hulpcomponent dat zich abonneert op push-events.
 *
 *  - Registreert het Expo-token zodra er een sessie is (idempotent).
 *  - Vangt taps op een notificatie op en navigeert via de `data.url`
 *    payload van de server (bv. `/event/abc?o=xyz`, `/u/handle`).
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
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((res) => {
      const data = res.notification.request.content.data as
        | { url?: string }
        | undefined;
      const url = typeof data?.url === 'string' ? data.url : null;
      if (!url) return;
      // Korte vertraging zodat router-context al geinitialiseerd is
      // wanneer iemand op een notificatie tapt vanuit een koude start.
      setTimeout(() => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          router.push(url as any);
        } catch (err) {
          console.warn('[push] navigate failed', url, err);
        }
      }, 50);
    });
    return () => sub.remove();
  }, []);

  // Getal op het app-icoon: wat er op /new te beoordelen staat.
  //
  // De dagelijkse push zet 'm ook mee, maar iOS wist een badge nooit uit
  // zichzelf — zonder deze sync bleef "97" staan tot je 'm handmatig
  // wegveegde. Hier hangt 'ie aan dezelfde query als de strook op
  // Vandaag, dus hij zakt vanzelf mee terwijl je de lijst afwerkt en
  // staat op nul zodra je klaar bent.
  const { data: arrivals } = useNewArrivals({ enabled: Boolean(userId) });
  const newCount = arrivals?.total ?? 0;
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
