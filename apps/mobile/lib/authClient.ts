import { expoClient } from '@better-auth/expo/client';
import { phoneNumberClient } from 'better-auth/client/plugins';
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
  ],
});

export const { useSession, signOut } = authClient;
