import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { VenueDayNight, VenueScene, VenueType } from '@/lib/api';

/**
 * Filter-keuze op de Venues-tab — wordt persistent bewaard zodat de
 * gebruiker door de app heen kan en zijn voorkeuren actief blijven.
 * Eerder zaten deze in URL-params; dat ging verloren bij tab-wissels.
 */
type VenuesFiltersState = {
  query: string;
  activeDn: VenueDayNight[];
  activeType: VenueType[];
  activeScene: VenueScene[];
  activeSubtypes: string[];
  onlyVolgend: boolean;
  setQuery: (q: string) => void;
  setActiveDn: (next: VenueDayNight[]) => void;
  setActiveType: (next: VenueType[]) => void;
  setActiveScene: (next: VenueScene[]) => void;
  setActiveSubtypes: (next: string[]) => void;
  setOnlyVolgend: (next: boolean) => void;
  reset: () => void;
};

export const useVenuesFilters = create<VenuesFiltersState>()(
  persist(
    (set) => ({
      query: '',
      activeDn: [],
      activeType: [],
      activeScene: [],
      activeSubtypes: [],
      onlyVolgend: false,
      setQuery: (q) => set({ query: q }),
      setActiveDn: (next) => set({ activeDn: next }),
      setActiveType: (next) => set({ activeType: next }),
      setActiveScene: (next) => set({ activeScene: next }),
      setActiveSubtypes: (next) => set({ activeSubtypes: next }),
      setOnlyVolgend: (next) => set({ onlyVolgend: next }),
      reset: () =>
        set({
          query: '',
          activeDn: [],
          activeType: [],
          activeScene: [],
          activeSubtypes: [],
          onlyVolgend: false,
        }),
    }),
    {
      name: 'andreas:venues-filters.v1',
      storage: createJSONStorage(() => AsyncStorage),
      version: 1,
    }
  )
);
