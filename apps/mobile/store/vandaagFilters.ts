import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { ApiEvent, VenueType } from '@/lib/api';
import type { TimeBlock } from '@/lib/eventDisplay';

/**
 * Filter-keuze op de Vandaag-tab — vrienden-toggle + tijd-blokken.
 * Wordt persistent bewaard in AsyncStorage zodat de keuze blijft staan
 * als de gebruiker de tab verlaat en terugkomt, of de app sluit en
 * heropent. Filter beïnvloedt alleen de cat-secties op Vandaag, niet
 * de hero, het featured-artikel, de kaart-banner of de musea-strook.
 */
type VandaagFiltersState = {
  query: string;
  onlyFriends: boolean;
  onlyFavorites: boolean;
  activeBlocks: TimeBlock[];
  activeCats: ApiEvent['category'][];
  activeTypes: VenueType[];
  setQuery: (q: string) => void;
  setOnlyFriends: (next: boolean) => void;
  setOnlyFavorites: (next: boolean) => void;
  setActiveBlocks: (next: TimeBlock[]) => void;
  setActiveCats: (next: ApiEvent['category'][]) => void;
  setActiveTypes: (next: VenueType[]) => void;
  toggleBlock: (b: TimeBlock) => void;
  toggleType: (t: VenueType) => void;
  reset: () => void;
};

export const useVandaagFilters = create<VandaagFiltersState>()(
  persist(
    (set, get) => ({
      query: '',
      onlyFriends: false,
      onlyFavorites: false,
      activeBlocks: [],
      activeCats: [],
      activeTypes: [],
      setQuery: (q) => set({ query: q }),
      setOnlyFriends: (next) => set({ onlyFriends: next }),
      setOnlyFavorites: (next) => set({ onlyFavorites: next }),
      setActiveBlocks: (next) => set({ activeBlocks: next }),
      setActiveCats: (next) => set({ activeCats: next }),
      setActiveTypes: (next) => set({ activeTypes: next }),
      toggleBlock: (b) => {
        const { activeBlocks } = get();
        set({
          activeBlocks: activeBlocks.includes(b)
            ? activeBlocks.filter((x) => x !== b)
            : [...activeBlocks, b],
        });
      },
      toggleType: (t) => {
        const { activeTypes } = get();
        set({
          activeTypes: activeTypes.includes(t)
            ? activeTypes.filter((x) => x !== t)
            : [...activeTypes, t],
        });
      },
      reset: () =>
        set({
          query: '',
          onlyFriends: false,
          onlyFavorites: false,
          activeBlocks: [],
          activeCats: [],
          activeTypes: [],
        }),
    }),
    {
      name: 'andreas:vandaag-filters.v1',
      storage: createJSONStorage(() => AsyncStorage),
      version: 6,
      migrate: (persistedState, version) => {
        // Step-wise migration zodat oude clients schoon optillen.
        // v6: activeGenres dropped — genre-filters zijn weg (zie commit).
        const state = (persistedState ?? {}) as Partial<VandaagFiltersState> & {
          activeGenres?: unknown;
        };
        const out: Partial<VandaagFiltersState> = { ...state };
        if (version < 2) out.onlyFavorites = false;
        if (version < 3) out.query = '';
        if (version < 4) {
          out.activeCats = [];
        }
        if (version < 5) out.activeTypes = [];
        // v6: strip eventueel oude activeGenres uit persisted state
        return {
          query: out.query ?? '',
          onlyFriends: out.onlyFriends ?? false,
          onlyFavorites: out.onlyFavorites ?? false,
          activeBlocks: out.activeBlocks ?? [],
          activeCats: out.activeCats ?? [],
          activeTypes: out.activeTypes ?? [],
        } as VandaagFiltersState;
      },
    }
  )
);
