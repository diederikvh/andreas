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
 * Android-AsyncStorage gebruikt SQLite onder de motorkap met een
 * CursorWindow van ~2MB per rij. Bij ~2k events groeit de query-cache
 * makkelijk over die limiet en faalt het lézen met
 * "Row too big to fit into CursorWindow". Daarom splitsen we de
 * gepersisteerde JSON in chunks van 1MB, opgeslagen onder eigen keys
 * `${baseKey}::N` plus een `::head` met de totaal-telling. iOS heeft
 * deze limiet niet; daar is 't simpelweg extra round-trips.
 */
const CHUNK_SIZE = 1_000_000;

const chunkedStorage = {
  async getItem(key: string): Promise<string | null> {
    const head = await AsyncStorage.getItem(`${key}::head`);
    if (!head) return null;
    let meta: { chunks: number };
    try {
      meta = JSON.parse(head);
    } catch {
      return null;
    }
    const parts: string[] = [];
    for (let i = 0; i < meta.chunks; i++) {
      const part = await AsyncStorage.getItem(`${key}::${i}`);
      if (part == null) return null;
      parts.push(part);
    }
    return parts.join('');
  },
  async setItem(key: string, value: string): Promise<void> {
    const chunks: string[] = [];
    for (let i = 0; i < value.length; i += CHUNK_SIZE) {
      chunks.push(value.slice(i, i + CHUNK_SIZE));
    }
    // Verwijder een eventueel langere voorgaande staart (oude write
    // had meer chunks dan deze) — anders blijven die orphan in storage.
    const oldHead = await AsyncStorage.getItem(`${key}::head`);
    if (oldHead) {
      try {
        const meta = JSON.parse(oldHead) as { chunks: number };
        if (meta.chunks > chunks.length) {
          const stale = Array.from(
            { length: meta.chunks - chunks.length },
            (_, i) => `${key}::${chunks.length + i}`
          );
          await AsyncStorage.multiRemove(stale);
        }
      } catch {
        /* ignore corrupt head */
      }
    }
    // Schrijf alle chunks parallel, daarna de head als 'commit'-marker
    // (zodat een partial-write nooit als geldig wordt gelezen).
    await Promise.all(
      chunks.map((c, i) => AsyncStorage.setItem(`${key}::${i}`, c))
    );
    await AsyncStorage.setItem(
      `${key}::head`,
      JSON.stringify({ chunks: chunks.length })
    );
  },
  async removeItem(key: string): Promise<void> {
    const head = await AsyncStorage.getItem(`${key}::head`);
    if (!head) return;
    try {
      const meta = JSON.parse(head) as { chunks: number };
      const keys = [
        `${key}::head`,
        ...Array.from({ length: meta.chunks }, (_, i) => `${key}::${i}`),
      ];
      await AsyncStorage.multiRemove(keys);
    } catch {
      await AsyncStorage.removeItem(`${key}::head`);
    }
  },
};

/**
 * Persister op basis van chunked-AsyncStorage (zie comment hierboven).
 * Bumpt naar v2 zodat oude v1-rijen (die op Android nu een
 * CursorWindow-error gooien) niet meer worden gelezen — die blijven
 * als orphan in storage hangen maar veroorzaken geen crash meer.
 *
 * Gebruikt door `<PersistQueryClientProvider>` in `app/_layout.tsx`.
 */
export const queryPersister = createAsyncStoragePersister({
  storage: chunkedStorage,
  key: 'andreas:react-query-cache.v2',
  // Throttle hoe vaak we naar disk schrijven — anders bij snelle
  // refetches/invalidaties wordt elke mutatie direct gepersisteerd
  // wat onnodig schijfwerk + GC oplevert.
  throttleTime: 1_000,
});
