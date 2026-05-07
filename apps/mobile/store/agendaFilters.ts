import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { ApiEvent } from '@/lib/api';
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
  activeGenres: string[];
  setQuery: (q: string) => void;
  setOnlyFriends: (next: boolean) => void;
  setOnlyFavorites: (next: boolean) => void;
  setActiveBlocks: (next: TimeBlock[]) => void;
  setActiveCats: (next: ApiEvent['category'][]) => void;
  setActiveGenres: (next: string[]) => void;
  reset: () => void;
};

export const useAgendaFilters = create<AgendaFiltersState>()(
  persist(
    (set) => ({
      query: '',
      onlyFriends: false,
      onlyFavorites: false,
      activeBlocks: [],
      activeCats: [],
      activeGenres: [],
      setQuery: (q) => set({ query: q }),
      setOnlyFriends: (next) => set({ onlyFriends: next }),
      setOnlyFavorites: (next) => set({ onlyFavorites: next }),
      setActiveBlocks: (next) => set({ activeBlocks: next }),
      setActiveCats: (next) => set({ activeCats: next }),
      setActiveGenres: (next) => set({ activeGenres: next }),
      reset: () =>
        set({
          query: '',
          onlyFriends: false,
          onlyFavorites: false,
          activeBlocks: [],
          activeCats: [],
          activeGenres: [],
        }),
    }),
    {
      name: 'andreas:agenda-filters.v1',
      storage: createJSONStorage(() => AsyncStorage),
      version: 1,
    }
  )
);
