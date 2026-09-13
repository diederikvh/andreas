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
import { ShareIntentProvider } from 'expo-share-intent';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as Updates from 'expo-updates';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useIsRegistered } from '@/lib/authClient';
import { useMe } from '@/lib/queries';
import { ModeCurtain } from '@/components/ModeCurtain';
import { PushManager } from '@/components/PushManager';
import { SentryUserBinder } from '@/components/SentryUserBinder';
import { TicketRehome } from '@/components/TicketRehome';
import { ShareImportCapture } from '@/components/ShareImportCapture';
import { ShareInviteClaimer } from '@/components/ShareInviteClaimer';
import { UpdateBanner } from '@/components/UpdateBanner';
import { ZoomLayerProvider } from '@/components/ZoomLayer';
import { InboxToastProvider } from '@/components/InboxToast';
import { InboxNotifier } from '@/components/InboxNotifier';
import { queryClient, queryPersister } from '@/lib/queryClient';
import { useHasHydrated, useMode, useModeStore } from '@/store/mode';
import { useSessionTimestamps } from '@/store/sessionTimestamps';

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
  // Gedeelde content mag het toestel niet verlaten — ook niet als
  // bijlage van een crashreport. `sendDefaultPii: false` dekt dat niet:
  // console-breadcrumbs nemen gewoon over wat er gelogd is, en een
  // OCR-dump of ticketpad is daarmee zo onderweg naar Sentry. Alles wat
  // de import-map of de share-extension noemt gooien we weg.
  beforeBreadcrumb: (breadcrumb) => {
    const haystack = `${breadcrumb.message ?? ''} ${JSON.stringify(breadcrumb.data ?? {})}`;
    if (/\/import\/|dataUrl=|ShareIntent/i.test(haystack)) return null;
    return breadcrumb;
  },
});

SplashScreen.preventAutoHideAsync();

/**
 * Waar de stack begint als de app via een link of een share wordt
 * geopend. Zonder dit is het gedeelde scherm het énige scherm: een sheet
 * heeft dan niets om over te staan en presenteert zich als volle pagina,
 * zonder greepje en zonder ronde hoeken. Met de tabs eronder komt
 * `/import` netjes als drawer over de app, en gaat Sluiten terug naar
 * Vandaag in plaats van naar niets.
 */
export const unstable_settings = { anchor: '(tabs)' };

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

  // Session-grens markeren: eerste keer bij ready (cold launch) en
  // daarna telkens wanneer de app terugkomt uit background. De store
  // beslist zelf of 't lang genoeg geleden is om de previous-timestamp
  // door te schuiven (30min-grens) — anders is 't no-op.
  useEffect(() => {
    if (!ready) return;
    useSessionTimestamps.getState().markLaunch();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') useSessionTimestamps.getState().markLaunch();
    });
    return () => sub.remove();
  }, [ready]);

  // Provider moet altijd gemount zijn zodat z'n hydration kan starten
  // (en de onSuccess `queryCacheRestored` flippen). Pas wanneer alle
  // ready-bronnen binnen zijn renderen we de Stack — anders blijft de
  // SplashScreen staan.
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {/* Moet boven de andere providers staan — de share-extension
          levert z'n payload via de deeplink-URL, en die wil je opvangen
          voordat er iets anders mee gebeurt. */}
      <ShareIntentProvider>
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
                <InboxToastProvider>
                  <Stack screenOptions={{ headerShown: false }}>
                    <Stack.Screen
                      name="event/[id]/invite"
                      options={{ presentation: 'modal' }}
                    />
                    <Stack.Screen
                      name="import"
                      options={{
                        presentation: 'modal',
                      }}
                    />
                  </Stack>
                  <ModeCurtain />
                  <PushManager />
                  <InboxNotifier />
                  <SentryUserBinder />
                  <SeenWindowSync />
                  <ShareInviteClaimer />
                  <ShareImportCapture />
                  <TicketRehome />
                  <UpdateBanner />
                  <StatusBar style={mode === 'nacht' ? 'light' : 'dark'} />
                </InboxToastProvider>
              </ZoomLayerProvider>
            </SafeAreaProvider>
          )}
        </PersistQueryClientProvider>
      </ShareIntentProvider>
    </GestureHandlerRootView>
  );
}

export default Sentry.wrap(RootLayout);

/**
 * Neem het server-venster over zodra `/me` binnen is.
 *
 * Voor ingelogde gebruikers weet de server wanneer je /new voor het
 * laatst bekeek. Op een nieuwe telefoon staat de lokale sessiegrens op
 * "nu" en zou je dus niks gemist hebben; door de oudere serverwaarde
 * over te nemen zie je alsnog alles sinds je laatste bezoek — ook als
 * dat op je vorige toestel was.
 *
 * Alleen naar achteren schuiven, en op `previous` in plaats van op
 * `lastSeenNewAt`, zodat de lijst binnen één sessie stabiel blijft.
 */
function SeenWindowSync() {
  const registered = useIsRegistered();
  const { data: me } = useMe();
  useEffect(() => {
    if (!registered) return;
    useSessionTimestamps.getState().adoptServerSeen(me?.lastSeenNewAt);
  }, [registered, me?.lastSeenNewAt]);
  return null;
}
