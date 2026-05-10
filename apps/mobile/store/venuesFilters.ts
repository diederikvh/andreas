import { create } from 'zustand';

import type { VenueDayNight, VenueScene, VenueType } from '@/lib/api';

/**
 * Filter-keuze op de Venues-tab — leeft alleen tijdens app-runtime.
 * Net als de Agenda-filters: behouden bij stack-pushes (tap op venue
 * → terug), reset bij tab-wissel. Reset-logica zit in venues.tsx;
 * store is agnostisch.
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

export const useVenuesFilters = create<VenuesFiltersState>((set) => ({
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
}));
