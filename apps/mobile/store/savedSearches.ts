import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { ApiEvent, VenueType } from '@/lib/api';
import type { TimeBlock } from '@/lib/eventDisplay';

/**
 * Een opgeslagen Agenda-filter — combinatie van categorie, tijdsblokken,
 * genres en zoekterm. Wordt lokaal bewaard (AsyncStorage); geen
 * cross-device sync in v1.
 */
export type SavedSearch = {
  id: string;
  name: string;
  /** Multi-select categorieën. Backwards-compat: oude saved-searches
      hadden `cat: ApiEvent['category'] | null` — die worden bij het
      lezen geconverteerd naar één-element array of leeg. */
  cats: ApiEvent['category'][];
  tb: TimeBlock[];
  /** Venue-types (podium/club/galerie/...). Optioneel — oude saves
      zonder vt zijn equivalent aan een lege array. */
  vt: VenueType[];
  gn: string[];
  q: string;
  /** Unix-ms — voor sortering: nieuwste eerst. */
  createdAt: number;
};

type SavedSearchesState = {
  searches: SavedSearch[];
  add: (entry: Omit<SavedSearch, 'id' | 'createdAt'>) => SavedSearch;
  remove: (id: string) => void;
};

type LegacySavedSearch = SavedSearch & {
  cat?: ApiEvent['category'] | null;
  cats?: ApiEvent['category'][];
};

export const useSavedSearchesStore = create<SavedSearchesState>()(
  persist(
    (set) => ({
      searches: [],
      add: (entry) => {
        const item: SavedSearch = {
          ...entry,
          id: `ss-${Date.now().toString(36)}-${Math.random()
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
      name: 'andreas:saved-searches.v1',
      storage: createJSONStorage(() => AsyncStorage),
      version: 3,
      migrate: (persistedState: unknown, version: number) => {
        // Schema v1 had `cat: ApiEvent['category'] | null`; v2 heeft
        // `cats: ApiEvent['category'][]`. v3 voegde `vt` toe (venue-
        // types). Convert oude rijen ipv ze te droppen — anders zou
        // een gebruiker bij app-update z'n saved searches verliezen,
        // en (kritischer) crashed de Agenda op `s.cats.length` als
        // de oude shape live blijft.
        const state = persistedState as { searches?: LegacySavedSearch[] };
        if (!state || !Array.isArray(state.searches)) {
          return { searches: [] };
        }
        if (version < 2) {
          state.searches = state.searches.map((s) => ({
            ...s,
            cats: Array.isArray(s.cats)
              ? s.cats
              : s.cat
                ? [s.cat]
                : [],
          }));
        }
        if (version < 3) {
          state.searches = state.searches.map((s) => ({
            ...s,
            vt: Array.isArray(s.vt) ? s.vt : [],
          }));
        }
        return state as SavedSearchesState;
      },
    }
  )
);

export const useSavedSearches = () =>
  useSavedSearchesStore((s) => s.searches);
export const useAddSavedSearch = () => useSavedSearchesStore((s) => s.add);
export const useRemoveSavedSearch = () =>
  useSavedSearchesStore((s) => s.remove);

/**
 * Vergelijkt een opgeslagen filter met de huidige Agenda-state. Wordt
 * gebruikt om de "actieve" save te markeren in de chip-row.
 */
export function isSavedSearchActive(
  s: SavedSearch,
  current: {
    cats: ApiEvent['category'][];
    tb: TimeBlock[];
    vt: VenueType[];
    gn: string[];
    q: string;
  }
): boolean {
  return (
    s.q === current.q &&
    sameSet(s.cats, current.cats) &&
    sameSet(s.tb, current.tb) &&
    sameSet(s.vt, current.vt) &&
    sameSet(s.gn, current.gn)
  );
}

// Defensive: oude persisted searches kunnen ontbrekende velden hebben
// (cats nieuw v2, oude shape had cat). Behandel undefined als leeg-
// array zodat de Agenda nooit crashed bij een mismatch in storage.
function sameSet(a: string[] | undefined, b: string[] | undefined): boolean {
  const aa = a ?? [];
  const bb = b ?? [];
  if (aa.length !== bb.length) return false;
  const sa = new Set(aa);
  for (const v of bb) if (!sa.has(v)) return false;
  return true;
}
