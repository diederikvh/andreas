import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { TimeBlock } from '@/lib/eventDisplay';

/**
 * Filter-keuze op de Vandaag-tab — vrienden-toggle + tijd-blokken.
 * Wordt persistent bewaard in AsyncStorage zodat de keuze blijft staan
 * als de gebruiker de tab verlaat en terugkomt, of de app sluit en
 * heropent. Filter beïnvloedt alleen de cat-secties op Vandaag, niet
 * de hero, het featured-artikel, de kaart-banner of de musea-strook.
 */
type VandaagFiltersState = {
  onlyFriends: boolean;
  activeBlocks: TimeBlock[];
  setOnlyFriends: (next: boolean) => void;
  toggleBlock: (b: TimeBlock) => void;
  reset: () => void;
};

export const useVandaagFilters = create<VandaagFiltersState>()(
  persist(
    (set, get) => ({
      onlyFriends: false,
      activeBlocks: [],
      setOnlyFriends: (next) => set({ onlyFriends: next }),
      toggleBlock: (b) => {
        const { activeBlocks } = get();
        set({
          activeBlocks: activeBlocks.includes(b)
            ? activeBlocks.filter((x) => x !== b)
            : [...activeBlocks, b],
        });
      },
      reset: () => set({ onlyFriends: false, activeBlocks: [] }),
    }),
    {
      name: 'andreas:vandaag-filters.v1',
      storage: createJSONStorage(() => AsyncStorage),
      version: 1,
    }
  )
);
