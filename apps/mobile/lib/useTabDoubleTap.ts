import { useNavigation } from '@react-navigation/native';
import { useEffect, useRef } from 'react';

/**
 * Roept `onDoubleTap` aan wanneer de actieve tab-bar-knop binnen
 * `thresholdMs` ms twee keer wordt aangetikt. Single-tap-gedrag (re-tap
 * = scroll naar boven via `useScrollToTop`) blijft onaangetast — die
 * listener vuurt los van deze.
 *
 * Schermen met een zoekveld gebruiken dit om bij dubbel-tap de input
 * te legen en focus erin te zetten: één keer tappen brengt je terug
 * boven, nog een keer = direct in zoek-modus.
 */
export function useTabDoubleTap(
  onDoubleTap: () => void,
  thresholdMs: number = 400
) {
  const navigation = useNavigation();
  const lastTapAtRef = useRef(0);
  const callbackRef = useRef(onDoubleTap);
  // Houd de callback up-to-date zonder de listener bij elke render
  // opnieuw te registreren — voorkomt onnodig unsub/sub bij parent-
  // re-renders met inline-callbacks.
  callbackRef.current = onDoubleTap;
  useEffect(() => {
    const unsub = navigation.addListener('tabPress' as never, () => {
      const now = Date.now();
      if (now - lastTapAtRef.current < thresholdMs) {
        callbackRef.current();
        lastTapAtRef.current = 0;
      } else {
        lastTapAtRef.current = now;
      }
    });
    return unsub;
  }, [navigation, thresholdMs]);
}
