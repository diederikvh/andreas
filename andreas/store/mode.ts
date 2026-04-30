import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { roles, type Mode } from '@/theme/tokens';

type ModeState = {
  /** Current mode. Hydrated from storage on launch; defaults to nacht. */
  mode: Mode;
  /** True until persistence has finished restoring. Splash should wait. */
  hasHydrated: boolean;
  /** True once the user has finished the start-screen flow (mode-keuze + welkom). */
  hasOnboarded: boolean;
  setMode: (mode: Mode) => void;
  toggle: () => void;
  completeOnboarding: () => void;
};

export const useModeStore = create<ModeState>()(
  persist(
    (set) => ({
      mode: 'nacht',
      hasHydrated: false,
      hasOnboarded: false,
      setMode: (mode) => set({ mode }),
      toggle: () =>
        set((s) => ({ mode: s.mode === 'nacht' ? 'dag' : 'nacht' })),
      completeOnboarding: () => set({ hasOnboarded: true }),
    }),
    {
      name: 'andreas:mode',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ mode: s.mode, hasOnboarded: s.hasOnboarded }),
    }
  )
);

useModeStore.persist.onFinishHydration(() => {
  useModeStore.setState({ hasHydrated: true });
});

if (useModeStore.persist.hasHydrated()) {
  useModeStore.setState({ hasHydrated: true });
}

export const useMode = () => useModeStore((s) => s.mode);
export const useRoles = () => roles[useModeStore((s) => s.mode)];
export const useHasHydrated = () => useModeStore((s) => s.hasHydrated);
export const useHasOnboarded = () => useModeStore((s) => s.hasOnboarded);
