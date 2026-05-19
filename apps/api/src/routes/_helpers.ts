import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Context } from 'hono';

import { auth } from '../auth.js';
import { db, schema } from '../db/index.js';

export async function maybeUserId(c: Context): Promise<string | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user.id ?? null;
}

/**
 * Geef de set vriend-IDs terug die volgens `visibility` toegestaan zijn
 * om data van `ownerId` te zien.
 *
 *   - `friends`   → alle accepted friends van owner
 *   - `favorites` → alleen vrienden die owner als favoriet heeft (rij in
 *                   friend_favorites waar userId = ownerId)
 *   - `private`   → leeg
 *
 * Gebruikt voor friend-pills, social feed, en spiegel-gate. Eén query
 * voor friendships + één voor favorites — daarna intersect indien
 * `favorites`.
 */
export async function allowedViewerIds(
  ownerId: string,
  visibility: 'friends' | 'favorites' | 'private'
): Promise<Set<string>> {
  if (visibility === 'private') return new Set();

  const friendships = await db
    .select({
      fromUserId: schema.friendships.fromUserId,
      toUserId: schema.friendships.toUserId,
    })
    .from(schema.friendships)
    .where(
      and(
        eq(schema.friendships.status, 'accepted'),
        or(
          eq(schema.friendships.fromUserId, ownerId),
          eq(schema.friendships.toUserId, ownerId)
        )
      )
    );
  const friendIds = friendships.map((f) =>
    f.fromUserId === ownerId ? f.toUserId : f.fromUserId
  );
  if (friendIds.length === 0) return new Set();

  if (visibility === 'friends') return new Set(friendIds);

  // 'favorites' — alleen vrienden die de owner expliciet als favoriet
  // heeft gemarkeerd. Niet symmetrisch: of de viewer mij óók favoriet
  // vindt doet niet ter zake; eigenaar bepaalt.
  const favs = await db
    .select({ friendId: schema.friendFavorites.friendId })
    .from(schema.friendFavorites)
    .where(
      and(
        eq(schema.friendFavorites.userId, ownerId),
        inArray(schema.friendFavorites.friendId, friendIds)
      )
    );
  return new Set(favs.map((f) => f.friendId));
}

const FRIEND_PILL_LIMIT = 3;

export type FriendBadge = {
  id: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
};

/**
 * Voor een gegeven set occurrence-IDs: welke van mijn vrienden hebben dit
 * specifieke moment opgeslagen? Limiet per occurrence = FRIEND_PILL_LIMIT,
 * in naam-volgorde, plus een totaal-tellertje. Privacy-gate: vrienden met
 * `savesVisibility='private'` worden niet meegerekend.
 *
 * Door op occurrence-niveau te filteren tonen list-rijen alleen vrienden
 * die naar díe specifieke voorstelling gaan — een film op woensdag laat
 * niet zien dat vriend X de maandag-voorstelling heeft gesaved.
 */
export async function buildFriendsByOccurrence(
  meId: string,
  occurrenceIds: string[]
): Promise<Map<string, { friends: FriendBadge[]; count: number }>> {
  const map = new Map<string, { friends: FriendBadge[]; count: number }>();
  if (occurrenceIds.length === 0) return map;

  const friendships = await db
    .select({
      fromUserId: schema.friendships.fromUserId,
      toUserId: schema.friendships.toUserId,
    })
    .from(schema.friendships)
    .where(
      and(
        eq(schema.friendships.status, 'accepted'),
        or(
          eq(schema.friendships.fromUserId, meId),
          eq(schema.friendships.toUserId, meId)
        )
      )
    );
  const friendIds = friendships.map((f) =>
    f.fromUserId === meId ? f.toUserId : f.fromUserId
  );
  if (friendIds.length === 0) return map;

  // Welke van mijn vrienden hebben mij als favoriet gemarkeerd? Dat
  // bepaalt wie z'n 'favorites'-saves ik mag zien.
  const favoritedByRows = await db
    .select({ ownerId: schema.friendFavorites.userId })
    .from(schema.friendFavorites)
    .where(
      and(
        eq(schema.friendFavorites.friendId, meId),
        inArray(schema.friendFavorites.userId, friendIds)
      )
    );
  const favoritedMe = new Set(favoritedByRows.map((r) => r.ownerId));

  const rows = await db
    .select({
      occurrenceId: schema.saves.occurrenceId,
      id: schema.users.id,
      name: schema.users.name,
      handle: schema.users.handle,
      avatarUrl: schema.users.avatarUrl,
      savesVisibility: schema.users.savesVisibility,
    })
    .from(schema.saves)
    .innerJoin(schema.users, eq(schema.users.id, schema.saves.userId))
    .where(
      and(
        inArray(schema.saves.userId, friendIds),
        inArray(schema.saves.occurrenceId, occurrenceIds),
        inArray(schema.users.savesVisibility, ['friends', 'favorites'])
      )
    );

  for (const r of rows) {
    // Gate: 'favorites'-visibility verlangt dat de owner mij in z'n
    // favorieten heeft staan. 'friends' zien alle vrienden zonder verdere
    // check.
    if (r.savesVisibility === 'favorites' && !favoritedMe.has(r.id)) continue;
    const entry = map.get(r.occurrenceId) ?? { friends: [], count: 0 };
    entry.count += 1;
    if (entry.friends.length < FRIEND_PILL_LIMIT) {
      entry.friends.push({
        id: r.id,
        name: r.name,
        handle: r.handle,
        avatarUrl: r.avatarUrl,
      });
    }
    map.set(r.occurrenceId, entry);
  }
  for (const entry of map.values()) {
    entry.friends.sort((a, b) => a.name.localeCompare(b.name));
  }
  return map;
}

