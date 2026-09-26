/**
 * Client-state voor de gids (zoeken met filters) en de zoek-overlay.
 *
 * In-memory (geen persist): de filters en het laatste resultaat blijven
 * staan tussen openen en sluiten; een app-herstart begint vers.
 */
import { create } from 'zustand';

import { postZoek, type ApiEvent, type ZoekFields } from '@/lib/api';
import { periodOf, type ZoekWhen } from '@/lib/period';

export type { ZoekWhen };

export type ZoekFilters = {
  when: ZoekWhen;
  /** Eerst wat bij jou past, of gewoon op datum. */
  sort: 'personal' | 'date';
  cities: string[];
  categories: string[];
  genres: string[];
  query: string;
};

export type ZoekResult = {
  reply: string;
  events: ApiEvent[];
  reasonByEventId: Record<string, string>;
  /** Hoeveel er in totaal passen; meer dan `events.length` = knop "meer". */
  total: number;
};

const EMPTY_FILTERS: ZoekFilters = { when: 'week', sort: 'personal', cities: [], categories: [], genres: [], query: '' };

type ZoekState = {
  filters: ZoekFilters;
  setFilters: (patch: Partial<ZoekFilters>) => void;
  result: ZoekResult | null;
  sending: boolean;
  error: string | null;
  /** Zichtbaarheid van de gids-overlay. Globaal (niet per scherm) zodat de
      overlay op tabs-layout-niveau boven de TabBar gerenderd kan worden. */
  guideOpen: boolean;
  openGuide: () => void;
  closeGuide: () => void;
  /** Idem voor de zoek-overlay: de zoek-knop staat in de AppHeader en moet
      vanaf elk scherm te openen zijn. */
  searchOpen: boolean;
  openSearch: () => void;
  closeSearch: () => void;
  search: () => Promise<void>;
  /** De volgende 20 van dezelfde zoekopdracht, erachter geplakt. */
  loadMore: () => Promise<void>;
  loadingMore: boolean;
  reset: () => void;
};

/** De filters als velden voor de server. */
function fieldsOf(f: ZoekFilters): ZoekFields {
  return {
    ...periodOf(f.when),
    cities: f.cities.length ? f.cities : undefined,
    categories: f.categories.length ? f.categories : undefined,
    genres: f.genres.length ? f.genres : undefined,
    query: f.query.trim() || undefined,
  };
}

export const useZoekStore = create<ZoekState>((set, get) => ({
  filters: EMPTY_FILTERS,
  setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),
  result: null,
  sending: false,
  error: null,
  guideOpen: false,
  openGuide: () => set({ guideOpen: true }),
  closeGuide: () => set({ guideOpen: false }),
  searchOpen: false,
  openSearch: () => set({ searchOpen: true }),
  closeSearch: () => set({ searchOpen: false }),

  search: async () => {
    if (get().sending) return;
    set({ sending: true, error: null });
    try {
      const res = await postZoek(fieldsOf(get().filters), { sort: get().filters.sort });
      set({
        result: {
          reply: res.reply,
          events: res.events ?? [],
          reasonByEventId: res.reasonByEventId ?? {},
          total: res.total ?? (res.events ?? []).length,
        },
        sending: false,
      });
    } catch (e) {
      set({ sending: false, error: e instanceof Error ? e.message : 'Er ging iets mis. Probeer het nog eens.' });
    }
  },

  loadingMore: false,
  loadMore: async () => {
    const prev = get().result;
    if (!prev || get().loadingMore || prev.events.length >= prev.total) return;
    set({ loadingMore: true });
    try {
      const res = await postZoek(fieldsOf(get().filters), { offset: prev.events.length, sort: get().filters.sort });
      const seen = new Set(prev.events.map((e) => e.id));
      set({
        result: {
          ...prev,
          events: [...prev.events, ...(res.events ?? []).filter((e) => !seen.has(e.id))],
          reasonByEventId: { ...prev.reasonByEventId, ...(res.reasonByEventId ?? {}) },
        },
        loadingMore: false,
      });
    } catch {
      set({ loadingMore: false });
    }
  },

  reset: () => set({ filters: EMPTY_FILTERS, result: null, sending: false, loadingMore: false, error: null }),
}));
