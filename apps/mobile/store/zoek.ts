/**
 * Zichtbaarheid van de zoek-overlay. Globaal (niet per scherm): de
 * zoek-knop staat in de AppHeader en de TabBar, en de overlay wordt op
 * tabs-layout-niveau boven de TabBar gerenderd.
 */
import { create } from 'zustand';

type ZoekState = {
  searchOpen: boolean;
  openSearch: () => void;
  closeSearch: () => void;
};

export const useZoekStore = create<ZoekState>((set) => ({
  searchOpen: false,
  openSearch: () => set({ searchOpen: true }),
  closeSearch: () => set({ searchOpen: false }),
}));
