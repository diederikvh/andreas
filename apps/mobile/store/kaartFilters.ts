import { create } from 'zustand';

import type { ApiEvent, VenueType } from '@/lib/api';
import type { TimeBlock } from '@/lib/eventDisplay';

/**
 * Filter-keuze op de Kaart-tab — runtime-only (geen persist) en
 * losstaand van de Vandaag-tab. Eerder deelde Kaart de vandaagFilters
 * store; dat lekte cat/type-keuzes van de map naar de Vandaag-rails
 * en zorgde voor onverwachte resultaten (bv. Muziek in een
 * expo-rail wanneer de gebruiker eerder op de Kaart 'Muziek' had
 * gekozen).
 *
 * Shape spiegelt useVandaagFilters / useAgendaFilters voor
 * compatibiliteit met de gedeelde AvondFilterSheet-component.
 */
type KaartFiltersState = {
  query: string;
  onlyFriends: boolean;
  onlyFavorites: boolean;
  activeBlocks: TimeBlock[];
  activeCats: ApiEvent['category'][];
  activeTypes: VenueType[];
  setQuery: (q: string) => void;
  setOnlyFriends: (next: boolean) => void;
  setOnlyFavorites: (next: boolean) => void;
  setActiveBlocks: (next: TimeBlock[]) => void;
  setActiveCats: (next: ApiEvent['category'][]) => void;
  setActiveTypes: (next: VenueType[]) => void;
  toggleBlock: (b: TimeBlock) => void;
  toggleType: (t: VenueType) => void;
  reset: () => void;
};

export const useKaartFilters = create<KaartFiltersState>((set, get) => ({
  query: '',
  onlyFriends: false,
  onlyFavorites: false,
  activeBlocks: [],
  activeCats: [],
  activeTypes: [],
  setQuery: (q) => set({ query: q }),
  setOnlyFriends: (next) => set({ onlyFriends: next }),
  setOnlyFavorites: (next) => set({ onlyFavorites: next }),
  setActiveBlocks: (next) => set({ activeBlocks: next }),
  setActiveCats: (next) => set({ activeCats: next }),
  setActiveTypes: (next) => set({ activeTypes: next }),
  toggleBlock: (b) => {
    const { activeBlocks } = get();
    set({
      activeBlocks: activeBlocks.includes(b)
        ? activeBlocks.filter((x) => x !== b)
        : [...activeBlocks, b],
    });
  },
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
        }),
}));
