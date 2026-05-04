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
  /** Alleen venues die de gebruiker volgt (myFollowState === 'volgen'). */
  vo: boolean;
  q: string;
  createdAt: number;
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
    vo: boolean;
    q: string;
  }
): boolean {
  return (
    s.vo === current.vo &&
    s.q === current.q &&
    sameSet(s.dn, current.dn) &&
    sameSet(s.type, current.type) &&
    sameSet(s.sc, current.sc)
  );
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const v of b) if (!sa.has(v)) return false;
  return true;
}
