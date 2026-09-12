import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { VenueMemory } from '@/lib/importMatch';

/**
 * Wat de import leerde van jouw handmatige koppelingen.
 *
 * Koppel je een ticket zelf aan een event omdat wij het niet vonden, dan
 * onthouden we welke onleesbare regel bij welke zaal hoort — zie
 * {@link learnFromPick} in `lib/importMatch.ts` voor het waarom. Het
 * volgende kaartje van diezelfde zaal wordt daardoor wél herkend.
 *
 * Blijft lokaal, net als de tickets zelf: dit is jouw leeswijzer, niet een
 * database die we vullen.
 */
type State = {
  venues: VenueMemory;
  remember: (key: string, venue: string) => void;
};

/** Meer dan dit aantal zalen bezoek je niet met een onleesbaar kaartje.
    Vol? Dan valt de oudste eruit — sleutels staan op invoegvolgorde. */
const MAX = 50;

export const useImportLearnings = create<State>()(
  persist(
    (set) => ({
      venues: {},
      remember: (key, venue) =>
        set((s) => {
          if (s.venues[key] === venue) return s;
          const venues = { ...s.venues, [key]: venue };
          const keys = Object.keys(venues);
          for (const stale of keys.slice(0, Math.max(0, keys.length - MAX))) {
            delete venues[stale];
          }
          return { venues };
        }),
    }),
    {
      name: 'andreas:import-learnings.v1',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ venues: s.venues }),
    },
  ),
);
