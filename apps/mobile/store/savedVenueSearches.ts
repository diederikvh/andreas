import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { VenueDayNight, VenueScene, VenueType } from '@/lib/api';

/**
 * Een opgeslagen Venues-filter — combinatie van dayNight, type, scene,
 * follow-toggle en zoekterm. Lokaal bewaard (AsyncStorage); zelfde
 * patroon als de Agenda-saved-searches.
 */
export type SavedVenueSearch = {
  id: string;
  name: string;
  dn: VenueDayNight[];
  type: VenueType[];
  sc: VenueScene[];
  /** Multi-select sub-type tags (vrije strings: techno, queer, arthouse, …).
      Backwards-compat: oude saved-venue-searches hadden dit veld nog
      niet — persist-migrate vult 'm met []. */
  st: string[];
  /** Alleen venues die de gebruiker volgt (myFollowState === 'volgen'). */
  vo: boolean;
  q: string;
  createdAt: number;
};

type LegacySavedVenueSearch = SavedVenueSearch & {
  st?: string[];
};

type SavedVenueSearchesState = {
  searches: SavedVenueSearch[];
  add: (entry: Omit<SavedVenueSearch, 'id' | 'createdAt'>) => SavedVenueSearch;
  remove: (id: string) => void;
};

export const useSavedVenueSearchesStore = create<SavedVenueSearchesState>()(
  persist(
    (set) => ({
      searches: [],
      add: (entry) => {
        const item: SavedVenueSearch = {
          ...entry,
          id: `vss-${Date.now().toString(36)}-${Math.random()
            .toString(36)
            .slice(2, 6)}`,
          createdAt: Date.now(),
        };
        set((s) => ({ searches: [item, ...s.searches] }));
        return item;
      },
      remove: (id) =>
        set((s) => ({ searches: s.searches.filter((x) => x.id !== id) })),
    }),
    {
      name: 'andreas:saved-venue-searches.v1',
      storage: createJSONStorage(() => AsyncStorage),
      version: 2,
      migrate: (persistedState: unknown, version: number) => {
        // v1 had geen `st` veld; v2 wel. Vul op [] zodat de Venues-tab
        // nooit crashed op `s.st.length` bij rehydratie.
        const state = persistedState as { searches?: LegacySavedVenueSearch[] };
        if (!state || !Array.isArray(state.searches)) {
          return { searches: [] };
        }
        if (version < 2) {
          state.searches = state.searches.map((s) => ({
            ...s,
            st: Array.isArray(s.st) ? s.st : [],
          }));
        }
        return state as SavedVenueSearchesState;
      },
    }
  )
);

export const useSavedVenueSearches = () =>
  useSavedVenueSearchesStore((s) => s.searches);
export const useAddSavedVenueSearch = () =>
  useSavedVenueSearchesStore((s) => s.add);
export const useRemoveSavedVenueSearch = () =>
  useSavedVenueSearchesStore((s) => s.remove);

export function isSavedVenueSearchActive(
  s: SavedVenueSearch,
  current: {
    dn: VenueDayNight[];
    type: VenueType[];
    sc: VenueScene[];
    st: string[];
    vo: boolean;
    q: string;
  }
): boolean {
  return (
    s.vo === current.vo &&
    s.q === current.q &&
    sameSet(s.dn, current.dn) &&
    sameSet(s.type, current.type) &&
    sameSet(s.sc, current.sc) &&
    sameSet(s.st, current.st)
  );
}

// Defensive: oude persisted searches kunnen ontbrekende velden hebben.
function sameSet(
  a: string[] | undefined,
  b: string[] | undefined
): boolean {
  const aa = a ?? [];
  const bb = b ?? [];
  if (aa.length !== bb.length) return false;
  const sa = new Set(aa);
  for (const v of bb) if (!sa.has(v)) return false;
  return true;
}
