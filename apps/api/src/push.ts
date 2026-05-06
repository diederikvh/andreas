import { Expo, type ExpoPushMessage, type ExpoPushTicket } from 'expo-server-sdk';
import { eq, inArray } from 'drizzle-orm';

import { db, schema } from './db/index.js';

/**
 * Expo Push wrapper. Eén Expo-instance per proces; hij bundelt de
 * sends in chunks van 100 zoals Expo wil. APNS- en FCM-credentials
 * zijn EAS-managed — wij praten alleen tegen de Expo push-service.
 *
 * Failure-modes die we afhandelen:
 *  - `DeviceNotRegistered` → token verwijderen (gebruiker heeft de app
 *    de-installed of notifications uitgezet).
 *  - Andere errors loggen we maar negeren; één kapot device mag de
 *    rest van de batch niet stuk maken.
 */
const expo = new Expo({
  accessToken: process.env.EXPO_ACCESS_TOKEN,
});

if (!process.env.EXPO_ACCESS_TOKEN) {
  console.warn(
    '[push] EXPO_ACCESS_TOKEN ontbreekt — Expo push service zal alle requests met 403 weigeren. Stel in als Fly secret.'
  );
}

export type PushPayload = {
  title: string;
  body: string;
  /**
   * Klein, JSON-serialiseerbaar object dat de mobile-handler gebruikt
   * om naar het juiste scherm te navigeren. Conventie: `{ url: '/event/xyz' }`.
   * Geen secrets — verschijnt op het lockscreen-payload.
   */
  data?: Record<string, unknown>;
};

/**
 * Stuur een push naar alle devices van een user. Idempotent op
 * Expo-niveau (we sturen gewoon door — Expo de-dupliceert niet).
 * Geen-tokens = no-op.
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload
): Promise<void> {
  const tokens = await db
    .select({ token: schema.pushTokens.token })
    .from(schema.pushTokens)
    .where(eq(schema.pushTokens.userId, userId));
  await sendToTokens(
    tokens.map((t) => t.token),
    payload
  );
}

/**
 * Variant voor invites: één payload, vele recipients. Eén query,
 * één Expo-batch — efficiënter dan N keer `sendPushToUser`.
 */
export async function sendPushToUsers(
  userIds: string[],
  payload: PushPayload
): Promise<void> {
  if (userIds.length === 0) return;
  const tokens = await db
    .select({ token: schema.pushTokens.token })
    .from(schema.pushTokens)
    .where(inArray(schema.pushTokens.userId, userIds));
  await sendToTokens(
    tokens.map((t) => t.token),
    payload
  );
}

async function sendToTokens(
  rawTokens: string[],
  payload: PushPayload
): Promise<void> {
  const valid = rawTokens.filter((t) => Expo.isExpoPushToken(t));
  if (valid.length === 0) return;

  const messages: ExpoPushMessage[] = valid.map((to) => ({
    to,
    sound: 'default',
    title: payload.title,
    body: payload.body,
    data: payload.data ?? {},
    // iOS-specific: standaard channelId voor consistente prioriteit.
    priority: 'high',
  }));

  const chunks = expo.chunkPushNotifications(messages);
  const tickets: ExpoPushTicket[] = [];
  for (const chunk of chunks) {
    try {
      const chunkTickets = await expo.sendPushNotificationsAsync(chunk);
      tickets.push(...chunkTickets);
    } catch (err) {
      console.error('[push] chunk send failed', err);
    }
  }

  // Tickets die `error: DeviceNotRegistered` teruggeven betekent dat
  // het token dood is — verwijderen zodat we het niet blijven proberen.
  // We mappen tickets terug op tokens via index-volgorde (Expo houdt
  // de volgorde aan binnen de chunk).
  const dead: string[] = [];
  let i = 0;
  for (const ticket of tickets) {
    const token = valid[i++];
    if (
      ticket.status === 'error' &&
      ticket.details?.error === 'DeviceNotRegistered' &&
      token
    ) {
      dead.push(token);
    }
  }
  if (dead.length > 0) {
    await db
      .delete(schema.pushTokens)
      .where(inArray(schema.pushTokens.token, dead));
  }
}
