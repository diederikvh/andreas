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
import { queryClient, queryPersister } from '@/lib/queryClient';
import { useHasHydrated, useMode } from '@/store/mode';

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
            </Stack>
            <ModeCurtain />
            <PushManager />
            <StatusBar style={mode === 'nacht' ? 'light' : 'dark'} />
          </SafeAreaProvider>
        )}
      </PersistQueryClientProvider>
    </GestureHandlerRootView>
  );
}
