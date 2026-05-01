import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/**
 * Set van venue-slugs die de gebruiker heeft opgeslagen — local-only
 * tot de venue_follows-tabel via de API gesynced wordt.
 */
type SavedVenuesState = {
  slugs: string[];
  toggle: (slug: string) => boolean;
  has: (slug: string) => boolean;
};

export const useSavedVenuesStore = create<SavedVenuesState>()(
  persist(
    (set, get) => ({
      slugs: [],
      toggle: (slug) => {
        const current = get().slugs;
        if (current.includes(slug)) {
          set({ slugs: current.filter((s) => s !== slug) });
          return false;
        }
        set({ slugs: [slug, ...current] });
        return true;
      },
      has: (slug) => get().slugs.includes(slug),
    }),
    {
      name: 'andreas:saved-venues',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ slugs: s.slugs }),
    }
  )
);

export const useIsVenueSaved = (slug: string) =>
  useSavedVenuesStore((s) => s.slugs.includes(slug));
