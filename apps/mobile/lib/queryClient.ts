import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient } from '@tanstack/react-query';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';

/**
 * Single QueryClient voor de hele app. Mounted in `app/_layout.tsx`
 * via PersistQueryClientProvider zodat de cache app-restarts overleeft
 * en je bij heropenen van de app direct de oude data ziet (instant
 * render) met op de achtergrond een verse refetch.
 *
 * Defaults:
 *  - staleTime 5 min: balans tussen verse data en niet-overspoelen
 *    van het netwerk. Schermen die scherper willen (Vandaag bij focus)
 *    forceren expliciet via `refetchOnWindowFocus: true`.
 *  - gcTime 7 dagen: cache wordt niet uit memory gegooid tijdens een
 *    sessie en blijft persistable (persister kan alleen queries op-
 *    slaan die nog binnen gcTime zitten).
 *  - retry 1: korte hapering geeft niet meteen een error.
 *  - refetchOnReconnect en refetchOnMount: standaard, zodat verse
 *    data binnenkomt zodra je weer online bent of een scherm opent.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60_000,
      gcTime: 7 * 24 * 60 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

/**
 * Persister op basis van AsyncStorage — dezelfde storage als de
 * zustand-stores gebruiken. AsyncStorage heeft een 6MB-limiet per key
 * op Android; bij ~2k events × ~500B = ~1MB JSON, ruim voldoende.
 *
 * Gebruikt door `<PersistQueryClientProvider>` in `app/_layout.tsx`.
 */
export const queryPersister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: 'andreas:react-query-cache.v1',
  // Throttle hoe vaak we naar disk schrijven — anders bij snelle
  // refetches/invalidaties wordt elke mutatie direct gepersisteerd
  // wat onnodig schijfwerk + GC oplevert.
  throttleTime: 1_000,
});
