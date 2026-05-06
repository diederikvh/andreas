import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { ApiEvent } from '@/lib/api';
import type { TimeBlock } from '@/lib/eventDisplay';

/**
 * Een opgeslagen Vandaag-filter — combinatie van zoekterm, vrienden-
 * toggle, favorieten-toggle en tijd-blokken. Lokaal bewaard
 * (AsyncStorage). Eigen store los van de Agenda-saved-searches zodat
 * de twee schermen onafhankelijk hun eigen filter-bookmarks hebben.
 */
export type SavedVandaagSearch = {
  id: string;
  name: string;
  q: string;
  vr: boolean;
  fv: boolean;
  tb: TimeBlock[];
  cats: ApiEvent['category'][];
  gn: string[];
  createdAt: number;
};

type SavedVandaagSearchesState = {
  searches: SavedVandaagSearch[];
  add: (entry: Omit<SavedVandaagSearch, 'id' | 'createdAt'>) => SavedVandaagSearch;
  remove: (id: string) => void;
};

export const useSavedVandaagSearchesStore = create<SavedVandaagSearchesState>()(
  persist(
    (set) => ({
      searches: [],
      add: (entry) => {
        const item: SavedVandaagSearch = {
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
      name: 'andreas:saved-vandaag-searches.v1',
      storage: createJSONStorage(() => AsyncStorage),
      version: 2,
      migrate: (persistedState: unknown, version: number) => {
        // v1 had geen cats/gn — vul met lege arrays zodat
        // isSavedVandaagSearchActive niet crashed op s.cats.length.
        const state = persistedState as { searches?: SavedVandaagSearch[] };
        if (!state || !Array.isArray(state.searches)) {
          return { searches: [] };
        }
        if (version < 2) {
          state.searches = state.searches.map((s) => ({
            ...s,
            cats: Array.isArray(s.cats) ? s.cats : [],
            gn: Array.isArray(s.gn) ? s.gn : [],
          }));
        }
        return state as SavedVandaagSearchesState;
      },
    }
  )
);

export const useSavedVandaagSearches = () =>
  useSavedVandaagSearchesStore((s) => s.searches);
export const useAddSavedVandaagSearch = () =>
  useSavedVandaagSearchesStore((s) => s.add);
export const useRemoveSavedVandaagSearch = () =>
  useSavedVandaagSearchesStore((s) => s.remove);

/** Markeer een opgeslagen filter als actief wanneer 't matcht met de
 *  huidige Vandaag-state. */
export function isSavedVandaagSearchActive(
  s: SavedVandaagSearch,
  current: {
    q: string;
    vr: boolean;
    fv: boolean;
    tb: TimeBlock[];
    cats: ApiEvent['category'][];
    gn: string[];
  }
): boolean {
  return (
    s.q === current.q &&
    s.vr === current.vr &&
    s.fv === current.fv &&
    sameSet(s.tb, current.tb) &&
    sameSet(s.cats, current.cats) &&
    sameSet(s.gn, current.gn)
  );
}

function sameSet(a: string[] | undefined, b: string[] | undefined): boolean {
  const aa = a ?? [];
  const bb = b ?? [];
  if (aa.length !== bb.length) return false;
  const sa = new Set(aa);
  for (const v of bb) if (!sa.has(v)) return false;
  return true;
}
