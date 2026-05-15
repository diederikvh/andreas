import { and, asc, desc, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import { auth } from '../auth.js';
import { db, schema } from '../db/index.js';

async function requireUserId(c: Context): Promise<string | Response> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  return session.user.id;
}

export const savesRoute = new Hono();

/**
 * Lijst van mijn saves — één rij per gesaveterde occurrence. Een film
 * met 7 voorstellingen waarvan ik er drie heb gesaved geeft drie rows
 * met hun eigen startsAt/priceCents/ticketUrl.
 *
 * Sorteer-volgorde: toekomstige saves eerst (chronologisch), daarna
 * voorbije van meest recent naar oudste — zodat de Gered-tab "Vorige"-
 * sectie de meest recent voorbije bovenaan toont.
 */
savesRoute.get('/', async (c) => {
  const userId = await requireUserId(c);
  if (typeof userId !== 'string') return userId;

  const rows = await db
    .select({
      // event-veld
      id: schema.events.id,
      title: schema.events.title,
      description: schema.events.description,
      kind: schema.events.kind,
      imageUrl: schema.events.imageUrl,
      category: schema.events.category,
      featured: schema.events.featured,
      // occurrence-veld
      occurrenceId: schema.occurrences.id,
      startsAt: schema.occurrences.startsAt,
      endsAt: schema.occurrences.endsAt,
      priceCents: schema.occurrences.priceCents,
      priceNote: schema.occurrences.priceNote,
      ticketUrl: schema.occurrences.ticketUrl,
      room: schema.occurrences.room,
      lineup: schema.occurrences.lineup,
      status: schema.occurrences.status,
      // venue
      venue: {
        id: schema.venues.id,
        slug: schema.venues.slug,
        name: schema.venues.name,
        address: schema.venues.address,
        lat: schema.venues.lat,
        lng: schema.venues.lng,
        imageUrl: schema.venues.imageUrl,
        priceNote: schema.venues.priceNote,
      },
      savedAt: schema.saves.createdAt,
    })
    .from(schema.saves)
    .innerJoin(
      schema.occurrences,
      eq(schema.saves.occurrenceId, schema.occurrences.id)
    )
    .innerJoin(schema.events, eq(schema.occurrences.eventId, schema.events.id))
    .innerJoin(schema.venues, eq(schema.events.venueId, schema.venues.id))
    .where(
      and(
        eq(schema.saves.userId, userId),
        eq(schema.events.published, true),
        eq(schema.venues.published, true)
      )
    );

  const now = Date.now();
  const events = rows.sort((a, b) => {
    const aT = a.startsAt.getTime();
    const bT = b.startsAt.getTime();
    const aFuture = aT >= now;
    const bFuture = bT >= now;
    if (aFuture && !bFuture) return -1;
    if (!aFuture && bFuture) return 1;
    if (aFuture) return aT - bT; // beide toekomst → oplopend
    return bT - aT; // beide voorbij → meest recent eerst
  });

  return c.json({ events });
});

const SAVE_SOURCES = [
  'venue',
  'friend',
  'search',
  'op-gevoel',
  'avond',
  'agenda',
  'kaart',
  'series',
  'gered',
  'other',
] as const;
type SaveSource = (typeof SAVE_SOURCES)[number];

function parseSaveSource(raw: unknown): SaveSource | null {
  return typeof raw === 'string' && (SAVE_SOURCES as readonly string[]).includes(raw)
    ? (raw as SaveSource)
    : null;
}

/**
 * Toggle save voor een occurrence. Idempotent: bestond de save al? dan
 * deletet 'ie. Anders insert. Body: `{ occurrenceId, source? }`.
 *
 * `source` is optioneel maar elke client-call zou 'm moeten meegeven —
 * het voedt de discovery-trail op de persoonlijke spiegel ("via welke
 * route vond je dit?"). Onbekend → null, niet 'other', zodat we per
 * scherm kunnen meten of het call-site z'n attributie meestuurt.
 */
savesRoute.post('/', async (c) => {
  const userId = await requireUserId(c);
  if (typeof userId !== 'string') return userId;

  const body = (await c.req.json()) as {
    occurrenceId?: string;
    source?: string;
  };
  const occurrenceId = body.occurrenceId;
  if (!occurrenceId) {
    return c.json({ error: 'occurrenceId is verplicht' }, 400);
  }
  const source = parseSaveSource(body.source);

  const existing = await db
    .select()
    .from(schema.saves)
    .where(
      and(
        eq(schema.saves.userId, userId),
        eq(schema.saves.occurrenceId, occurrenceId)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    await db
      .delete(schema.saves)
      .where(
        and(
          eq(schema.saves.userId, userId),
          eq(schema.saves.occurrenceId, occurrenceId)
        )
      );
    return c.json({ saved: false });
  }

  // Bestaat de occurrence? Voorkomt dangling rows.
  const [occ] = await db
    .select({ id: schema.occurrences.id })
    .from(schema.occurrences)
    .where(eq(schema.occurrences.id, occurrenceId))
    .limit(1);
  if (!occ) return c.json({ error: 'occurrence niet gevonden' }, 404);

  await db.insert(schema.saves).values({ userId, occurrenceId, source });
  return c.json({ saved: true });
});