export type SeriesBadge = {
  id: string;
  slug: string;
  name: string;
  imageUrl: string | null;
};

/**
 * Voor een gegeven set event-IDs: welke (nog lopende) series horen bij
 * elk event? Eén event kan in meerdere series zitten (M:N). Volgorde:
 * alfabetisch op naam zodat de UI deterministisch de eerste kan tonen.
 *
 * Filtert op `series.endsAt`: afgelopen series (endsAt < now) verdwijnen
 * automatisch uit pills/tags zodat een Paradiso-event in oktober niet
 * blijft hangen met "Onderdeel van ADE 2024". Series zonder `endsAt`
 * gelden als doorlopend en blijven zichtbaar.
 */
export async function buildSeriesByEvent(
  eventIds: string[]
): Promise<Map<string, SeriesBadge[]>> {
  const map = new Map<string, SeriesBadge[]>();
  if (eventIds.length === 0) return map;

  const stillActive = or(
    isNull(schema.series.endsAt),
    gt(schema.series.endsAt, new Date())
  )!;
  const published = eq(schema.series.published, true);

  const rows = await db
    .select({
      eventId: schema.eventsInSeries.eventId,
      id: schema.series.id,
      slug: schema.series.slug,
      name: schema.series.name,
      imageUrl: schema.series.imageUrl,
    })
    .from(schema.eventsInSeries)
    .innerJoin(
      schema.series,
      eq(schema.series.id, schema.eventsInSeries.seriesId)
    )
    .where(
      and(
        inArray(schema.eventsInSeries.eventId, eventIds),
        stillActive,
        published
      )
    )
    .orderBy(asc(schema.series.name));

  for (const r of rows) {
    const list = map.get(r.eventId) ?? [];
    list.push({
      id: r.id,
      slug: r.slug,
      name: r.name,
      imageUrl: r.imageUrl,
    });
    map.set(r.eventId, list);
  }
  return map;
}

export type OccurrenceRow = typeof schema.occurrences.$inferSelect;

export type LineupEntry = {
  name: string;
  role?: 'dj' | 'support' | 'headliner' | 'act';
};

export type ApiOccurrenceShape = {
  id: string;
  startsAt: Date;
  endsAt: Date | null;
  priceCents: number | null;
  priceNote: string | null;
  ticketUrl: string | null;
  room: string | null;
  lineup: LineupEntry[] | null;
  status: 'scheduled' | 'cancelled' | 'sold_out';
  /** Venue voor deze occurrence. Voor films kan dit afwijken van het
      event-level venue (een film draait in meerdere bioscopen).
      Nullable voor zeldzame rijen die geen venueId hebben — caller
      valt dan terug op event.venue. */
  venue: {
    id: string;
    slug: string;
    name: string;
  } | null;
};

export type EventOccurrenceData = {
  /** Eerstvolgende of doorlopende occurrence, of `null` als alle voorbij. */
  next: ApiOccurrenceShape | null;
  /** Aantal komende/lopende occurrences. */
  count: number;
  /** Volledige lijst (sorted op startsAt asc). */
  all: ApiOccurrenceShape[];
};

type OccurrenceVenueLite = { id: string; slug: string; name: string };

