import * as Location from 'expo-location';
import { useEffect, useState } from 'react';

export type DeviceLocation = { lat: number; lng: number };

export type LocationStatus =
  | { status: 'unknown' }
  | { status: 'granted'; location: DeviceLocation }
  | { status: 'denied' }
  | { status: 'unavailable' };

/**
 * Vraagt one-shot om de device-locatie. Slaat het resultaat lokaal op
 * zodat re-mounts geen nieuwe permissie-prompt triggeren binnen één
 * sessie (Expo cached de permissie zelf cross-restart).
 *
 * Geen continue subscription — voor een uitgaansapp is een momentane
 * positie genoeg, en het scheelt batterij.
 */
export function useDeviceLocation(): LocationStatus {
  const [state, setState] = useState<LocationStatus>({ status: 'unknown' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (cancelled) return;
        if (status !== 'granted') {
          setState({ status: 'denied' });
          return;
        }
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        if (cancelled) return;
        setState({
          status: 'granted',
          location: {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
          },
        });
      } catch {
        if (!cancelled) setState({ status: 'unavailable' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
