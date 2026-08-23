/**
 * Timestamps voor de "Net binnen"-feature.
 *
 *  - `current`: timestamp van de huidige app-sessie.
 *  - `previous`: timestamp van de vorige sessie. Bij elke launch
 *    waarbij `now - current > 30min` schuift `current → previous` en
 *    `current = now`. Binnen 30min reopens tellen we als dezelfde
 *    sessie (anders zou een korte background-fade direct het venster
 *    resetten).
 *  - `lastSeenNewAt`: timestamp waarop je /new het laatst hebt
 *    bekeken. Wordt geset door `markNewSeen()` (via useFocusEffect op
 *    de /new-route).
 *
 * Twee afnemers, twee verschillende grenzen — bewust ontkoppeld:
 *
 *  - De LIJST op /new ankert op `previous` (de sessie-grens) en blijft
 *    daardoor de hele sessie dezelfde "nieuw sinds je vorige bezoek"-
 *    lijst tonen. Open-en-weer-terug binnen één sessie verandert er
 *    niks aan — `useNewWindowStart()`. Pas een nieuwe sessie (>30min
 *    weg) schuift het venster door.
 *  - De BADGE-teller ankert op `max(previous, lastSeenNewAt)` zodat-ie
 *    naar 0 zakt zodra je de pagina hebt gezien (lastSeenNewAt = nu) en
 *    pas weer oploopt bij écht nieuwe aanwinsten —
 *    `useNewBadgeSince()`. Negeer je /new dan vangt `previous` op zodat
 *    de teller bounded blijft op "sinds vorige sessie".
 *
 * Bij beide grenzen oud (weken weg) zorgt de server-cap (30 dagen)
 * alsnog voor een beheersbare payload.
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
  /**
   * Neem de serverwaarde over als die ouder is dan wat dit toestel
   * weet. Gebeurt één keer per launch, zodra `/me` binnen is.
   *
   * Alleen naar achteren schuiven, nooit naar voren: anders zou een
   * nieuwe telefoon (waar `previous` op nu staat) je venster wegpoetsen
   * in plaats van herstellen. En bewust op `previous` en niet op
   * `lastSeenNewAt`, zodat de sessie-stabiliteit van de lijst intact
   * blijft — binnen één sessie blijft de lijst dezelfde.
   */
  adoptServerSeen: (iso: string | null | undefined) => void;
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
      adoptServerSeen: (iso) => {
        if (!iso) return;
        const ts = Date.parse(iso);
        if (Number.isNaN(ts)) return;
        const { previous, lastSeenNewAt } = get();
        const next: Partial<State> = {};
        if (previous === 0 || ts < previous) next.previous = ts;
        if (lastSeenNewAt === 0 || ts > lastSeenNewAt) next.lastSeenNewAt = ts;
        if (Object.keys(next).length > 0) set(next);
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
 * Venster-grens voor de LIJST op /new. Puur `previous` (de sessie-
 * grens) — dus stabiel voor de hele sessie. Open je /new, stap je weg
 * en kom je terug, dan toont de pagina exact dezelfde lijst; pas een
 * nieuwe sessie (>30min weg) schuift 'm door.
 *
 * Null tot AsyncStorage hydrated en er een echte timestamp beschikbaar
 * is. Bij first-ever-launch staat previous gelijk aan now (zie
 * markLaunch), dus geen historie als "nieuw".
 */
export function useNewWindowStart(): Date | null {
  const previous = useSessionTimestamps((s) => s.previous);
  const hydrated = useSessionTimestamps((s) => s.hydrated);
  if (!hydrated) return null;
  if (previous === 0) return null;
  return new Date(previous);
}

/**
 * `since`-grens voor de BADGE-teller. De NIEUWERE van:
 *   - `previous` (sessie-grens)
 *   - `lastSeenNewAt` (visit-grens)
 *
 * Zakt naar 0 zodra je /new hebt bekeken (lastSeenNewAt = nu) en loopt
 * pas weer op bij echt nieuwe aanwinsten. Null tot hydrated.
 */
export function useNewBadgeSince(): Date | null {
  const previous = useSessionTimestamps((s) => s.previous);
  const lastSeenNewAt = useSessionTimestamps((s) => s.lastSeenNewAt);
  const hydrated = useSessionTimestamps((s) => s.hydrated);
  if (!hydrated) return null;
  const ts = Math.max(previous, lastSeenNewAt);
  if (ts === 0) return null;
  return new Date(ts);
}
