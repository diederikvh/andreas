import { expoClient } from '@better-auth/expo/client';
import {
  anonymousClient,
  phoneNumberClient,
} from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import * as SecureStore from 'expo-secure-store';

const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8787';

/**
 * better-auth client voor de Expo-app. Sessie wordt veilig opgeslagen
 * via expo-secure-store; cookies worden door de expoClient-plugin
 * vertaald naar bearer tokens zodat fetch in RN ze ook draagt.
 */
export const authClient = createAuthClient({
  baseURL: BASE_URL,
  plugins: [
    expoClient({
      scheme: 'andreas',
      storagePrefix: 'andreas',
      storage: SecureStore,
    }),
    phoneNumberClient(),
    anonymousClient(),
  ],
});

export const { useSession, signOut } = authClient;

/**
 * Heeft deze gebruiker een échte identiteit, of draait 'ie anoniem?
 *
 * Sinds anoniem-eerst is `session` bijna altijd gevuld — bij eerste
 * start loggen we stil anoniem in zodat saves, dismisses en push ergens
 * aan kunnen hangen. `Boolean(session)` betekent dus niet meer "heeft
 * een account". Alles wat een naam, handle of andere mensen nodig heeft
 * moet hierop checken, niet op de sessie.
 */
export function useIsRegistered(): boolean {
  const { data: session } = useSession();
  const user = session?.user as
    | { id?: string; isAnonymous?: boolean }
    | undefined;
  return Boolean(user?.id) && user?.isAnonymous !== true;
}

/**
 * Zorg dat er een sessie is. Doet niets als er al één is (anoniem of
 * echt). Faalt stil: zonder netwerk bij eerste start heeft de app nog
 * geen identiteit, en dan is een lege lijst beter dan een blokkade —
 * de volgende start probeert het gewoon opnieuw.
 */
export async function ensureAnonymousSession(): Promise<void> {
  try {
    const { data } = await authClient.getSession();
    if (data?.session) return;
    await authClient.signIn.anonymous();
  } catch {
    // stil: zie doc-comment
  }
}
