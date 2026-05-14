import { Redirect, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';

import { useSession } from '@/lib/authClient';
import { savePendingShareInviteToken } from '@/lib/pendingShareInvite';

/**
 * Universal-link entrypoint voor friend-invite tokens. Server stuurt
 * `https://andreas.amsterdam/i/<token>` → AASA routeert naar de app →
 * deze component vangt 'm op via expo-router.
 *
 * We slaan de token altijd op in AsyncStorage, óók als de user al
 * ingelogd is — de claim-hook in de root-layout vuurt dan kort daarna
 * en handelt de friendship-creatie + toast af. De redirect-richting
 * hangt af van de auth-staat: ingelogd → /social (waar je je nieuwe
 * vriend ziet), niet-ingelogd → /welkom (login-flow). Na login vuurt
 * de claim-hook alsnog.
 */
export default function FriendInviteEntry() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const { data: session, isPending } = useSession();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!token) return;
    void savePendingShareInviteToken(token).finally(() => setSaved(true));
  }, [token]);

  if (!token) return <Redirect href="/(tabs)/avond" />;
  // Wacht tot zowel session-state bekend is als de token weggeschreven —
  // anders kan een snelle redirect de claim-hook missen.
  if (isPending || !saved) return null;

  const authed = Boolean(session?.user?.id);
  if (authed) return <Redirect href="/(tabs)/social" />;
  return <Redirect href="/welkom" />;
}
