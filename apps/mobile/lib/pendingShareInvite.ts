import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useRef } from 'react';

import { useSession } from '@/lib/authClient';
import { claimShareInvite } from '@/lib/api';

/**
 * AsyncStorage-helpers + claim-hook voor share-invite tokens.
 *
 * Flow:
 *   1. Universal-link tap → app opens op /i/[token]
 *   2. Route slaat de token op via {@link savePendingShareInviteToken}
 *      (en redirect naar /jij of /welkom).
 *   3. Zodra de gebruiker ingelogd is, vuurt {@link useClaimPendingShare}
 *      in de root-layout → POST /share-invites/:token/claim → friendship.
 *   4. Token wordt na claim (success of fatale error) gewist.
 */

const KEY = 'andreas:pending-share-invite-token.v1';

export async function savePendingShareInviteToken(token: string): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, token);
  } catch {
    /* niet-fataal — claim valt dan terug op de happy path bij re-tap */
  }
}

export async function readPendingShareInviteToken(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export async function clearPendingShareInviteToken(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    /* swallow */
  }
}

export type PendingShareClaimResult = {
  inviter: {
    id: string;
    name: string | null;
    handle: string | null;
    avatarUrl: string | null;
  };
  friendshipChange: 'created' | 'upgraded' | 'noop';
};

/**
 * Root-layout hook: claimt elke openstaande share-invite-token zodra
 * de gebruiker is ingelogd. `onClaim` wordt aangeroepen met het
 * claim-resultaat zodat de caller een toast/snackbar kan tonen.
 *
 * Idempotent: claimt elke unieke token max één keer per app-launch
 * (via een ref-guard). Faalt stil bij 401/404/410 — die wissen ook
 * de pending-token om scenarios waar de token verlopen is niet
 * eindeloos te herclaimen.
 */
export function useClaimPendingShare(
  onClaim?: (r: PendingShareClaimResult) => void
): void {
  const { data: session } = useSession();
  const isAuthed = Boolean(session?.user?.id);
  const claimedTokensRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!isAuthed) return;
    let cancelled = false;
    void (async () => {
      const token = await readPendingShareInviteToken();
      if (!token) return;
      if (claimedTokensRef.current.has(token)) return;
      claimedTokensRef.current.add(token);
      try {
        const result = await claimShareInvite(token);
        if (cancelled) return;
        await clearPendingShareInviteToken();
        onClaim?.(result);
      } catch {
        // 410 (verlopen) / 404 / 400 → zinloos om opnieuw te proberen,
        // wis de token. 5xx zou je willen retainen, maar in praktijk
        // is een te-vroege wipe minder erg dan eindeloze loops.
        if (!cancelled) await clearPendingShareInviteToken();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAuthed, onClaim]);
}
