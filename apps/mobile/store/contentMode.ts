import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

// Content-mode bepaalt welke "soort" events Vandaag en Agenda tonen:
// 'uit' (concert, club, theater, film) of 'expo' (musea, galleries,
// literatuur). Onafhankelijk van Nacht/Dag visuele mode — dat is een
// styling-keuze, dit een content-keuze. Persistent zodat de keuze
// app-restarts overleeft.
export type ContentMode = 'uit' | 'expo';

type ContentModeState = {
  mode: ContentMode;
  setMode: (mode: ContentMode) => void;
  toggle: () => void;
};

export const useContentModeStore = create<ContentModeState>()(
  persist(
    (set) => ({
      mode: 'uit',
      setMode: (mode) => set({ mode }),
      toggle: () =>
        set((s) => ({ mode: s.mode === 'uit' ? 'expo' : 'uit' })),
    }),
    {
      name: 'andreas:contentMode',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ mode: s.mode }),
    }
  )
);

export const useContentMode = () => useContentModeStore((s) => s.mode);
export const useSetContentMode = () =>
  useContentModeStore((s) => s.setMode);
