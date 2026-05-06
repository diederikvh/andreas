import { router } from 'expo-router';
import { useEffect, useRef } from 'react';

import { useSession } from '@/lib/authClient';
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
  const { data: session } = useSession();
  const userId = session?.user?.id ?? null;
  const lastTriedUserId = useRef<string | null>(null);

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

  return null;
}
