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
import * as Sentry from '@sentry/react-native';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { isRunningInExpoGo } from 'expo';
import Constants from 'expo-constants';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as Updates from 'expo-updates';
import { useEffect, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModeCurtain } from '@/components/ModeCurtain';
import { PushManager } from '@/components/PushManager';
import { SentryUserBinder } from '@/components/SentryUserBinder';
import { ShareInviteClaimer } from '@/components/ShareInviteClaimer';
import { UpdateBanner } from '@/components/UpdateBanner';
import { ZoomLayerProvider } from '@/components/ZoomLayer';
import { queryClient, queryPersister } from '@/lib/queryClient';
import { useContentModeStore } from '@/store/contentMode';
import { useHasHydrated, useMode, useModeStore } from '@/store/mode';

// Sentry — fire-and-forget init bij module-load. DSN is een
// public secret (key in DSN identificeert het project, niet de auth).
// `dist` = de huidige OTA-bundle (updateId); release = native build
// version. Zo zie je per crash exact welke JS-bundle het was.
Sentry.init({
  dsn: 'https://9b2b50e3dd3fc32f338de3e82a5b359d@o4507032745607168.ingest.de.sentry.io/4511404724650064',
  enabled: !isRunningInExpoGo(),
  environment: __DEV__ ? 'development' : 'production',
  release: Constants.expoConfig?.version ?? '0.0.0',
  dist: Updates.updateId ?? undefined,
  tracesSampleRate: 0.05,
  sendDefaultPii: false,
});

SplashScreen.preventAutoHideAsync();

function RootLayout() {
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
            <ZoomLayerProvider>
              <Stack screenOptions={{ headerShown: false }}>
                <Stack.Screen
                  name="event/[id]/invite"
                  options={{ presentation: 'modal' }}
                />
              </Stack>
              <ModeCurtain />
              <PushManager />
              <SentryUserBinder />
              <ShareInviteClaimer />
              <UpdateBanner />
              <StatusBar style={mode === 'nacht' ? 'light' : 'dark'} />
            </ZoomLayerProvider>
          </SafeAreaProvider>
        )}
      </PersistQueryClientProvider>
    </GestureHandlerRootView>
  );
}

export default Sentry.wrap(RootLayout);
