import AsyncStorage from '@react-native-async-storage/async-storage';
import { useMemo } from 'react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { BadgeTone } from '@/mocks/feed';
import type { Friend } from '@/mocks/gered';

/**
 * Snapshot of an event the user has saved. Mirrors the GeredItem shape
 * so a saved event can render in the Gered list without an extra
 * lookup. Fase 4 will replace this with an ids-only set + server
 * lookup, but until then snapshots avoid a brittle shared catalog
 * across mock files.
 */
export type SavedEvent = {
  id: string;
  dow: string;
  num: string;
  month: string;
  time: string;
  duration: string;
  title: string;
  venue: string;
  category: string;
  tick: BadgeTone;
  friends: Friend[];
};

type SavedState = {
  items: Record<string, SavedEvent>;
  /** Insertion order, newest first. */
  order: string[];
  hasHydrated: boolean;
  toggle: (event: SavedEvent) => boolean;
  has: (id: string) => boolean;
};

export const useSavedStore = create<SavedState>()(
  persist(
    (set, get) => ({
      items: {},
      order: [],
      hasHydrated: false,
      toggle: (event) => {
        const { items, order } = get();
        if (items[event.id]) {
          const { [event.id]: _removed, ...rest } = items;
          set({ items: rest, order: order.filter((x) => x !== event.id) });
          return false;
        }
        set({
          items: { ...items, [event.id]: event },
          order: [event.id, ...order],
        });
        return true;
      },
      has: (id) => Boolean(get().items[id]),
    }),
    {
      name: 'andreas:saved',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ items: s.items, order: s.order }),
    }
  )
);

useSavedStore.persist.onFinishHydration(() => {
  useSavedStore.setState({ hasHydrated: true });
});

if (useSavedStore.persist.hasHydrated()) {
  useSavedStore.setState({ hasHydrated: true });
}

export const useIsSaved = (id: string) =>
  useSavedStore((s) => Boolean(s.items[id]));

export const useSavedList = (): SavedEvent[] => {
  const order = useSavedStore((s) => s.order);
  const items = useSavedStore((s) => s.items);
  return useMemo(
    () => order.map((id) => items[id]).filter(Boolean),
    [order, items]
  );
};
