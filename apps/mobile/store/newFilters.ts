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
  /**
   * Hoeveel je op dit toestel hebt beoordeeld. Bewust lokaal geteld en
   * niet van de server: de melding die hierop hangt gaat er juist over
   * dát dit alleen op deze telefoon staat.
   */
  ratedCount: number;
  bumpRated: () => void;
  /** Melding weggetikt? Dan komt 'ie niet meer terug. */
  nudgeDismissed: boolean;
  dismissNudge: () => void;
};

/** Vanaf hoeveel oordelen we één keer melden dat 't lokaal staat. Laag
    genoeg om binnen een paar dagen te halen, hoog genoeg dat je al iets
    te verliezen hebt. */
export const TASTE_NUDGE_THRESHOLD = 20;

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
      ratedCount: 0,
      bumpRated: () => set({ ratedCount: get().ratedCount + 1 }),
      nudgeDismissed: false,
      dismissNudge: () => set({ nudgeDismissed: true }),
    }),
    {
      name: 'andreas:new-filters.v1',
      storage: createJSONStorage(() => AsyncStorage),
      version: 2,
    }
  )
);
