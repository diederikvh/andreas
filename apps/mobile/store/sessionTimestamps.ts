/**
 * Timestamps voor de "Net binnen"-feature.
 *
 *  - `current`: timestamp van de huidige app-sessie.
 *  - `previous`: timestamp van de vorige sessie. Bij elke launch
 *    waarbij `now - current > 30min` schuift `current → previous` en
 *    `current = now`. Binnen 30min reopens tellen we als dezelfde
 *    sessie (anders zou een korte background-fade direct het venster
 *    resetten).
 *  - `lastSeenNewAt`: timestamp waarop je /new daadwerkelijk hebt
 *    geopend. Wordt geset door `markNewSeen()` (via useFocusEffect op
 *    de /new-route).
 *
 * De `since`-grens die we naar de API sturen is het MAXIMUM van
 * `previous` en `lastSeenNewAt`:
 *
 *  - Open je /new dagelijks → lastSeenNewAt is recent → badge telt
 *    alleen dingen sinds jouw laatste bezoek aan de pagina.
 *  - Negeer je /new → lastSeenNewAt veroudert, maar de sessie-grens
 *    `previous` vangt op → badge blijft bounded op "sinds vorige
 *    sessie" — geen runaway-getal.
 *  - Beide oud (weken weg geweest) → server-cap (30 dagen) zorgt
 *    alsnog voor een beheersbare payload.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

const SESSION_BOUNDARY_MS = 30 * 60 * 1000;

type State = {
  current: number;
  previous: number;
  lastSeenNewAt: number;
  hydrated: boolean;
  markLaunch: () => void;
  markNewSeen: () => void;
};

export const useSessionTimestamps = create<State>()(
  persist(
    (set, get) => ({
      current: 0,
      previous: 0,
      lastSeenNewAt: 0,
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
      markNewSeen: () => {
        set({ lastSeenNewAt: Date.now() });
      },
    }),
    {
      name: 'andreas-session-timestamps-v1',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({
        current: s.current,
        previous: s.previous,
        lastSeenNewAt: s.lastSeenNewAt,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) state.hydrated = true;
      },
    }
  )
);

/**
 * `since`-grens voor de /events/new query. De NEUWERE van:
 *   - `previous` (sessie-grens)
 *   - `lastSeenNewAt` (visit-grens)
 *
 * Null tot AsyncStorage hydrated en er een echte timestamp beschikbaar
 * is. Bij first-ever-launch staat previous gelijk aan now (zie
 * markLaunch), dus geen historie als "nieuw".
 */
export function useLastSessionTimestamp(): Date | null {
  const previous = useSessionTimestamps((s) => s.previous);
  const lastSeenNewAt = useSessionTimestamps((s) => s.lastSeenNewAt);
  const hydrated = useSessionTimestamps((s) => s.hydrated);
  if (!hydrated) return null;
  const ts = Math.max(previous, lastSeenNewAt);
  if (ts === 0) return null;
  return new Date(ts);
}
