import { useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import {
  useSafeAreaFrame,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';

/**
 * Bovenmarge voor een scherm dat zowel fullscreen als in een sheet kan
 * staan.
 *
 * In een sheet begint je scherm al onder de notch, dus daar is de
 * safe-area-inset dubbelop en krijg je een gat. Uitvinden waar je zit is
 * drie keer misgegaan met slimmigheidjes: `router.canGoBack()` leest de
 * stack op het verkeerde moment, `measureInWindow` geeft binnen een sheet
 * óók 0 (hij meet vanaf de view-controller), en de routes-lijst van de
 * root-navigator telt de modal niet als aparte route.
 *
 * Wat niet te betwisten is: onze eigen hoogte. Een sheet is korter dan het
 * scherm; fullscreen is precies zo hoog. Dus meten we die.
 *
 * Hang `onLayout` aan de buitenste View en gebruik `top` als paddingTop.
 */
export function useSheetTop(base = 8): {
  top: number;
  onLayout: (e: LayoutChangeEvent) => void;
} {
  const frame = useSafeAreaFrame();
  const insets = useSafeAreaInsets();
  const [ownHeight, setOwnHeight] = useState(0);
  const isSheet = ownHeight > 0 && ownHeight < frame.height - 8;
  return {
    // Tot we gemeten hebben: uitgaan van een sheet. Een te grote marge
    // valt meer op dan een te kleine.
    top: ownHeight === 0 || isSheet ? 14 : insets.top + base,
    onLayout: (e) => setOwnHeight(e.nativeEvent.layout.height),
  };
}
