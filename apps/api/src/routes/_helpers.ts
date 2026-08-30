import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
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

  const savedRows = await db
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

  // Friends die 'going' hebben geantwoord op een (niet-revoked) invitation
  // voor deze occurrence. Een vriend die jouw invite accepteert verschijnt
  // op detail (crew) — diezelfde signal hoort ook op de lijst-pill. Anders
  // zie je op /clubs of /live alleen je vriend als-ie zelf saved, maar
  // mist je 'm als-ie alleen RSVP'd.
  const goingRows = await db
    .select({
      occurrenceId: schema.invitations.occurrenceId,
      id: schema.users.id,
      name: schema.users.name,
      handle: schema.users.handle,
      avatarUrl: schema.users.avatarUrl,
      savesVisibility: schema.users.savesVisibility,
    })
    .from(schema.invitationResponses)
    .innerJoin(
      schema.invitations,
      eq(schema.invitations.id, schema.invitationResponses.invitationId)
    )
    .innerJoin(
      schema.users,
      eq(schema.users.id, schema.invitationResponses.userId)
    )
    .where(
      and(
        eq(schema.invitationResponses.status, 'going'),
        inArray(schema.invitationResponses.userId, friendIds),
        isNull(schema.invitations.revokedAt),
        inArray(schema.invitations.occurrenceId, occurrenceIds),
        inArray(schema.users.savesVisibility, ['friends', 'favorites'])
      )
    );

  // Dedupe per occurrence: een vriend die zowel saved als 'going' is, telt
  // één keer. Set per occurrence-id over user-ids.
  const seenByOcc = new Map<string, Set<string>>();
  const addRow = (r: {
    occurrenceId: string;
    id: string;
    name: string;
    handle: string | null;
    avatarUrl: string | null;
    savesVisibility: 'friends' | 'favorites' | 'private';
  }) => {
    if (r.savesVisibility === 'favorites' && !favoritedMe.has(r.id)) return;
    const seen = seenByOcc.get(r.occurrenceId) ?? new Set<string>();
    if (seen.has(r.id)) return;
    seen.add(r.id);
    seenByOcc.set(r.occurrenceId, seen);
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
  };
  for (const r of savedRows) addRow(r);
  for (const r of goingRows) addRow(r);
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
  venue: OccurrenceVenueLite | null;
};

export type EventOccurrenceData = {
  /** Eerstvolgende of doorlopende occurrence, of `null` als alle voorbij. */
  next: ApiOccurrenceShape | null;
  /** Aantal komende/lopende occurrences. */
  count: number;
  /** Volledige lijst (sorted op startsAt asc). */
  all: ApiOccurrenceShape[];
};

/**
 * Kies de te tonen ("head") occurrence binnen een venster: de eerste die in
 * [from, to) valt, anders de eerstvolgende (`next`). Gedeeld door de /zoek-
 * en MCP-hydration zodat die keuze-regel niet uit elkaar loopt.
 */
export function headOccurrenceInWindow(
  occ: EventOccurrenceData,
  from: Date,
  to: Date
): { inWindow: ApiOccurrenceShape[]; head: ApiOccurrenceShape | null } {
  const inWindow = occ.all.filter((o) => o.startsAt >= from && o.startsAt < to);
  return { inWindow, head: inWindow[0] ?? occ.next };
}

