import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { ApiEvent, VenueType } from '@/lib/api';
import type { TimeBlock } from '@/lib/eventDisplay';

/**
 * Filter-keuze op de Agenda-tab — wordt persistent bewaard zodat de
 * gebruiker door de app heen kan en zijn voorkeuren actief blijven.
 * Eerder zaten deze filters in URL-params; dat ging verloren bij
 * tab-wissels.
 */
type AgendaFiltersState = {
  query: string;
  onlyFriends: boolean;
  onlyFavorites: boolean;
  activeBlocks: TimeBlock[];
  activeCats: ApiEvent['category'][];
  activeTypes: VenueType[];
  activeGenres: string[];
  setQuery: (q: string) => void;
  setOnlyFriends: (next: boolean) => void;
  setOnlyFavorites: (next: boolean) => void;
  setActiveBlocks: (next: TimeBlock[]) => void;
  setActiveCats: (next: ApiEvent['category'][]) => void;
  setActiveTypes: (next: VenueType[]) => void;
  setActiveGenres: (next: string[]) => void;
  toggleType: (t: VenueType) => void;
  reset: () => void;
};

export const useAgendaFilters = create<AgendaFiltersState>()(
  persist(
    (set, get) => ({
      query: '',
      onlyFriends: false,
      onlyFavorites: false,
      activeBlocks: [],
      activeCats: [],
      activeTypes: [],
      activeGenres: [],
      setQuery: (q) => set({ query: q }),
      setOnlyFriends: (next) => set({ onlyFriends: next }),
      setOnlyFavorites: (next) => set({ onlyFavorites: next }),
      setActiveBlocks: (next) => set({ activeBlocks: next }),
      setActiveCats: (next) => set({ activeCats: next }),
      setActiveTypes: (next) => set({ activeTypes: next }),
      setActiveGenres: (next) => set({ activeGenres: next }),
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
          activeGenres: [],
        }),
    }),
    {
      name: 'andreas:agenda-filters.v1',
      storage: createJSONStorage(() => AsyncStorage),
      version: 2,
      migrate: (persistedState, version) => {
        const state = (persistedState ?? {}) as Partial<AgendaFiltersState>;
        const out: Partial<AgendaFiltersState> = { ...state };
        if (version < 2) out.activeTypes = [];
        return {
          query: out.query ?? '',
          onlyFriends: out.onlyFriends ?? false,
          onlyFavorites: out.onlyFavorites ?? false,
          activeBlocks: out.activeBlocks ?? [],
          activeCats: out.activeCats ?? [],
          activeTypes: out.activeTypes ?? [],
          activeGenres: out.activeGenres ?? [],
        } as AgendaFiltersState;
      },
    }
  )
);
