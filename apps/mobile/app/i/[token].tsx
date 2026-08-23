import { Redirect, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';

import { useIsRegistered, useSession } from '@/lib/authClient';
import { savePendingShareInviteToken } from '@/lib/pendingShareInvite';

/**
 * Universal-link entrypoint voor friend-invite tokens. Server stuurt
 * `https://andreas.amsterdam/i/<token>` → AASA routeert naar de app →
 * deze component vangt 'm op via expo-router.
 *
 * We slaan de token altijd op in AsyncStorage, óók als de user al
 * ingelogd is — de claim-hook in de root-layout vuurt dan kort daarna
 * en handelt de friendship-creatie + toast af. De redirect-richting
 * hangt af van de auth-staat: mét account → /social (waar je je nieuwe
 * vriend ziet), anoniem of uitgelogd → /jij (account aanmaken). Na
 * aanmaken vuurt de claim-hook alsnog.
 */
export default function FriendInviteEntry() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const { isPending } = useSession();
  const registered = useIsRegistered();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!token) return;
    void savePendingShareInviteToken(token).finally(() => setSaved(true));
  }, [token]);

  if (!token) return <Redirect href="/(tabs)/avond" />;
  // Wacht tot zowel session-state bekend is als de token weggeschreven —
  // anders kan een snelle redirect de claim-hook missen.
  if (isPending || !saved) return null;

  // Een vriendschap claimen vraagt een echt account: er moet iemand aan
  // de andere kant staan. Een anonieme sessie telt dus niet — die gaat
  // eerst langs de aanmaak-flow, waarna de claim-hook alsnog vuurt.
  if (registered) return <Redirect href="/social" />;
  return <Redirect href="/jij" />;
}