function toShape(
  row: OccurrenceRow,
  venueMap: Map<string, OccurrenceVenueLite> = new Map()
): ApiOccurrenceShape {
  const venue = row.venueId ? (venueMap.get(row.venueId) ?? null) : null;
  return {
    id: row.id,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    priceCents: row.priceCents,
    priceNote: row.priceNote,
    ticketUrl: row.ticketUrl,
    room: row.room,
    lineup: (row.lineup as LineupEntry[] | null) ?? null,
    status: row.status,
    venue,
  };
}

/** Batched venue-lookup voor occurrence-rijen. Returnt een map die
    `toShape` kan invullen — vermijdt N+1 zonder de hoofdquery te
    verstoren (occurrence-select blijft `*` zodat row-typing intact
    blijft). */
async function loadOccurrenceVenues(
  rows: { venueId: string | null }[]
): Promise<Map<string, OccurrenceVenueLite>> {
  const ids = [
    ...new Set(rows.map((r) => r.venueId).filter((v): v is string => Boolean(v))),
  ];
  if (ids.length === 0) return new Map();
  const venuesData = await db
    .select({
      id: schema.venues.id,
      slug: schema.venues.slug,
      name: schema.venues.name,
    })
    .from(schema.venues)
    .where(inArray(schema.venues.id, ids));
  return new Map(venuesData.map((v) => [v.id, v]));
}

/**
 * Voor een gegeven set event-IDs: laad alle occurrences die nog actueel zijn
 * (start in de toekomst, óf endsAt nog niet voorbij voor doorlopende
 * tentoonstellingen). Alleen `status='scheduled'` of `sold_out` —
 * `cancelled` filtert eruit.
 *
 * Voor events waar geen actuele occurrence (meer) is en `includePast=true`,
 * pakken we de meest recente afgelopen occurrence als `next` zodat saved-
 * events ("Gered") altijd een datum tonen.
 *
 * Retourneert per event-ID: de eerstvolgende (of laatste) occurrence
 * (`next`), het totaal aantal actuele occurrences (`count`), en de
 * volledige lijst van actuele occurrences (`all`).
 */
export async function buildOccurrencesByEvent(
  eventIds: string[],
  options?: { from?: Date; to?: Date; includePast?: boolean }
): Promise<Map<string, EventOccurrenceData>> {
  const map = new Map<string, EventOccurrenceData>();
  if (eventIds.length === 0) return map;

  const from = options?.from ?? new Date();
  const to = options?.to;

  const conditions = [
    inArray(schema.occurrences.eventId, eventIds),
    // Filter: zolang de eindtijd in de toekomst ligt blijft het zichtbaar.
    // Voor occurrences zonder endsAt nemen we startsAt + 4u als default
    // duur — past redelijk voor films (~2u), voorstellingen (~2u),
    // concerten (~2-3u) en club-nachten (~6u, dus iets te kort maar
    // dichter bij waarheid dan 0). Voor exact-tijd events zoals een
    // ochtend-event 09:00-10:00 met endsAt=10:00: weg om 10:01.
    sql`COALESCE(${schema.occurrences.endsAt}, ${schema.occurrences.startsAt} + INTERVAL '4 hours') >= ${from}`,
    sql`${schema.occurrences.status} <> 'cancelled'`,
  ];
  if (to) {
    conditions.push(lte(schema.occurrences.startsAt, to));
  }

  const rows = await db
    .select()
    .from(schema.occurrences)
    .where(and(...conditions))
    .orderBy(asc(schema.occurrences.startsAt));

  const venueMap = await loadOccurrenceVenues(rows);
  for (const row of rows) {
    let entry = map.get(row.eventId);
    if (!entry) {
      entry = { next: null, count: 0, all: [] };
      map.set(row.eventId, entry);
    }
    const shape = toShape(row, venueMap);
    entry.all.push(shape);
    if (entry.next === null) entry.next = shape;
    entry.count += 1;
  }

  // Voor events zonder toekomstige occurrence: pak de meest recente
  // afgelopen occurrence als display-fallback. Saved/friend-saved events
  // moeten altijd een datum kunnen tonen, ook al zijn ze voorbij.
  if (options?.includePast) {
    const missing = eventIds.filter((id) => !map.has(id));
    if (missing.length > 0) {
      const pastRows = await db
        .select()
        .from(schema.occurrences)
        .where(
          and(
            inArray(schema.occurrences.eventId, missing),
            sql`${schema.occurrences.status} <> 'cancelled'`
          )
        )
        .orderBy(desc(schema.occurrences.startsAt));
      const pastVenueMap = await loadOccurrenceVenues(pastRows);
      const seen = new Set<string>();
      for (const row of pastRows) {
        if (seen.has(row.eventId)) continue;
        seen.add(row.eventId);
        const shape = toShape(row, pastVenueMap);
        map.set(row.eventId, { next: shape, count: 0, all: [] });
      }
    }
  }
  return map;
}

