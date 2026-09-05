import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { registerPushToken, unregisterPushToken } from './api';

/**
 * Toont notifications ook als de app open is (banner + geluid).
 * iOS-default is dempen wanneer voorgrond — dat verbergt friend-pings
 * onnodig. Zet 'm één keer global, vóór gebruik.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let lastRegisteredToken: string | null = null;

/**
 * Vraagt permissie en registreert het Expo-push-token bij onze API.
 * No-op op simulator (Expo Go niet meer relevant — we draaien dev-build),
 * en no-op als de gebruiker permissie heeft geweigerd. Idempotent: als
 * we 'm deze sessie al hebben aangemeld doen we niets meer.
 *
 * Roep aan na een succesvolle login. Veilig om bij elke app-start opnieuw
 * te roepen — server doet upsert op token.
 */
export async function registerForPushNotificationsAsync(): Promise<string | null> {
  if (!Device.isDevice) return null;

  // Android-specific channel zodat Android iets om mee te werken heeft.
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
      lightColor: '#caff00',
    });
  }

  const { status: existing } = await Notifications.getPermissionsAsync();
  let status = existing;
  if (existing !== 'granted') {
    const { status: requested } = await Notifications.requestPermissionsAsync();
    status = requested;
  }
  if (status !== 'granted') return null;

  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ??
    Constants.easConfig?.projectId;
  if (!projectId) {
    console.warn('[push] no EAS projectId — kan token niet ophalen');
    return null;
  }

  // Deze gooit op Android zolang er geen FCM-credentials aan het project
  // hangen (geen google-services.json, niets geüpload naar Expo). De
  // caller doet `void register…()`, dus zonder deze vangst werd het een
  // stille unhandled rejection: geen token, geen melding, en niemand die
  // doorhad dat Android nooit een push kon krijgen.
  let token: string | null = null;
  try {
    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
    token = tokenData.data ?? null;
  } catch (err) {
    console.warn(
      `[push] geen token op ${Platform.OS} — op Android betekent dit meestal dat FCM nog niet is ingesteld`,
      err
    );
    return null;
  }
  if (!token) return null;

  // Deze sessie al aangemeld? Skip de extra round-trip.
  if (token === lastRegisteredToken) return token;

  try {
    await registerPushToken({
      token,
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
      deviceId: Device.osBuildId ?? null,
    });
    lastRegisteredToken = token;
  } catch (err) {
    console.warn('[push] register failed', err);
    return null;
  }
  return token;
}

/**
 * Bij logout: verwijder het token serverside, zodat ex-users geen
 * pushes meer ontvangen voor het account dat ze hebben verlaten.
 */
export async function unregisterPushNotificationsAsync(): Promise<void> {
  if (!lastRegisteredToken) return;
  try {
    await unregisterPushToken(lastRegisteredToken);
  } catch (err) {
    console.warn('[push] unregister failed', err);
  }
  lastRegisteredToken = null;
}

export { Notifications };
