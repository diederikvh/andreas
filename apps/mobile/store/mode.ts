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
  /** True once de gebruiker de eerste-bezoek hint over de Uit/Expo
      content-switch heeft weggeklikt. */
  hasSeenContentSwitchHint: boolean;
  /** True once de hint bij de filter-knop op Agenda is weggeklikt. */
  hasSeenFilterHint: boolean;
  setMode: (mode: Mode) => void;
  toggle: () => void;
  completeOnboarding: () => void;
  dismissContentSwitchHint: () => void;
  dismissFilterHint: () => void;
};

export const useModeStore = create<ModeState>()(
  persist(
    (set) => ({
      mode: 'nacht',
      hasHydrated: false,
      hasOnboarded: false,
      hasSeenContentSwitchHint: false,
      hasSeenFilterHint: false,
      setMode: (mode) => set({ mode }),
      toggle: () =>
        set((s) => ({ mode: s.mode === 'nacht' ? 'dag' : 'nacht' })),
      completeOnboarding: () => set({ hasOnboarded: true }),
      dismissContentSwitchHint: () =>
        set({ hasSeenContentSwitchHint: true }),
      dismissFilterHint: () => set({ hasSeenFilterHint: true }),
    }),
    {
      name: 'andreas:mode',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({
        mode: s.mode,
        hasOnboarded: s.hasOnboarded,
        hasSeenContentSwitchHint: s.hasSeenContentSwitchHint,
        hasSeenFilterHint: s.hasSeenFilterHint,
      }),
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
export const useHasSeenContentSwitchHint = () =>
  useModeStore((s) => s.hasSeenContentSwitchHint);
export const useDismissContentSwitchHint = () =>
  useModeStore((s) => s.dismissContentSwitchHint);
export const useHasSeenFilterHint = () =>
  useModeStore((s) => s.hasSeenFilterHint);
export const useDismissFilterHint = () =>
  useModeStore((s) => s.dismissFilterHint);
