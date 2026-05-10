import { create } from 'zustand';

import type { ApiEvent, VenueType } from '@/lib/api';
import type { TimeBlock } from '@/lib/eventDisplay';

/**
 * Filter-keuze op de Agenda-tab — leeft alleen tijdens app-runtime.
 * GEEN persist meer (was in v1/v2). Filter-state wordt geRESET wanneer
 * je via de tab-bar weggaat van Agenda; bij stack-pushes (tap op
 * event → terug) blijft 't intact zodat je niet je verfijning
 * verliest. Reset-logica zit in app/(tabs)/agenda.tsx — store is
 * agnostisch.
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

export const useAgendaFilters = create<AgendaFiltersState>((set, get) => ({
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
}));