type OccurrenceVenueLite = {
  id: string;
  slug: string;
  name: string;
  /** Coords zijn nodig voor de Kaart-pin per occurrence (multi-venue
      films krijgen een pin per bioscoop). Voor andere consumenten
      ongebruikt — overhead is minimaal (twee floats per occurrence). */
  lat: number;
  lng: number;
  /** Voor de venue-tone-pill in de kaart-sheet bij een per-occurrence
      MapEvent. */
  type: string | null;
};

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
      lat: schema.venues.lat,
      lng: schema.venues.lng,
      type: schema.venues.type,
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
  options: {
    from?: Date;
    to?: Date;
    eventIds?: string[];
    /** Scope alleen occurrences waar de effectieve venue (occurrence-
        venueId óf, als die NULL is, event-venueId) deze venue-id is.
        Gebruikt door /venues/:slug zodat we voor Eye alleen de
        Eye-screenings van Anora tonen, niet Anora's Kriterion-rij. */
    venueId?: string;
  }
): Promise<{
  eventIds: string[];
  byEvent: Map<string, EventOccurrenceData>;
}> {
  const from = options.from ?? new Date();
  const to = options.to;

  const conditions = [
    // Filter op effectieve eindtijd: endsAt als gezet, anders een default-
    // duur ná de start. Categorie-bewust (spiegelt effectiveEndsAtMs in de
    // app): live muziek (concerten/clubs) krijgt 4u want mensen komen laat;
    // film/theater/kunst/lezing 1u grace, zodat een 18:10-film om 21:48 niet
    // meer in de feeds (Voor jou, /theater, /film, …) blijft hangen.
    // Exhibitions hebben endsAt altijd gezet, dus die vallen hier vanzelf goed.
    sql`COALESCE(${schema.occurrences.endsAt}, ${schema.occurrences.startsAt} + CASE WHEN ${schema.events.category} = 'Muziek' THEN INTERVAL '4 hours' ELSE INTERVAL '1 hour' END) >= ${from}`,
    sql`${schema.occurrences.status} <> 'cancelled'`,
  ];
  if (to) conditions.push(lte(schema.occurrences.startsAt, to));
  if (options.eventIds && options.eventIds.length > 0) {
    conditions.push(inArray(schema.occurrences.eventId, options.eventIds));
  }
  if (options.venueId) {
    conditions.push(
      sql`COALESCE(${schema.occurrences.venueId}, ${schema.events.venueId}) = ${options.venueId}`
    );
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
  /** Venue van de eerstvolgende occurrence. Voor films met meerdere
      bioscopen wijkt dit af van `event.venue` (event-niveau venue is
      "wie scrapete dit het eerst", niet "waar speelt de volgende
      voorstelling"). Mobile rendert dit i.p.v. event.venue.name in
      lijstrijen zodat een Anora-rij die op woensdag bij Kriterion draait
      ook Kriterion toont, niet Eye. */
  nextOccurrenceVenue: OccurrenceVenueLite | null;
} {
  return {
    ...event,
    startsAt: occ?.next?.startsAt ?? null,
    endsAt: occ?.next?.endsAt ?? null,
    priceCents: occ?.next?.priceCents ?? null,
    priceNote: occ?.next?.priceNote ?? null,
    ticketUrl: occ?.next?.ticketUrl ?? null,
    occurrenceCount: occ?.count ?? 0,
    nextOccurrenceVenue: occ?.next?.venue ?? null,
  };
}

/**
 * Smaakprofiel van één gebruiker: wat trok je aan, en wat wees je af.
 *
 * Twee bronnen, zelfde vorm. Saves zijn het ja-signaal, dismisses het
 * nee-signaal. Dat laatste lag er al maanden (elke left-swipe op
 * /op-gevoel, en sinds kort elk kruisje op /new) maar werd alléén
 * gebruikt om iets te verbergen — het woog nergens in mee. Daardoor
 * leerde de app niets van "nee", terwijl dat de helft van de gebaren is.
 *
 * Beide kanten krijgen dezelfde recentheids-decay: wat je vorig jaar
 * vond weegt minder dan wat je vorige week vond.
 *
 * ponytail: we tellen rauwe gebaren, geen impressies. Een venue die veel
 * programmeert verzamelt daardoor mechanisch meer nee's — vandaar de caps
 * bij het scoren. Als dat alsnog scheeftrekt is de volgende stap delen
 * door hoe vaak je 'm te zien kreeg, en dat vraagt impressie-logging.
 */
export type TasteProfile = {
  genreLike: Map<string, number>;
  genreDislike: Map<string, number>;
  venueLike: Map<string, number>;
  venueDislike: Map<string, number>;
  sceneLike: Map<string, number>;
  sceneDislike: Map<string, number>;
  wijkLike: Map<string, number>;
  wijkDislike: Map<string, number>;
  /** Aantal onderliggende gebaren — voor "heeft deze user een profiel?". */
  likeCount: number;
  dislikeCount: number;
};

const TASTE_HALF_LIFE_MS = 60 * 24 * 3600 * 1000;
/** Een save via een actief gebaar (swipe, zoek) telt zwaarder dan een passieve. */
const ACTIVE_SOURCES = new Set(['op-gevoel', 'search', 'gered', 'new']);

export async function buildTasteProfile(
  userId: string,
  displayGenres: SQL<string[]>
): Promise<TasteProfile> {
  const columns = {
    genres: displayGenres,
    venueId: schema.events.venueId,
    scene: schema.venues.scene,
    wijk: schema.venues.wijk,
  };

  const NOT_INTENT = sql<boolean>`false`;

  const [saved, going, dislikes] = await Promise.all([
    db
      .select({
        ...columns,
        source: schema.saves.source,
        at: schema.saves.createdAt,
        intent: NOT_INTENT,
      })
      .from(schema.saves)
      .innerJoin(
        schema.occurrences,
        eq(schema.saves.occurrenceId, schema.occurrences.id)
      )
      .innerJoin(schema.events, eq(schema.occurrences.eventId, schema.events.id))
      .innerJoin(schema.venues, eq(schema.events.venueId, schema.venues.id))
      .where(eq(schema.saves.userId, userId)),
    // "Ik ga" telt zwaarder dan een hartje — zie GOING_WEIGHT. Wie ook
    // hartje én ga aanzet telt twee keer, en dat klopt: dat is interesse
    // plus intentie.
    db
      .select({
        ...columns,
        source: schema.attendance.source,
        at: schema.attendance.createdAt,
        intent: sql<boolean>`true`,
      })
      .from(schema.attendance)
      .innerJoin(
        schema.occurrences,
        eq(schema.attendance.occurrenceId, schema.occurrences.id)
      )
      .innerJoin(schema.events, eq(schema.occurrences.eventId, schema.events.id))
      .innerJoin(schema.venues, eq(schema.events.venueId, schema.venues.id))
      .where(eq(schema.attendance.userId, userId)),
    db
      .select({
        ...columns,
        source: schema.dismisses.source,
        at: schema.dismisses.createdAt,
        intent: NOT_INTENT,
      })
      .from(schema.dismisses)
      .innerJoin(
        schema.occurrences,
        eq(schema.dismisses.occurrenceId, schema.occurrences.id)
      )
      .innerJoin(schema.events, eq(schema.occurrences.eventId, schema.events.id))
      .innerJoin(schema.venues, eq(schema.events.venueId, schema.venues.id))
      .where(eq(schema.dismisses.userId, userId)),
  ]);
  const likes = [...saved, ...going];

  const nowMs = Date.now();
  const tally = (
    rows: typeof likes,
  ): [Map<string, number>, Map<string, number>, Map<string, number>, Map<string, number>] => {
    const genre = new Map<string, number>();
    const venue = new Map<string, number>();
    const scene = new Map<string, number>();
    const wijk = new Map<string, number>();
    for (const r of rows) {
      const ageMs = Math.max(0, nowMs - new Date(r.at).getTime());
      const recency = Math.pow(0.5, ageMs / TASTE_HALF_LIFE_MS);
      const active = r.source && ACTIVE_SOURCES.has(r.source) ? 1.3 : 1.0;
      const w = recency * active * (r.intent ? GOING_WEIGHT : 1);
      for (const g of r.genres ?? []) {
        const key = g.trim().toLowerCase();
        if (key) genre.set(key, (genre.get(key) ?? 0) + w);
      }
      venue.set(r.venueId, (venue.get(r.venueId) ?? 0) + w);
      if (r.scene) scene.set(r.scene, (scene.get(r.scene) ?? 0) + w);
      if (r.wijk) wijk.set(r.wijk, (wijk.get(r.wijk) ?? 0) + w);
    }
    return [genre, venue, scene, wijk];
  };

  const [genreLike, venueLike, sceneLike, wijkLike] = tally(likes);
  const [genreDislike, venueDislike, sceneDislike, wijkDislike] = tally(dislikes);

  return {
    genreLike,
    genreDislike,
    venueLike,
    venueDislike,
    sceneLike,
    sceneDislike,
    wijkLike,
    wijkDislike,
    likeCount: likes.length,
    dislikeCount: dislikes.length,
  };
}

/**
 * Hoe zwaar een nee weegt ten opzichte van een ja. Bewust lager dan 1:
 * "ik wil hier heen" is een scherper signaal dan "nu even niet" — dat
 * laatste kan net zo goed over de datum of je humeur gaan als over het
 * genre. En omdat we geen impressies tellen, mag één druk programmerende
 * venue zichzelf niet wegdrukken; vandaar ook de caps.
 */
/**
 * Hoe zwaar "ik ga" telt ten opzichte van een hartje. Een hartje is
 * "leuk"; hier heb je een avond voor vrijgemaakt. Twee is genoeg om
 * het te laten meewegen zonder dat één bezoek je hele profiel kapert —
 * de recency-halvering doet de rest.
 */
export const GOING_WEIGHT = 2;

export const DISLIKE_WEIGHT = 0.6;
export const MAX_DISLIKE_PENALTY = 4;

/** Negatieve bijdrage van één dimensie, gedempt en gecapt. */
export function dislikePenalty(raw: number, factor = 1): number {
  return Math.min(MAX_DISLIKE_PENALTY, DISLIKE_WEIGHT * factor * raw);
}

/**
 * Occurrence-kaarten voor een setje occurrence-ids, in exact de vorm die
 * `EventListRow` en de rails op de client verwachten (event + occurrence
 * + venue plat naast elkaar).
 *
 * Bestond al als de select in `/saves`; hier uitgetrokken zodat /going
 * dezelfde vorm levert zonder 'm over te schrijven. Ongesorteerd —
 * bellers bepalen zelf de volgorde, want /saves wil iets anders dan
 * /going.
 */
export async function fetchOccurrenceCards(occurrenceIds: string[]) {
  if (occurrenceIds.length === 0) return [];
  return db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      description: schema.events.description,
      kind: schema.events.kind,
      imageUrl: schema.events.imageUrl,
      category: schema.events.category,
      featured: schema.events.featured,
      occurrenceId: schema.occurrences.id,
      startsAt: schema.occurrences.startsAt,
      endsAt: schema.occurrences.endsAt,
      priceCents: schema.occurrences.priceCents,
      priceNote: schema.occurrences.priceNote,
      ticketUrl: schema.occurrences.ticketUrl,
      room: schema.occurrences.room,
      lineup: schema.occurrences.lineup,
      status: schema.occurrences.status,
      venue: {
        id: schema.venues.id,
        slug: schema.venues.slug,
        name: schema.venues.name,
        address: schema.venues.address,
        lat: schema.venues.lat,
        lng: schema.venues.lng,
        type: schema.venues.type,
        wijk: schema.venues.wijk,
        imageUrl: schema.venues.imageUrl,
        priceNote: schema.venues.priceNote,
      },
    })
    .from(schema.occurrences)
    .innerJoin(schema.events, eq(schema.occurrences.eventId, schema.events.id))
    // Films draaien in meerdere bioscopen: join op de occurrence-venue en
    // val terug op de event-venue voor rijen zonder eigen venueId.
    .innerJoin(
      schema.venues,
      eq(
        schema.venues.id,
        sql`COALESCE(${schema.occurrences.venueId}, ${schema.events.venueId})`
      )
    )
    .where(
      and(
        inArray(schema.occurrences.id, occurrenceIds),
        eq(schema.events.published, true),
        eq(schema.venues.published, true)
      )
    );
}
