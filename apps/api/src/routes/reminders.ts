/**
 * Zelfgezette herinneringen.
 *
 * Alleen `kind = 'zelf'` komt hier binnen. De automatische (dag ervoor,
 * vanavond) zet de planner klaar uit je saves — die staan niet in deze
 * API, want ze zijn geen ding dat je beheert maar een gevolg van je
 * hartje. Zet je ze uit, dan doe je dat met de schakelaar op je profiel.
 *
 *   GET    /reminders          — wat staat er van mij klaar
 *   POST   /reminders          — { occurrenceId, fireAt, note? }
 *   DELETE /reminders/:id
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import { auth } from '../auth.js';
import { db, schema } from '../db/index.js';

// Zelfde vorm als in saves.ts en going.ts: drie regels die een 401
// teruggeven, niet de moeite van een gedeelde module waard.
async function requireUserId(c: Context): Promise<string | Response> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  return session.user.id;
}

export const remindersRoute = new Hono();

/** Een jaar vooruit is genoeg voor elke kaartverkoop, en het houdt een
    typefout in een datum (het jaar 2925) uit de tabel. */
const MAX_AHEAD_MS = 365 * 24 * 3600 * 1000;

remindersRoute.get('/', async (c) => {
  const userId = await requireUserId(c);
  if (typeof userId !== 'string') return userId;

  const rows = await db
    .select({
      id: schema.reminders.id,
      occurrenceId: schema.reminders.occurrenceId,
      fireAt: schema.reminders.fireAt,
      note: schema.reminders.note,
      sentAt: schema.reminders.sentAt,
      eventId: schema.events.id,
      title: schema.events.title,
      venueName: schema.venues.name,
      startsAt: schema.occurrences.startsAt,
    })
    .from(schema.reminders)
    .innerJoin(
      schema.occurrences,
      eq(schema.occurrences.id, schema.reminders.occurrenceId)
    )
    .innerJoin(schema.events, eq(schema.events.id, schema.occurrences.eventId))
    .innerJoin(
      schema.venues,
      eq(schema.venues.id, sql`COALESCE(${schema.occurrences.venueId}, ${schema.events.venueId})`)
    )
    .where(
      and(
        eq(schema.reminders.userId, userId),
        eq(schema.reminders.kind, 'zelf')
      )
    )
    .orderBy(asc(schema.reminders.fireAt));

  return c.json({ reminders: rows });
});

remindersRoute.post('/', async (c) => {
  const userId = await requireUserId(c);
  if (typeof userId !== 'string') return userId;

  const body = (await c.req.json()) as {
    occurrenceId?: string;
    fireAt?: string;
    note?: string;
  };
  const occurrenceId = (body.occurrenceId ?? '').trim();
  if (!occurrenceId) return c.json({ error: 'occurrenceId ontbreekt' }, 400);

  const fireAt = new Date(body.fireAt ?? '');
  if (Number.isNaN(fireAt.getTime())) {
    return c.json({ error: 'fireAt is geen geldig moment' }, 400);
  }
  // In het verleden zetten mag niet: die zou bij de eerstvolgende tik
  // meteen vertrekken, en dan lijkt de app kapot in plaats van streng.
  if (fireAt.getTime() <= Date.now()) {
    return c.json({ error: 'Kies een moment in de toekomst.' }, 400);
  }
  if (fireAt.getTime() > Date.now() + MAX_AHEAD_MS) {
    return c.json({ error: 'Hooguit een jaar vooruit.' }, 400);
  }

  const [occ] = await db
    .select({ id: schema.occurrences.id, startsAt: schema.occurrences.startsAt })
    .from(schema.occurrences)
    .where(eq(schema.occurrences.id, occurrenceId))
    .limit(1);
  if (!occ) return c.json({ error: 'occurrence niet gevonden' }, 404);

  const note = (body.note ?? '').trim().slice(0, 80) || null;

  // Eén zelfgezette per avond: een tweede overschrijft de eerste in
  // plaats van ernaast te komen. Dat is wat "herinner me" betekent als je
  // 'm nog een keer aanpast -- en het is precies het gedrag dat de unieke
  // index afdwingt, dus we vertellen hier hetzelfde verhaal als de DB.
  const [saved] = await db
    .insert(schema.reminders)
    .values({
      id: crypto.randomUUID(),
      userId,
      occurrenceId,
      kind: 'zelf',
      fireAt,
      note,
    })
    .onConflictDoUpdate({
      target: [
        schema.reminders.userId,
        schema.reminders.occurrenceId,
        schema.reminders.kind,
      ],
      set: { fireAt, note, sentAt: null },
    })
    .returning();

  return c.json({ reminder: saved });
});

remindersRoute.delete('/:id', async (c) => {
  const userId = await requireUserId(c);
  if (typeof userId !== 'string') return userId;

  await db
    .delete(schema.reminders)
    .where(
      and(
        eq(schema.reminders.id, c.req.param('id')),
        eq(schema.reminders.userId, userId)
      )
    );
  return c.json({ ok: true });
});
