import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { ApiEvent } from '@/lib/api';
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
    gn: string[];
    q: string;
  }
): boolean {
  return (
    s.q === current.q &&
    sameSet(s.cats, current.cats) &&
    sameSet(s.tb, current.tb) &&
    sameSet(s.gn, current.gn)
  );
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const v of b) if (!sa.has(v)) return false;
  return true;
}
