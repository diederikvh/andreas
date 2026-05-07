import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Localization from 'expo-localization';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type Locale = 'nl' | 'en';
export type LocalePreference = 'auto' | Locale;

function detectOsLocale(): Locale {
  try {
    const locales = Localization.getLocales();
    const code = locales[0]?.languageCode?.toLowerCase();
    return code === 'nl' ? 'nl' : 'en';
  } catch {
    return 'en';
  }
}

type LocaleState = {
  preference: LocalePreference;
  /** Resolved locale = preference !== 'auto' ? preference : OS locale. */
  locale: Locale;
  setPreference: (p: LocalePreference) => void;
};

export const useLocaleStore = create<LocaleState>()(
  persist(
    (set) => ({
      preference: 'auto',
      locale: detectOsLocale(),
      setPreference: (preference) =>
        set({
          preference,
          locale: preference === 'auto' ? detectOsLocale() : preference,
        }),
    }),
    {
      name: 'andreas:locale',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ preference: s.preference }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.locale =
            state.preference === 'auto' ? detectOsLocale() : state.preference;
        }
      },
    }
  )
);

export const useLocale = () => useLocaleStore((s) => s.locale);
export const useLocalePreference = () =>
  useLocaleStore((s) => s.preference);

/**
 * Pure translator — call with NL + EN strings, picks the active locale.
 * Use inside hooks/components via `useT()`, or for non-reactive contexts
 * read the store directly via `getT()`.
 */
export function useT() {
  const locale = useLocale();
  return (nl: string, en: string) => (locale === 'nl' ? nl : en);
}

/** Non-reactive translator for utils/mocks/outside-React contexts. */
export function getT() {
  const locale = useLocaleStore.getState().locale;
  return (nl: string, en: string) => (locale === 'nl' ? nl : en);
}

/** Locale-aware Intl formatter helpers. */
export const intlLocale = (l: Locale) => (l === 'nl' ? 'nl-NL' : 'en-GB');
