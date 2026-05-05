import { and, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import { auth } from '../auth.js';
import { db, schema } from '../db/index.js';
import { buildOccurrencesByEvent } from './_helpers.js';

async function requireUserId(c: Context): Promise<string | Response> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  return session.user.id;
}

export const savesRoute = new Hono();

savesRoute.get('/', async (c) => {
  const userId = await requireUserId(c);
  if (typeof userId !== 'string') return userId;

  const rows = await db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      description: schema.events.description,
      kind: schema.events.kind,
      imageUrl: schema.events.imageUrl,
      category: schema.events.category,
      featured: schema.events.featured,
      savedAt: schema.saves.createdAt,
      venue: {
        id: schema.venues.id,
        slug: schema.venues.slug,
        name: schema.venues.name,
        address: schema.venues.address,
        lat: schema.venues.lat,
        lng: schema.venues.lng,
        priceNote: schema.venues.priceNote,
      },
    })
    .from(schema.saves)
    .innerJoin(schema.events, eq(schema.saves.eventId, schema.events.id))
    .innerJoin(schema.venues, eq(schema.events.venueId, schema.venues.id))
    .where(
      and(
        eq(schema.saves.userId, userId),
        eq(schema.events.published, true),
        eq(schema.venues.published, true)
      )
    );

  // Voor elk gesaved event de eerstvolgende occurrence opzoeken. Events
  // zonder toekomstige occurrence krijgen `startsAt: null` — UI kan dan
  // "verleden" of "afgelopen" tonen.
  const eventIds = rows.map((r) => r.id);
  // includePast: voor afgelopen events tonen we de laatste occurrence-datum
  // zodat de Gered-tab "Vorige" sectie ook een datum kan laten zien.
  const occMap = await buildOccurrencesByEvent(eventIds, { includePast: true });

  const events = rows
    .map((r) => {
      const occ = occMap.get(r.id);
      return {
        ...r,
        startsAt: occ?.next?.startsAt ?? null,
        endsAt: occ?.next?.endsAt ?? null,
        priceCents: occ?.next?.priceCents ?? null,
        priceNote: occ?.next?.priceNote ?? null,
        ticketUrl: occ?.next?.ticketUrl ?? null,
        occurrenceCount: occ?.count ?? 0,
      };
    })
    // Sorteer op nextOccurrence; afgelopen events achteraan.
    .sort((a, b) => {
      const aT = a.startsAt ? a.startsAt.getTime() : Infinity;
      const bT = b.startsAt ? b.startsAt.getTime() : Infinity;
      return aT - bT;
    });

  return c.json({ events });
});

savesRoute.post('/', async (c) => {
  const userId = await requireUserId(c);
  if (typeof userId !== 'string') return userId;

  const body = (await c.req.json()) as { eventId?: string };
  const eventId = body.eventId;
  if (!eventId) return c.json({ error: 'eventId is verplicht' }, 400);

  const existing = await db
    .select()
    .from(schema.saves)
    .where(
      and(eq(schema.saves.userId, userId), eq(schema.saves.eventId, eventId))
    )
    .limit(1);

  if (existing.length > 0) {
    await db
      .delete(schema.saves)
      .where(
        and(eq(schema.saves.userId, userId), eq(schema.saves.eventId, eventId))
      );
    return c.json({ saved: false });
  }

  // Bestaat het event überhaupt? Voorkomt dangling save-rows.
  const [event] = await db
    .select({ id: schema.events.id })
    .from(schema.events)
    .where(eq(schema.events.id, eventId))
    .limit(1);
  if (!event) return c.json({ error: 'event niet gevonden' }, 404);

  await db.insert(schema.saves).values({
    userId,
    eventId,
  });
  return c.json({ saved: true });
});
