import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { ApiEvent, VenueType } from '@/lib/api';
import type { TimeBlock } from '@/lib/eventDisplay';

/**
 * Filter-keuze op de Agenda-tab.
 *
 * Het meeste leeft alleen tijdens de sessie: datum, zoekterm,
 * categorieën, types en tijdblokken beginnen bij een koude start weer
 * blanco. Dat is met opzet — een agenda die je na een week opent met een
 * vergeten filter erop lijkt leeg.
 *
 * **Twee uitzonderingen: "mijn venues" en "vrienden".** Die gaan niet
 * over wát je zoekt maar over wíé je volgt, en dat verandert niet per
 * sessie. Wie z'n agenda altijd op z'n eigen zalen bekijkt, wil dat niet
 * elke keer opnieuw aanzetten. Alleen die twee worden bewaard; `reset()`
 * ("wis filters") zet ze wel gewoon uit, want dat is een expliciete daad.
 */
/** YYYY-MM-DD in NL-lokale tijd. */
export type DateRange = { from: string; to: string };

export function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Standaard: vandaag t/m over zes dagen. Zeven dagen is lang genoeg om
 * te bladeren en kort genoeg om af te scrollen — korter mis je het
 * weekend, langer wordt de lijst een telefoonboek.
 *
 * Logische dag-shift: vóór 06:00 hoor je nog bij gisteren, anders zou
 * de agenda om 01:00 het programma van vanavond al hebben weggegooid.
 */
export function defaultRange(now = new Date()): DateRange {
  const d = new Date(now);
  if (d.getHours() < 6) d.setDate(d.getDate() - 1);
  const end = new Date(d);
  end.setDate(end.getDate() + 6);
  return { from: isoDay(d), to: isoDay(end) };
}

type AgendaFiltersState = {
  query: string;
  /** Van–tot in plaats van één geselecteerde dag. Verving de day-strip:
      die toonde één dag tegelijk, waardoor je voor "wat is er deze
      week" zeven keer moest tikken en nooit kon doorscrollen. */
  range: DateRange;
  onlyFriends: boolean;
  onlyFavorites: boolean;
  activeBlocks: TimeBlock[];
  activeCats: ApiEvent['category'][];
  activeTypes: VenueType[];
  setQuery: (q: string) => void;
  setRange: (next: DateRange) => void;
  setOnlyFriends: (next: boolean) => void;
  setOnlyFavorites: (next: boolean) => void;
  setActiveBlocks: (next: TimeBlock[]) => void;
  setActiveCats: (next: ApiEvent['category'][]) => void;
  setActiveTypes: (next: VenueType[]) => void;
  toggleType: (t: VenueType) => void;
  reset: () => void;
};

export const useAgendaFilters = create<AgendaFiltersState>()(
  persist(
    (set, get) => ({
  query: '',
  range: defaultRange(),
  onlyFriends: false,
  onlyFavorites: false,
  activeBlocks: [],
  activeCats: [],
  activeTypes: [],
  setQuery: (q) => set({ query: q }),
  setRange: (next) => set({ range: next }),
  setOnlyFriends: (next) => set({ onlyFriends: next }),
  setOnlyFavorites: (next) => set({ onlyFavorites: next }),
  setActiveBlocks: (next) => set({ activeBlocks: next }),
  setActiveCats: (next) => set({ activeCats: next }),
  setActiveTypes: (next) => set({ activeTypes: next }),
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
      range: defaultRange(),
      onlyFriends: false,
      onlyFavorites: false,
      activeBlocks: [],
      activeCats: [],
      activeTypes: [],
        }),
    }),
    {
      name: 'andreas:agenda-filters.v3',
      storage: createJSONStorage(() => AsyncStorage),
      // Alleen wie, niet wat: zie de toelichting bovenaan.
      partialize: (s) => ({
        onlyFavorites: s.onlyFavorites,
        onlyFriends: s.onlyFriends,
      }),
    }
  )
);
