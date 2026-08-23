import { router } from 'expo-router';
import { useCallback } from 'react';
import { Alert } from 'react-native';

import {
  useClaimPendingShare,
  type PendingShareClaimResult,
} from '@/lib/pendingShareInvite';

/**
 * Root-layout component die elke openstaande share-invite-token
 * claimt zodra de gebruiker ingelogd is. Toont een Alert met
 * "Je bent nu vrienden met X" en biedt een knop om naar het
 * profiel van de nieuwe vriend te springen.
 *
 * Rendert niets visueel — alleen de hook draait.
 */
export function ShareInviteClaimer() {
  const onClaim = useCallback(
    (result: PendingShareClaimResult) => {
      if (result.friendshipChange === 'noop') return;
      const display =
        result.inviter.name && !result.inviter.name.startsWith('+')
          ? result.inviter.name
          : result.inviter.handle
            ? `@${result.inviter.handle}`
            : 'jouw nieuwe vriend';
      Alert.alert(
        'Nieuwe vriend',
        `Je bent nu vrienden met ${display}.`,
        [
          { text: 'Later', style: 'cancel' },
          {
            text: 'Bekijk',
            onPress: () => router.push('/social' as never),
          },
        ],
        { cancelable: true }
      );
    },
    []
  );

  useClaimPendingShare(onClaim);
  return null;
}
