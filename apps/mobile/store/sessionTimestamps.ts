/**
 * Session-grens tracking voor de "Nieuw binnen"-feature.
 *
 *  - `current`: timestamp van de huidige app-sessie.
 *  - `previous`: timestamp van de vorige sessie.
 *
 * Op elke launch waarbij `now - current > 30min` schuift `current →
 * previous` en `current = now`. Binnen 30min reopens tellen we als
 * dezelfde sessie (anders zou een korte background-fade direct het
 * venster resetten).
 *
 * `previous` is wat we als `since`-parameter naar /events/new sturen.
 * Eerste-ooit-launch: beide op now, dus 0 nieuwe items (default).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

const SESSION_BOUNDARY_MS = 30 * 60 * 1000;

type State = {
  current: number;
  previous: number;
  hydrated: boolean;
  markLaunch: () => void;
};

export const useSessionTimestamps = create<State>()(
  persist(
    (set, get) => ({
      current: 0,
      previous: 0,
      hydrated: false,
      markLaunch: () => {
        const { current } = get();
        const now = Date.now();
        if (current === 0) {
          // Eerste keer ooit — beide op now zodat we niet meteen weken
          // aan oude events als "nieuw" markeren.
          set({ current: now, previous: now });
          return;
        }
        if (now - current > SESSION_BOUNDARY_MS) {
          set({ previous: current, current: now });
        }
      },
    }),
    {
      name: 'andreas-session-timestamps-v1',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ current: s.current, previous: s.previous }),
      onRehydrateStorage: () => (state) => {
        if (state) state.hydrated = true;
      },
    }
  )
);

export function useLastSessionTimestamp(): Date | null {
  const previous = useSessionTimestamps((s) => s.previous);
  const hydrated = useSessionTimestamps((s) => s.hydrated);
  if (!hydrated) return null;
  if (previous === 0) return null;
  return new Date(previous);
}
