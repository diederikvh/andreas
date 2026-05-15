import '../global.css';

import {
  Archivo_400Regular,
  Archivo_500Medium,
  Archivo_700Bold,
  Archivo_800ExtraBold,
  Archivo_900Black,
  useFonts,
} from '@expo-google-fonts/archivo';
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
} from '@expo-google-fonts/jetbrains-mono';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModeCurtain } from '@/components/ModeCurtain';
import { PushManager } from '@/components/PushManager';
import { ShareInviteClaimer } from '@/components/ShareInviteClaimer';
import { UpdateBanner } from '@/components/UpdateBanner';
import { queryClient, queryPersister } from '@/lib/queryClient';
import { useContentModeStore } from '@/store/contentMode';
import { useHasHydrated, useMode, useModeStore } from '@/store/mode';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Archivo_400Regular,
    Archivo_500Medium,
    Archivo_700Bold,
    Archivo_800ExtraBold,
    Archivo_900Black,
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
  });
  const hasHydrated = useHasHydrated();
  const mode = useMode();
  const [queryCacheRestored, setQueryCacheRestored] = useState(false);

  const ready =
    (fontsLoaded || fontError !== null) && hasHydrated && queryCacheRestored;

  useEffect(() => {
    if (ready) {
      SplashScreen.hideAsync();
    }
  }, [ready]);

  // Content-mode en visuele mode zijn 1-op-1 gekoppeld: 'uit'⇄'nacht',
  // 'expo'⇄'dag'. Bij oude installs kunnen ze uit-sync zijn (de
  // dn-switch was eerder onafhankelijk). Reconcile bij hydratie:
  // visual-mode volgt content-mode (geen curtain animation, silent).
  useEffect(() => {
    if (!ready) return;
    const cmode = useContentModeStore.getState().mode;
    const visual = useModeStore.getState().mode;
    const expected = cmode === 'uit' ? 'nacht' : 'dag';
    if (visual !== expected) {
      useModeStore.getState().setMode(expected);
    }
  }, [ready]);

  // Provider moet altijd gemount zijn zodat z'n hydration kan starten
  // (en de onSuccess `queryCacheRestored` flippen). Pas wanneer alle
  // ready-bronnen binnen zijn renderen we de Stack — anders blijft de
  // SplashScreen staan.
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <PersistQueryClientProvider
        client={queryClient}
        onSuccess={() => setQueryCacheRestored(true)}
        persistOptions={{
          persister: queryPersister,
          // Bump deze key wanneer de query-shape kapot-changed (bv.
          // ApiEvent.venue.type added) — zo gooi je oude cache weg
          // bij upgrade en voorkom je client-side parse-fouten.
          buster: 'v2-venue-type',
          // Persist alleen succesvolle queries (geen error-states).
          dehydrateOptions: {
            shouldDehydrateQuery: (q) => q.state.status === 'success',
          },
        }}
      >
        {ready && (
          <SafeAreaProvider>
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen
                name="welkom"
                options={{ presentation: 'modal' }}
              />
              <Stack.Screen
                name="event/[id]/invite"
                options={{ presentation: 'modal' }}
              />
              <Stack.Screen
                name="jij"
                options={{ presentation: 'modal' }}
              />
            </Stack>
            <ModeCurtain />
            <PushManager />
            <ShareInviteClaimer />
            <UpdateBanner />
            <StatusBar style={mode === 'nacht' ? 'light' : 'dark'} />
          </SafeAreaProvider>
        )}
      </PersistQueryClientProvider>
    </GestureHandlerRootView>
  );
}
