import * as Sentry from '@sentry/react-native';
import { useEffect } from 'react';

import { useSession } from '@/lib/authClient';
import { useMe } from '@/lib/queries';

export function SentryUserBinder() {
  const { data: session } = useSession();
  const { data: me } = useMe();
  const userId = session?.user?.id ?? null;
  const handle = me?.handle ?? null;

  useEffect(() => {
    if (!userId) {
      Sentry.setUser(null);
      return;
    }
    Sentry.setUser({ id: userId, username: handle ?? undefined });
  }, [userId, handle]);

  return null;
}
