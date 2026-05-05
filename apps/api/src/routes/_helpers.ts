import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Context } from 'hono';

import { auth } from '../auth.js';
import { db, schema } from '../db/index.js';

export async function maybeUserId(c: Context): Promise<string | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user.id ?? null;
}

const FRIEND_PILL_LIMIT = 3;

export type FriendBadge = {
  id: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
};

/**
 * Voor een gegeven set event-IDs: welke van mijn vrienden hebben elk event
 * opgeslagen? Limiet per event = FRIEND_PILL_LIMIT, in naam-volgorde, plus
 * een totaal-tellertje. Privacy-gate: vrienden met `savesVisibility='private'`
 * worden niet meegerekend.
 */
export async function buildFriendsByEvent(
  meId: string,
  eventIds: string[]
): Promise<Map<string, { friends: FriendBadge[]; count: number }>> {
  const map = new Map<string, { friends: FriendBadge[]; count: number }>();
  if (eventIds.length === 0) return map;

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

  const rows = await db
    .select({
      eventId: schema.saves.eventId,
      id: schema.users.id,
      name: schema.users.name,
      handle: schema.users.handle,
      avatarUrl: schema.users.avatarUrl,
    })
    .from(schema.saves)
    .innerJoin(schema.users, eq(schema.users.id, schema.saves.userId))
    .where(
      and(
        inArray(schema.saves.userId, friendIds),
        inArray(schema.saves.eventId, eventIds),
        eq(schema.users.savesVisibility, 'friends')
      )
    );

  for (const r of rows) {
    const entry = map.get(r.eventId) ?? { friends: [], count: 0 };
    entry.count += 1;
    if (entry.friends.length < FRIEND_PILL_LIMIT) {
      entry.friends.push({
        id: r.id,
        name: r.name,
        handle: r.handle,
        avatarUrl: r.avatarUrl,
      });
    }
    map.set(r.eventId, entry);
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
};

export type EventOccurrenceData = {
  /** Eerstvolgende of doorlopende occurrence, of `null` als alle voorbij. */
  next: ApiOccurrenceShape | null;
  /** Aantal komende/lopende occurrences. */
  count: number;
  /** Volledige lijst (sorted op startsAt asc). */
  all: ApiOccurrenceShape[];
};

function toShape(row: OccurrenceRow): ApiOccurrenceShape {
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
  };
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
    // Voor doorlopende exhibitions: COALESCE(ends_at, starts_at) >= from.
    // Hiermee blijft een tentoonstelling met startsAt=1 mei en endsAt=6 mei
    // op 3 mei zichtbaar.
    sql`COALESCE(${schema.occurrences.endsAt}, ${schema.occurrences.startsAt}) >= ${from}`,
    // Verberg gecancelde momenten.
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

  for (const row of rows) {
    let entry = map.get(row.eventId);
    if (!entry) {
      entry = { next: null, count: 0, all: [] };
      map.set(row.eventId, entry);
    }
    const shape = toShape(row);
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
      const seen = new Set<string>();
      for (const row of pastRows) {
        if (seen.has(row.eventId)) continue;
        seen.add(row.eventId);
        const shape = toShape(row);
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
    sql`COALESCE(${schema.occurrences.endsAt}, ${schema.occurrences.startsAt}) >= ${from}`,
    sql`${schema.occurrences.status} <> 'cancelled'`,
  ];
  if (to) conditions.push(lte(schema.occurrences.startsAt, to));
  if (options.eventIds && options.eventIds.length > 0) {
    conditions.push(inArray(schema.occurrences.eventId, options.eventIds));
  }

  const rows = await db
    .select()
    .from(schema.occurrences)
    .where(and(...conditions))
    .orderBy(asc(schema.occurrences.startsAt));

  const byEvent = new Map<string, EventOccurrenceData>();
  const eventOrder: string[] = [];
  for (const row of rows) {
    let entry = byEvent.get(row.eventId);
    if (!entry) {
      entry = { next: null, count: 0, all: [] };
      byEvent.set(row.eventId, entry);
      eventOrder.push(row.eventId);
    }
    const shape = toShape(row);
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
