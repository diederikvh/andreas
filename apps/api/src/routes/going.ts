/**
 * "Ik ga hierheen" — de derde trede naast het hartje en de uitnodiging.
 *
 * Twee bronnen tellen als intentie en die worden hier samengevoegd:
 *
 *   1. `attendance` — je hebt zelf op "ik ga" getikt.
 *   2. `invitation_responses` met status `going` — je hebt ja gezegd op
 *      een uitnodiging, of er zelf een verstuurd.
 *
 * Die tweede is geen extraatje: had je 'm niet meegenomen, dan moest je
 * na het accepteren van een uitnodiging alsnog een tweede keer "ik ga"
 * tikken voordat het in je rail stond. Ingetrokken uitnodigingen
 * (`revokedAt`) tellen niet mee.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import { auth } from '../auth.js';
import { db, schema } from '../db/index.js';
import { fetchOccurrenceCards } from './_helpers.js';

async function requireUserId(c: Context): Promise<string | Response> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  return session.user.id;
}

export const goingRoute = new Hono();

/** Alle occurrence-ids waar deze gebruiker heen gaat, uit beide bronnen. */
async function goingOccurrenceIds(userId: string): Promise<string[]> {
  const [own, invited] = await Promise.all([
    db
      .select({ occurrenceId: schema.attendance.occurrenceId })
      .from(schema.attendance)
      .where(eq(schema.attendance.userId, userId)),
    db
      .select({ occurrenceId: schema.invitations.occurrenceId })
      .from(schema.invitationResponses)
      .innerJoin(
        schema.invitations,
        eq(schema.invitationResponses.invitationId, schema.invitations.id)
      )
      .where(
        and(
          eq(schema.invitationResponses.userId, userId),
          eq(schema.invitationResponses.status, 'going'),
          isNull(schema.invitations.revokedAt)
        )
      ),
  ]);
  return [...new Set([...own, ...invited].map((r) => r.occurrenceId))];
}

/**
 * Waar ik heen ga. Toekomst chronologisch eerst — dit is een agenda, dus
 * "wat komt eraan" staat vooraan; wat geweest is loopt daarachter van
 * recent naar oud.
 */
goingRoute.get('/', async (c) => {
  const userId = await requireUserId(c);
  if (typeof userId !== 'string') return userId;

  const events = await fetchOccurrenceCards(await goingOccurrenceIds(userId));

  const now = Date.now();
  events.sort((a, b) => {
    const aT = a.startsAt.getTime();
    const bT = b.startsAt.getTime();
    const aFuture = aT >= now;
    const bFuture = bT >= now;
    if (aFuture !== bFuture) return aFuture ? -1 : 1;
    return aFuture ? aT - bT : bT - aT;
  });

  return c.json({ events });
});

const SOURCES = new Set([
  'venue',
  'friend',
  'search',
  'op-gevoel',
  'avond',
  'agenda',
  'kaart',
  'series',
  'gered',
  'new',
  'other',
]);

/**
 * Toggle. Body: `{ occurrenceId, source? }`.
 *
 * Raakt alleen `attendance`. Een ja die uit een uitnodiging komt hoort
 * daar thuis en niet hier — die zet je om via /invitations, anders
 * zouden twee tabellen hetzelfde feit bijhouden en uit elkaar lopen.
 */
goingRoute.post('/', async (c) => {
  const userId = await requireUserId(c);
  if (typeof userId !== 'string') return userId;

  const body = (await c.req.json()) as {
    occurrenceId?: string;
    source?: string;
  };
  const occurrenceId = body.occurrenceId;
  if (!occurrenceId) return c.json({ error: 'occurrenceId is verplicht' }, 400);
  const source =
    typeof body.source === 'string' && SOURCES.has(body.source)
      ? (body.source as typeof schema.attendance.$inferInsert.source)
      : null;

  const where = and(
    eq(schema.attendance.userId, userId),
    eq(schema.attendance.occurrenceId, occurrenceId)
  );

  const existing = await db
    .select({ occurrenceId: schema.attendance.occurrenceId })
    .from(schema.attendance)
    .where(where)
    .limit(1);

  if (existing.length > 0) {
    await db.delete(schema.attendance).where(where);
    return c.json({ going: false });
  }

  const [occ] = await db
    .select({ id: schema.occurrences.id })
    .from(schema.occurrences)
    .where(eq(schema.occurrences.id, occurrenceId))
    .limit(1);
  if (!occ) return c.json({ error: 'occurrence niet gevonden' }, 404);

  await db.insert(schema.attendance).values({ userId, occurrenceId, source });
  return c.json({ going: true });
});