/**
 * Variant voor list-endpoints (Avond/Agenda/Kaart): gefilterd op date-range.
 * Een event hoort tot het resultaat als minstens één van zijn occurrences
 * binnen `[from, to]` valt — voor exhibitions als hun [startsAt, endsAt]
 * range overlapt met de zoekrange.
 *
 * Retourneert een Set van event-IDs (de events die getoond moeten worden)
 * + de occurrence-data per event.
 */
export async function findEventsWithOccurrencesInRange(
  options: { from?: Date; to?: Date; eventIds?: string[] }
): Promise<{
  eventIds: string[];
  byEvent: Map<string, EventOccurrenceData>;
}> {
  const from = options.from ?? new Date();
  const to = options.to;

  const conditions = [
    // Filter op effectieve eindtijd: endsAt als gezet, anders startsAt
    // + 4u als default duur (films/concerten/clubs vallen daarbinnen).
    // Exhibitions hebben endsAt altijd gezet (de loopduur), dus die
    // worden hier vanzelf goed afgehandeld.
    sql`COALESCE(${schema.occurrences.endsAt}, ${schema.occurrences.startsAt} + INTERVAL '4 hours') >= ${from}`,
    sql`${schema.occurrences.status} <> 'cancelled'`,
  ];
  if (to) conditions.push(lte(schema.occurrences.startsAt, to));
  if (options.eventIds && options.eventIds.length > 0) {
    conditions.push(inArray(schema.occurrences.eventId, options.eventIds));
  }

  const rows = await db
    .select({
      id: schema.occurrences.id,
      eventId: schema.occurrences.eventId,
      venueId: schema.occurrences.venueId,
      startsAt: schema.occurrences.startsAt,
      endsAt: schema.occurrences.endsAt,
      priceCents: schema.occurrences.priceCents,
      priceNote: schema.occurrences.priceNote,
      ticketUrl: schema.occurrences.ticketUrl,
      room: schema.occurrences.room,
      lineup: schema.occurrences.lineup,
      status: schema.occurrences.status,
      createdAt: schema.occurrences.createdAt,
    })
    .from(schema.occurrences)
    .innerJoin(schema.events, eq(schema.events.id, schema.occurrences.eventId))
    .where(and(...conditions))
    .orderBy(asc(schema.occurrences.startsAt));

  const venueMap = await loadOccurrenceVenues(rows);
  const byEvent = new Map<string, EventOccurrenceData>();
  const eventOrder: string[] = [];
  for (const row of rows) {
    let entry = byEvent.get(row.eventId);
    if (!entry) {
      entry = { next: null, count: 0, all: [] };
      byEvent.set(row.eventId, entry);
      eventOrder.push(row.eventId);
    }
    const shape = toShape(row, venueMap);
    entry.all.push(shape);
    if (entry.next === null) entry.next = shape;
    entry.count += 1;
  }
  // eventOrder reflecteert sortering op nextOccurrence.startsAt asc
  return { eventIds: eventOrder, byEvent };
}

/**
 * Helper om event-row + nextOccurrence te combineren tot de
 * gedenormaliseerde shape die de mobile-app verwacht: timing/prijs/ticket
 * komen vanaf `next`, kind/title/etc komen vanaf event.
 */
export function denormalizeEvent<T extends { id: string }>(
  event: T,
  occ: EventOccurrenceData | undefined
): T & {
  startsAt: Date | null;
  endsAt: Date | null;
  priceCents: number | null;
  priceNote: string | null;
  ticketUrl: string | null;
  occurrenceCount: number;
} {
  return {
    ...event,
    startsAt: occ?.next?.startsAt ?? null,
    endsAt: occ?.next?.endsAt ?? null,
    priceCents: occ?.next?.priceCents ?? null,
    priceNote: occ?.next?.priceNote ?? null,
    ticketUrl: occ?.next?.ticketUrl ?? null,
    occurrenceCount: occ?.count ?? 0,
  };
}
