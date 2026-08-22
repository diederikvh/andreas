import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { Lane } from '@/lib/api';

/**
 * Welke banen wil je op /new zien? Dit is geen sessie-filter maar een
 * voorkeur: wie nooit naar theater gaat wil dat ook morgen niet in z'n
 * dagelijkse lijst. Vandaar persist — in tegenstelling tot de
 * Agenda-filters, die juist resetten als je de tab verlaat.
 *
 * Leeg = alles. Zelfde conventie als `activeCats`/`activeTypes` elders,
 * zodat "niks aangeklikt" nooit een lege lijst oplevert.
 */
type NewFiltersState = {
  activeLanes: Lane[];
  toggleLane: (lane: Lane) => void;
  reset: () => void;
};

export const useNewFilters = create<NewFiltersState>()(
  persist(
    (set, get) => ({
      activeLanes: [],
      toggleLane: (lane) => {
        const { activeLanes } = get();
        set({
          activeLanes: activeLanes.includes(lane)
            ? activeLanes.filter((l) => l !== lane)
            : [...activeLanes, lane],
        });
      },
      reset: () => set({ activeLanes: [] }),
    }),
    {
      name: 'andreas:new-filters.v1',
      storage: createJSONStorage(() => AsyncStorage),
      version: 1,
    }
  )
);
