import { Expo, type ExpoPushMessage } from 'expo-server-sdk';
import { eq, inArray } from 'drizzle-orm';

import { db, schema } from './db/index.js';

/**
 * Expo Push wrapper. Eén Expo-instance per proces; hij bundelt de
 * sends in chunks van 100 zoals Expo wil. APNS- en FCM-credentials
 * zijn EAS-managed — wij praten alleen tegen de Expo push-service.
 *
 * Verzenden gaat in twee stappen, en dat is geen detail. Een *ticket*
 * zegt alleen dat Expo het bericht heeft aangenomen; of APNs of FCM het
 * daadwerkelijk accepteerde staat in de *receipt* die je daarna moet
 * ophalen. Juist daar komt `DeviceNotRegistered` meestal pas naar boven.
 * Wie alleen naar tickets kijkt ziet dus overal "verstuurd" staan terwijl
 * er niets aankomt, en houdt dode tokens eeuwig in de tabel.
 *
 * Failure-modes die we afhandelen:
 *  - `DeviceNotRegistered`, in ticket of receipt → token verwijderen
 *    (app verwijderd, opnieuw geïnstalleerd, of meldingen uitgezet).
 *  - Al het andere loggen we met de foutcode erbij en laten we verder
 *    lopen; één kapot device mag de rest van de batch niet stuk maken.
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
  /**
   * Getal op het app-icoon. Zet 'm op wat er te doen staat, niet op het
   * aantal berichten — iOS wist 'm niet vanzelf, dus een teller die
   * oploopt per push blijft staan tot de app 'm terugzet.
   */
  badge?: number;
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
    badge: payload.badge,
    // iOS-specific: standaard channelId voor consistente prioriteit.
    priority: 'high',
  }));

  console.log(
    `[push] verstuur naar ${valid.length} token(s): "${payload.title}"`
  );

  const dead: string[] = [];
  const accepted: { id: string; token: string }[] = [];

  for (const chunk of expo.chunkPushNotifications(messages)) {
    let tickets;
    try {
      tickets = await expo.sendPushNotificationsAsync(chunk);
    } catch (err) {
      console.error('[push] chunk mislukt', err);
      continue;
    }
    // Ticket terug op token via de `to` van hetzelfde bericht, niet via
    // een lopende index over alle chunks: die schuift scheef zodra er
    // één chunk faalt, en dan verwijder je het token van iemand anders.
    tickets.forEach((ticket, i) => {
      const to = chunk[i]?.to;
      const token = typeof to === 'string' ? to : undefined;
      if (ticket.status === 'ok') {
        if (token) accepted.push({ id: ticket.id, token });
        return;
      }
      console.error(
        `[push] geweigerd: ${ticket.details?.error ?? 'onbekend'} — ${ticket.message}`
      );
      if (ticket.details?.error === 'DeviceNotRegistered' && token) {
        dead.push(token);
      }
    });
  }

  if (dead.length > 0) await removeTokens(dead);
  // Losgekoppeld: de aanroeper hoeft niet te wachten tot Expo z'n
  // receipts klaar heeft staan.
  if (accepted.length > 0) {
    void checkReceipts(accepted).catch((err) =>
      console.error('[push] receipt-check mislukt', err)
    );
  }
}

/**
 * Wachttijden per poging. Expo heeft tijd nodig voordat een receipt
 * klaarstaat; één keer na vijftien seconden vragen levert meestal nog
 * niets op, en dan weet je nog niets.
 */
const RECEIPT_ATTEMPTS_MS = [15_000, 45_000, 120_000];

/**
 * Haalt de bezorgstatus op van wat Expo heeft aangenomen. Dit is de
 * enige plek waar we leren dat een push níét is aangekomen.
 *
 * Let op het verschil tussen de drie uitkomsten. Een id dat niet in het
 * antwoord voorkomt heeft nog géén uitslag — dat is niet hetzelfde als
 * geslaagd, en precies die verwarring maakte de vorige versie van deze
 * functie waardeloos: die rekende alles zonder foutmelding als bezorgd
 * en meldde dus "1/1 bezorgd" terwijl er niets verstuurd bleek.
 */
async function checkReceipts(
  sent: { id: string; token: string }[]
): Promise<void> {
  const tokenById = new Map(sent.map((s) => [s.id, s.token]));
  const open = new Set(tokenById.keys());
  const dead: string[] = [];
  let delivered = 0;
  let failed = 0;

  for (const wait of RECEIPT_ATTEMPTS_MS) {
    if (open.size === 0) break;
    await new Promise((r) => setTimeout(r, wait));
    for (const ids of expo.chunkPushNotificationReceiptIds([...open])) {
      const receipts = await expo.getPushNotificationReceiptsAsync(ids);
      for (const [id, receipt] of Object.entries(receipts)) {
        open.delete(id);
        if (receipt.status === 'ok') {
          delivered++;
          continue;
        }
        failed++;
        console.error(
          `[push] niet bezorgd (${id}): ${receipt.details?.error ?? 'onbekend'} — ${receipt.message}`
        );
        const token = tokenById.get(id);
        if (receipt.details?.error === 'DeviceNotRegistered' && token) {
          dead.push(token);
        }
      }
    }
  }

  // Ticket-ids erbij zolang het er weinig zijn: daarmee kun je een
  // verzending terugvinden in het Expo-dashboard.
  const refs =
    sent.length <= 5 ? ` — tickets ${sent.map((s) => s.id).join(', ')}` : '';
  console.log(
    `[push] uitslag: ${delivered} bezorgd, ${failed} mislukt, ${open.size} zonder uitslag${refs}`
  );
  if (dead.length > 0) await removeTokens(dead);
}

async function removeTokens(tokens: string[]): Promise<void> {
  await db
    .delete(schema.pushTokens)
    .where(inArray(schema.pushTokens.token, tokens));
  console.warn(`[push] ${tokens.length} dood token verwijderd`);
}
