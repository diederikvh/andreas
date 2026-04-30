import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { roles, type Mode } from '@/theme/tokens';

type ModeState = {
  /** Current mode. Hydrated from storage on launch; defaults to nacht. */
  mode: Mode;
  /** True until persistence has finished restoring. Splash should wait. */
  hasHydrated: boolean;
  /** True the first time a mode is explicitly chosen (gates the start flow). */
  hasChosen: boolean;
  setMode: (mode: Mode) => void;
  toggle: () => void;
};

export const useModeStore = create<ModeState>()(
  persist(
    (set) => ({
      mode: 'nacht',
      hasHydrated: false,
      hasChosen: false,
      setMode: (mode) => set({ mode, hasChosen: true }),
      toggle: () =>
        set((s) => ({
          mode: s.mode === 'nacht' ? 'dag' : 'nacht',
          hasChosen: true,
        })),
    }),
    {
      name: 'andreas:mode',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ mode: s.mode, hasChosen: s.hasChosen }),
    }
  )
);

useModeStore.persist.onFinishHydration(() => {
  useModeStore.setState({ hasHydrated: true });
});

// If hydration already finished synchronously (web, or no stored value),
// flip the flag on the next tick so consumers always see a stable value.
if (useModeStore.persist.hasHydrated()) {
  useModeStore.setState({ hasHydrated: true });
}

export const useMode = () => useModeStore((s) => s.mode);
export const useRoles = () => roles[useModeStore((s) => s.mode)];
export const useHasHydrated = () => useModeStore((s) => s.hasHydrated);
export const useHasChosenMode = () => useModeStore((s) => s.hasChosen);
