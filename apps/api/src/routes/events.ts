import { aliasedTable, and, asc, count, desc, eq, gt, ilike, inArray, isNull, ne, not, or, sql, type SQL } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import { db, schema } from '../db/index.js';
import {
  buildFriendsByOccurrence,
  buildOccurrencesByEvent,
  buildSeriesByEvent,
  findEventsWithOccurrencesInRange,
  maybeUserId,
} from './_helpers.js';
import {
  getBlockedVenueIds,
  getFollowedVenueIds,
} from './venue-follows.js';

type EventCategory = 'Muziek' | 'Theater' | 'Literatuur' | 'Film' | 'Kunst' | 'Lezing';
const VALID_CATEGORIES = new Set(['Muziek', 'Theater', 'Literatuur', 'Film', 'Kunst', 'Lezing']);
const VALID_VENUE_TYPES = new Set([
  'galerie', 'museum', 'podium', 'club', 'film', 'ruimte', 'boekhandel-cafe',
]);
const VALID_TIME_BLOCKS = new Set(['ochtend', 'middag', 'avond', 'nacht']);
/** NL-local uren per tijd-blok. nacht omspant middernacht (23 + 0-5). */
const BLOCK_HOURS: Record<string, number[]> = {
  ochtend: [6, 7, 8, 9, 10, 11],
  middag: [12, 13, 14, 15, 16, 17],
  avond: [18, 19, 20, 21, 22],
  nacht: [23, 0, 1, 2, 3, 4, 5],
};

/**
 * Exhibitions hebben geen specifieke aanvangstijd — ze lopen tijdens
 * openingstijden van de venue. De scraper slaat soms toch een uur op
 * (vaak 00:00, soms een afwijkende waarde uit de bron-HTML). Mobile
 * gebruikt `isAllDayRange()` om "Hele dag" te tonen i.p.v. een tijd;
 * die heuristic vereist start=00:00 en end=23:59 (of multi-day).
 *
 * We normaliseren hier zodat client-side niets hoeft te raden:
 *  - startsAt → 00:00 lokale dag-begin (UTC ISO)
 *  - endsAt   → 23:59:59 van de eind-datum (UTC ISO)
 *
 * Geldt alleen voor kind='exhibition'. Concert/film/theater behouden
 * hun precieze tijd-info. Helper is null-safe.
 */
function normalizeExhibitionTime(
  iso: string | null,
  edge: 'start' | 'end'
): string | null {
  if (!iso) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (edge === 'start') d.setUTCHours(0, 0, 0, 0);
  else d.setUTCHours(23, 59, 59, 999);
  return d.toISOString();
}

export const eventsRoute = new Hono();

eventsRoute.get('/', async (c) => {
  // Cap omhoog van 50/200 naar 200/5000: Agenda toont alle toekomstige
  // events (~2k op dit moment), niet alleen de eerstvolgende 50. Voor
  // Vandaag/Kaart die met `from + to` een dag-window opvragen blijven
  // de queries klein. Server-payload bij ~2k events is rond ~500KB JSON.
  const limit = Math.min(Number(c.req.query('limit') ?? 200), 5000);

  const featured = c.req.query('featured');
  const from = c.req.query('from');
  const to = c.req.query('to');
  const category = c.req.query('category');
  const venueType = c.req.query('venueType');
  const q = c.req.query('q');
  // ?genre= kan herhaald worden voor multi-select OR-filter.
  const genres = c.req.queries('genre') ?? [];
  // `lean=1` → strip de zware velden die voor rail/list-rendering niet
  // nodig zijn (description, address, scene/subtype/priceNote/imageUrl
  // op venue, friendsSaved per occurrence, series-array). Voor Vandaag,
  // Films, Clubs, Live, Kaart een ~60% payload-reductie t.o.v. de fat
  // variant. Detail-pagina's gebruiken een aparte `/events/:id` route.
  const lean = c.req.query('lean') === '1';

  // Bepaal eerst welke events relevant zijn op basis van event-properties
  // (published, venue published, category, genre, search, blocked venues).
  // Daarna filteren we op occurrences in de date-range.
  const eventConditions: SQL[] = [
    eq(schema.events.published, true),
    eq(schema.venues.published, true),
  ];

  if (featured === 'true') {
    eventConditions.push(eq(schema.events.featured, true));
  }
  if (category && VALID_CATEGORIES.has(category)) {
    eventConditions.push(
      eq(
        schema.events.category,
        category as 'Muziek' | 'Theater' | 'Literatuur' | 'Film' | 'Kunst' | 'Lezing'
      )
    );
  }
  if (venueType && VALID_VENUE_TYPES.has(venueType)) {
    eventConditions.push(sql`${schema.venues.type} = ${venueType}`);
  }
  if (q && q.trim().length > 0) {
    const needle = `%${q.trim()}%`;
    const matchTitle = ilike(schema.events.title, needle);
    const matchVenue = ilike(schema.venues.name, needle);
    const matchDesc = ilike(schema.events.description, needle);
    const combined = or(matchTitle, matchVenue, matchDesc);
    if (combined) eventConditions.push(combined);
  }
  if (genres.length > 0) {
    eventConditions.push(
      sql`${schema.events.genres} && ARRAY[${sql.join(
        genres.map((g) => sql`${g}`),
        sql`, `
      )}]::text[]`
    );
  }

  const me = await maybeUserId(c);
  if (me) {
    const blocked = await getBlockedVenueIds(me);
    if (blocked.length > 0) {
      eventConditions.push(not(inArray(schema.events.venueId, blocked)));
    }
  }

  // In lean-mode laten we de zware venue-kolommen (address/scene/subtype/
  // imageUrl/priceNote) en event.description weg uit de SELECT. Scheelt
  // database-bytes én JSON-bytes; geen consumer van /events?lean=1 leest
  // die velden (zie audit).
  const eligibleEvents = lean
    ? await db
        .select({
          id: schema.events.id,
          title: schema.events.title,
          kind: schema.events.kind,
          imageUrl: schema.events.imageUrl,
          posterUrl: schema.events.posterUrl,
          stillUrl: schema.events.stillUrl,
          category: schema.events.category,
          featured: schema.events.featured,
          genres: schema.events.genres,
          venue: {
            id: schema.venues.id,
            slug: schema.venues.slug,
            name: schema.venues.name,
            lat: schema.venues.lat,
            lng: schema.venues.lng,
            type: schema.venues.type,
            // imageUrl behouden in lean voor de fallback wanneer een
            // event zelf geen image heeft (theater/live banner valt
            // dan terug op venue-image). Voegt 1 string per event toe.
            imageUrl: schema.venues.imageUrl,
            // wijk gebruikt door clubs/live/theater venue-header
            // ("Club · Noord"). 1 short string per event.
            wijk: schema.venues.wijk,
          },
        })
        .from(schema.events)
        .innerJoin(schema.venues, eq(schema.events.venueId, schema.venues.id))
        .where(and(...eventConditions))
    : await db
        .select({
          id: schema.events.id,
          title: schema.events.title,
          description: schema.events.description,
          kind: schema.events.kind,
          imageUrl: schema.events.imageUrl,
          posterUrl: schema.events.posterUrl,
          stillUrl: schema.events.stillUrl,
          trailerUrl: schema.events.trailerUrl,
          category: schema.events.category,
          featured: schema.events.featured,
          genres: schema.events.genres,
          venue: {
            id: schema.venues.id,
            slug: schema.venues.slug,
            name: schema.venues.name,
            address: schema.venues.address,
            lat: schema.venues.lat,
            lng: schema.venues.lng,
            type: schema.venues.type,
            wijk: schema.venues.wijk,
            scene: schema.venues.scene,
            subtype: schema.venues.subtype,
            imageUrl: schema.venues.imageUrl,
            priceNote: schema.venues.priceNote,
          },
        })
        .from(schema.events)
        .innerJoin(schema.venues, eq(schema.events.venueId, schema.venues.id))
        .where(and(...eventConditions));

  if (eligibleEvents.length === 0) return c.json({ events: [] });

  const fromDate = from ? new Date(from) : new Date();
  const toDate = to ? new Date(to) : undefined;
  const occRange = await findEventsWithOccurrencesInRange({
    from: !isNaN(fromDate.getTime()) ? fromDate : new Date(),
    to: toDate && !isNaN(toDate.getTime()) ? toDate : undefined,
    eventIds: eligibleEvents.map((e) => e.id),
  });

  // Sorteer events op next-occurrence startsAt (asc) — events zonder
  // toekomstige occurrence vallen weg.
  const eventById = new Map(eligibleEvents.map((e) => [e.id, e]));
  const ordered = occRange.eventIds
    .slice(0, limit)
    .map((id) => ({ event: eventById.get(id)!, occ: occRange.byEvent.get(id)! }))
    .filter((x) => x.event);

  const eventIds = ordered.map((x) => x.event.id);
  // Lean: friends-lookup alleen voor de nextOccurrence van elk event
  // (= de pill op de rail-card). De per-occurrence friends-array op
  // `occurrencesInRange` is in lean leeg — geen consumer rendert die.
  // Voor de fat-variant haalt 'ie nog steeds álle occurrence-ids.
  const occurrenceIdsForFriends = lean
    ? ordered.map(({ occ }) => occ.next?.id).filter((v): v is string => Boolean(v))
    : ordered.flatMap(({ occ }) => occ.all.map((o) => o.id));
  const friendsByOcc = me
    ? await buildFriendsByOccurrence(me, occurrenceIdsForFriends)
    : new Map();
  // Per nextOccurrence: aantal non-revoked invites die ik zelf verstuurd
  // heb. Mobile toont 'n klein badge op de invite-icoon zodat je in de
  // lijst direct ziet of je al iemand uitgenodigd hebt. Goedkope count-
  // query, dezelfde id-set als friends-lookup.
  const myInvitesByOcc = new Map<string, number>();
  if (me && occurrenceIdsForFriends.length > 0) {
    const invRows = await db
      .select({
        occurrenceId: schema.invitations.occurrenceId,
        count: count(),
      })
      .from(schema.invitations)
      .where(
        and(
          eq(schema.invitations.fromUserId, me),
          isNull(schema.invitations.revokedAt),
          inArray(schema.invitations.occurrenceId, occurrenceIdsForFriends)
        )
      )
      .groupBy(schema.invitations.occurrenceId);
    for (const r of invRows) myInvitesByOcc.set(r.occurrenceId, Number(r.count));
  }
  // Series-array idem: in lean wordt 'ie niet op rail-cards getoond.
  const seriesMap = lean
    ? new Map()
    : await buildSeriesByEvent(eventIds);
  const followedVenueIds = me
    ? new Set(await getFollowedVenueIds(me))
    : new Set<string>();

  const events = ordered.map(({ event, occ }) => {
    // Per occurrence: friendsSaved van vrienden die díe specifieke
    // voorstelling/avond gesaved hebben. In lean-mode hebben we alleen
    // de nextOccurrence-friends in de map; we hangen die ook aan de
    // bijbehorende occurrence-rij zodat clubs/live (die per occurrence
    // een card renderen) de friends-pill op die kaart kunnen tonen.
    const isExhibition = event.kind === 'exhibition';
    const occurrencesInRange = occ.all.map((o) => {
      const f = friendsByOcc.get(o.id);
      return {
        ...o,
        startsAt: isExhibition
          ? normalizeExhibitionTime(o.startsAt as unknown as string, 'start')!
          : o.startsAt,
        endsAt: isExhibition
          ? normalizeExhibitionTime(o.endsAt as unknown as string | null, 'end')
          : o.endsAt,
        friendsSaved: f?.friends ?? [],
        friendsSavedCount: f?.count ?? 0,
      };
    });
    // Event-level friendsSaved = friends van de nextOccurrence (default
    // weergave wanneer er nog geen specifieke occurrence is geselecteerd).
    const headFriends = occ.next ? friendsByOcc.get(occ.next.id) : undefined;
    const nextStarts = occ.next?.startsAt ?? null;
    const nextEnds = occ.next?.endsAt ?? null;
    return {
      ...event,
      // gedenormaliseerd vanuit nextOccurrence
      startsAt: isExhibition
        ? normalizeExhibitionTime(nextStarts as unknown as string | null, 'start')
        : nextStarts,
      endsAt: isExhibition
        ? normalizeExhibitionTime(nextEnds as unknown as string | null, 'end')
        : nextEnds,
      priceCents: occ.next?.priceCents ?? null,
      priceNote: occ.next?.priceNote ?? null,
      ticketUrl: occ.next?.ticketUrl ?? null,
      occurrenceCount: occ.count,
      nextOccurrenceVenue: occ.next?.venue ?? null,
      // Volledige lijst occurrences in de gevraagde range — Films en
      // Kaart gebruiken dit om per moment één rij te tonen of multi-
      // venue-films op de kaart te pinnen. Een 3-daags festival
      // verschijnt zo op alle 3 dagen.
      occurrencesInRange,
      friendsSaved: headFriends?.friends ?? [],
      friendsSavedCount: headFriends?.count ?? 0,
      venueFollowed: followedVenueIds.has(event.venue.id),
      series: seriesMap.get(event.id) ?? [],
      // Aantal non-revoked invites die de gebruiker zelf verstuurd
      // heeft voor de eerstvolgende occurrence van dit event. Mobile
      // toont 'n badge naast de invite-icoon zodat je in de lijst
      // direct ziet of je al iemand uitgenodigd hebt.
      myInvitesCount: occ.next ? (myInvitesByOcc.get(occ.next.id) ?? 0) : 0,
    };
  });

  return c.json({ events });
});

// ────────────────────────────────────────────────────────────────────
// Agenda — lichte, op een dag-window of één-dag gerichte endpoints.
//
// Achtergrond: het oude `/events` haalt voor de Agenda álle toekomstige
// events op (cap 5000) met een dikke row-shape (volledig venue-object,
// occurrencesInRange, friendsByOccurrence per ALLE occurrences, series,
// etc.) en duwt dat in één SectionList. Dat schaalt slecht en levert
// minutenlange scrollToLocation-animaties op bij tap op een verre dag.
//
// Strategie: twee lichte endpoints die exact passen op de Agenda-UI:
//   • /events/agenda/days  — telling per logische dag (06:00-cutoff)
//                            voor de day-strip. Geen row-data.
//   • /events/agenda?date= — lean rows voor één logische dag.
//                            Sorteervolgorde startsAt ASC. Friends-pill
//                            + series + venueFollowed mee-genriched.
// Filters (category/venueType/q/onlyFollowed/onlyFriends) gelden voor
// beide endpoints zodat de strip-tellingen kloppen met wat je per dag
// rendert. Tijd-blokken blijven client-side — de per-dag set is klein.
// ────────────────────────────────────────────────────────────────────

type AgendaFilters = {
  categories: EventCategory[];
  venueTypes: string[];
  blocks: string[];
  q: string | null;
  onlyFollowed: boolean;
  onlyFriends: boolean;
};

function parseAgendaFilters(c: Context): AgendaFilters {
  const cats = (c.req.queries('category') ?? []).filter((v): v is EventCategory =>
    VALID_CATEGORIES.has(v)
  );
  const vts = (c.req.queries('venueType') ?? []).filter((v) =>
    VALID_VENUE_TYPES.has(v)
  );
  const blocks = (c.req.queries('block') ?? []).filter((v) =>
    VALID_TIME_BLOCKS.has(v)
  );
  const q = c.req.query('q')?.trim();
  return {
    categories: cats,
    venueTypes: vts,
    blocks,
    q: q && q.length > 0 ? q : null,
    onlyFollowed: c.req.query('onlyFollowed') === 'true',
    onlyFriends: c.req.query('onlyFriends') === 'true',
  };
}

async function getFriendIdsFor(meId: string): Promise<string[]> {
  const rows = await db
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
  return rows.map((r) =>
    r.fromUserId === meId ? r.toUserId : r.fromUserId
  );
}

/**
 * Bouwt de gedeelde WHERE-condities voor /agenda en /agenda/days. Het
 * window (`from`/`to`) wordt door de caller meegegeven omdat de twee
 * endpoints 'm verschillend bepalen (open range vs. single-day cutoff).
 *
 * Gefilterd uit:
 *   - unpublished events / venues
 *   - kind='exhibition' (museums tonen via Vandaag-rails, niet per dag)
 *   - cancelled occurrences
 *   - long-running occurrences (>7d) — meestal audio tours / installaties
 *   - geblokkeerde venues van de huidige gebruiker
 *
 * Plus de actieve filter-chips (cat/venueType/q/onlyFollowed/onlyFriends).
 */
function buildAgendaWhere(opts: {
  filters: AgendaFilters;
  blockedVenueIds: string[];
  followedVenueIds: string[];
  friendIds: string[];
  windowStart: SQL | Date;
  windowEnd: SQL | Date;
}): SQL[] {
  const conditions: SQL[] = [
    eq(schema.events.published, true),
    eq(schema.venues.published, true),
    sql`${schema.events.kind} <> 'exhibition'`,
    sql`${schema.occurrences.status} <> 'cancelled'`,
    // Long-running: alleen filteren als endsAt gezet is. Null endsAt =
    // default 4u, dus per definitie niet long-running.
    sql`(${schema.occurrences.endsAt} IS NULL OR ${schema.occurrences.endsAt} - ${schema.occurrences.startsAt} <= INTERVAL '7 days')`,
    // Effectieve eindtijd ≥ windowStart (event nog niet voorbij)
    sql`COALESCE(${schema.occurrences.endsAt}, ${schema.occurrences.startsAt} + INTERVAL '4 hours') >= ${opts.windowStart}`,
    // Start < windowEnd (event nog binnen window)
    sql`${schema.occurrences.startsAt} < ${opts.windowEnd}`,
  ];
  if (opts.filters.categories.length > 0) {
    conditions.push(inArray(schema.events.category, opts.filters.categories));
  }
  if (opts.filters.venueTypes.length > 0) {
    conditions.push(
      sql`${schema.venues.type} IN (${sql.join(
        opts.filters.venueTypes.map((v) => sql`${v}`),
        sql`, `
      )})`
    );
  }
  if (opts.filters.blocks.length > 0) {
    // Per blok: set NL-local uren. Union over alle gekozen blokken.
    // EXTRACT(HOUR FROM ts AT TIME ZONE 'Europe/Amsterdam') geeft het
    // NL-uur 0-23 ongeacht DST. nacht omspant middernacht — staat al
    // in BLOCK_HOURS uitgevouwen.
    const hours = new Set<number>();
    for (const b of opts.filters.blocks) {
      for (const h of BLOCK_HOURS[b] ?? []) hours.add(h);
    }
    if (hours.size > 0) {
      conditions.push(
        sql`EXTRACT(HOUR FROM ${schema.occurrences.startsAt} AT TIME ZONE 'Europe/Amsterdam') IN (${sql.join(
          [...hours].map((h) => sql`${h}`),
          sql`, `
        )})`
      );
    }
  }
  if (opts.filters.q) {
    const needle = `%${opts.filters.q}%`;
    const combined = or(
      ilike(schema.events.title, needle),
      ilike(schema.venues.name, needle),
      ilike(schema.events.description, needle),
      sql`EXISTS(SELECT 1 FROM unnest(${schema.events.genres}) g WHERE g ILIKE ${needle})`
    );
    if (combined) conditions.push(combined);
  }
  if (opts.blockedVenueIds.length > 0) {
    conditions.push(not(inArray(schema.venues.id, opts.blockedVenueIds)));
  }
  if (opts.filters.onlyFollowed) {
    // Caller short-circuit'te al als followedVenueIds leeg is.
    conditions.push(inArray(schema.venues.id, opts.followedVenueIds));
  }
  if (opts.filters.onlyFriends && opts.friendIds.length > 0) {
    // EXISTS-subquery i.p.v. pre-fetch+IN: één SQL-round-trip,
    // en de planner kan 'm goed indexen via saves(occurrence_id, user_id).
    // We honoreren 'friends' en 'favorites' visibility; voor
    // 'favorites' wordt de visibility client-side gegated in de
    // friends-pill — voor de filter is "minstens één vriend" genoeg.
    conditions.push(
      sql`EXISTS (
        SELECT 1 FROM ${schema.saves} s
        INNER JOIN ${schema.users} u ON u.id = s.user_id
        WHERE s.occurrence_id = ${schema.occurrences.id}
          AND s.user_id IN (${sql.join(
            opts.friendIds.map((id) => sql`${id}`),
            sql`, `
          )})
          AND u.saves_visibility IN ('friends', 'favorites')
      )`
    );
  }
  return conditions;
}

/** Logische dag (06:00 NL-local cutoff) als YYYY-MM-DD string in SQL. */
const LOGICAL_DAY_SQL = sql`to_char((${schema.occurrences.startsAt} - INTERVAL '6 hours') AT TIME ZONE 'Europe/Amsterdam', 'YYYY-MM-DD')`;

/**
 * Day-summary: per logische dag het aantal events na filters. Geen
 * row-data, alleen `{date, count}` zodat de day-strip in mobile direct
 * gerenderd kan worden. Default-window = nu → +90 dagen.
 */
eventsRoute.get('/agenda/days', async (c) => {
  const filters = parseAgendaFilters(c);
  const fromParam = c.req.query('from');
  const toParam = c.req.query('to');
  const from = fromParam ? new Date(fromParam) : new Date();
  const to = toParam
    ? new Date(toParam)
    : new Date(from.getTime() + 90 * 86400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return c.json({ error: 'ongeldige from/to' }, 400);
  }

  const me = await maybeUserId(c);
  const blockedVenueIds = me ? await getBlockedVenueIds(me) : [];
  const followedVenueIds =
    me && filters.onlyFollowed ? await getFollowedVenueIds(me) : [];
  const friendIds =
    me && filters.onlyFriends ? await getFriendIdsFor(me) : [];

  if (filters.onlyFollowed && followedVenueIds.length === 0) {
    return c.json({ days: [] });
  }
  if (filters.onlyFriends && friendIds.length === 0) {
    return c.json({ days: [] });
  }

  const conditions = buildAgendaWhere({
    filters,
    blockedVenueIds,
    followedVenueIds,
    friendIds,
    windowStart: from,
    windowEnd: to,
  });

  const rows = await db
    .select({
      date: LOGICAL_DAY_SQL.as('logical_day'),
      count: count(),
    })
    .from(schema.occurrences)
    .innerJoin(schema.events, eq(schema.events.id, schema.occurrences.eventId))
    .innerJoin(schema.venues, eq(schema.venues.id, schema.events.venueId))
    .where(and(...conditions))
    .groupBy(sql`logical_day`)
    .orderBy(sql`logical_day ASC`);

  return c.json({
    days: rows.map((r) => ({
      date: r.date,
      count: Number(r.count),
    })),
  });
});

/**
 * Rows voor één logische dag. `date` = YYYY-MM-DD (NL-local). Het
 * window draait 06:00 → next-day 06:00 zodat een 02:00-club-event bij
 * de avond ervoor hoort (zelfde regel als mobile's
 * groupOccurrenceRowsByDay). Sortering: startsAt ASC.
 *
 * Lean row-shape — geen volledig venue-object, geen occurrencesInRange,
 * geen series-array (alleen de eerste naam). Friends-pill: top 3 +
 * totaal. Venue: occurrence-venue als die afwijkt, anders event-venue.
 */
eventsRoute.get('/agenda', async (c) => {
  const filters = parseAgendaFilters(c);
  const dateParam = c.req.query('date');
  if (!dateParam || !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    return c.json({ error: 'date param vereist (YYYY-MM-DD)' }, 400);
  }
  // Optionele cutoff voor "verlopen events op vandaag": mobile stuurt
  // de huidige tijd mee zodat een 14:00-show om 16:30 niet meer in de
  // lijst staat. Voor toekomstige dagen heeft 't geen effect (alle
  // events in dat window vallen ná `from`). Foutieve waarde =>
  // negeren (val terug op windowStart als enige effective-end filter).
  const fromParam = c.req.query('from');
  const fromDate = fromParam ? new Date(fromParam) : null;
  const effectiveFrom =
    fromDate && !Number.isNaN(fromDate.getTime()) ? fromDate : null;

  // Window = dateParam 06:00 NL-local → next-day 06:00 NL-local.
  // AT TIME ZONE op een naïeve timestamp interpreteert hem ALS lokale
  // tijd en geeft 'm terug als timestamptz (UTC) voor vergelijking.
  const windowStart = sql`(${dateParam}::text || ' 06:00:00')::timestamp AT TIME ZONE 'Europe/Amsterdam'`;
  const windowEnd = sql`((${dateParam}::date + 1)::text || ' 06:00:00')::timestamp AT TIME ZONE 'Europe/Amsterdam'`;
  // Effectieve windowStart voor het "nog niet voorbij"-filter: max van
  // windowStart en de meegegeven cut-off. Voor toekomstige dagen pakt
  // GREATEST sowieso windowStart; voor vandaag pakt 'ie focusedNow.
  const effectiveWindowStart = effectiveFrom
    ? sql`GREATEST(${windowStart}, ${effectiveFrom})`
    : windowStart;

  const me = await maybeUserId(c);
  const blockedVenueIds = me ? await getBlockedVenueIds(me) : [];
  const followedVenueIds = me ? await getFollowedVenueIds(me) : [];
  const followedSet = new Set(followedVenueIds);
  const friendIds = me && filters.onlyFriends ? await getFriendIdsFor(me) : [];

  if (filters.onlyFollowed && followedVenueIds.length === 0) {
    return c.json({ rows: [] });
  }
  if (filters.onlyFriends && friendIds.length === 0) {
    return c.json({ rows: [] });
  }

  const conditions = buildAgendaWhere({
    filters,
    blockedVenueIds,
    followedVenueIds,
    friendIds,
    windowStart: effectiveWindowStart,
    windowEnd,
  });

  const rows = await db
    .select({
      occId: schema.occurrences.id,
      occVenueId: schema.occurrences.venueId,
      startsAt: schema.occurrences.startsAt,
      endsAt: schema.occurrences.endsAt,
      eventId: schema.events.id,
      title: schema.events.title,
      category: schema.events.category,
      kind: schema.events.kind,
      imageUrl: schema.events.imageUrl,
      posterUrl: schema.events.posterUrl,
      genres: schema.events.genres,
      eventVenueId: schema.venues.id,
      eventVenueName: schema.venues.name,
      eventVenueType: schema.venues.type,
      eventVenueImageUrl: schema.venues.imageUrl,
    })
    .from(schema.occurrences)
    .innerJoin(schema.events, eq(schema.events.id, schema.occurrences.eventId))
    .innerJoin(schema.venues, eq(schema.venues.id, schema.events.venueId))
    .where(and(...conditions))
    .orderBy(asc(schema.occurrences.startsAt));

  if (rows.length === 0) return c.json({ rows: [] });

  // Occurrence-venue overrides: voor films die in meerdere bioscopen
  // draaien wijkt occ.venueId af van event.venueId. Apart fetchen,
  // niet via JOIN — drizzle's aliasedTable speelt slecht samen met de
  // TS-inferentie en de N is sowieso klein (max ~50 rows per dag).
  // Eén pass i.p.v. O(n²): collect alle occ-venue-ids die niet matchen
  // met de event-venue-id van dezelfde row.
  const overrideVenueIds = [
    ...new Set(
      rows
        .filter((r) => r.occVenueId && r.occVenueId !== r.eventVenueId)
        .map((r) => r.occVenueId as string)
    ),
  ];
  const occVenueMap = new Map<
    string,
    { name: string; type: string | null; imageUrl: string | null }
  >();
  if (overrideVenueIds.length > 0) {
    const vrows = await db
      .select({
        id: schema.venues.id,
        name: schema.venues.name,
        type: schema.venues.type,
        imageUrl: schema.venues.imageUrl,
      })
      .from(schema.venues)
      .where(inArray(schema.venues.id, overrideVenueIds));
    for (const v of vrows)
      occVenueMap.set(v.id, { name: v.name, type: v.type, imageUrl: v.imageUrl });
  }

  const occIds = rows.map((r) => r.occId);
  const eventIds = [...new Set(rows.map((r) => r.eventId))];
  const friendsByOcc = me
    ? await buildFriendsByOccurrence(me, occIds)
    : new Map();
  const seriesByEvent = await buildSeriesByEvent(eventIds);

  const out = rows.map((r) => {
    const f = friendsByOcc.get(r.occId);
    const series = seriesByEvent.get(r.eventId);
    const override =
      r.occVenueId && r.occVenueId !== r.eventVenueId
        ? occVenueMap.get(r.occVenueId)
        : undefined;
    const venueId = r.occVenueId ?? r.eventVenueId;
    return {
      id: r.occId,
      occurrenceId: r.occId,
      eventId: r.eventId,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      title: r.title,
      category: r.category,
      kind: r.kind,
      imageUrl: r.imageUrl,
      posterUrl: r.posterUrl,
      genre: r.genres?.[0] ?? null,
      seriesName: series?.[0]?.name ?? null,
      venueId,
      venueName: override?.name ?? r.eventVenueName,
      venueType: override?.type ?? r.eventVenueType ?? null,
      // Venue-image als fallback voor de thumb wanneer event.imageUrl
      // ontbreekt — voorkomt de lege-thumb-shift in de agenda-lijst.
      venueImageUrl: override?.imageUrl ?? r.eventVenueImageUrl ?? null,
      friendsSaved: (f?.friends ?? []).map(
        (fr: { name: string; avatarUrl: string | null }) => ({
          name: fr.name,
          avatarUrl: fr.avatarUrl,
        })
      ),
      friendsSavedCount: f?.count ?? 0,
      venueFollowed: followedSet.has(venueId),
    };
  });

  return c.json({ rows: out });
});

/**
 * "Voor jou" — gepersonaliseerde aanbevelingen op basis van je save-
 * historie en gevolgde venues. Geen ML, gewoon een transparante linear-
 * weighted score:
 *
 *   +1 per save in je historie met overlappend genre
 *   +2 per save in je historie bij hetzelfde venue
 *   +5 bonus als het venue gevolgd is
 *
 * Excludes: events die je al gesaved hebt, occurrences die je weggeswipet
 * hebt, geblokkeerde venues. Range: nu → +21 dagen. Cap: 30 events.
 *
 * Empty als de gebruiker nog geen saves heeft — UI verbergt de rail.
 */
eventsRoute.get('/for-you', async (c) => {
  const me = await maybeUserId(c);
  if (!me) return c.json({ events: [] });

  // Stap 1 — bouw genre-count + venue-count uit gebruikers-historie.
  const historyRows = await db
    .select({
      genres: schema.events.genres,
      venueId: schema.events.venueId,
    })
    .from(schema.saves)
    .innerJoin(
      schema.occurrences,
      eq(schema.saves.occurrenceId, schema.occurrences.id)
    )
    .innerJoin(schema.events, eq(schema.occurrences.eventId, schema.events.id))
    .where(eq(schema.saves.userId, me));

  if (historyRows.length === 0) return c.json({ events: [] });

  const genreCount = new Map<string, number>();
  const venueCount = new Map<string, number>();
  const savedEventIds = new Set<string>();
  for (const r of historyRows) {
    for (const g of r.genres ?? []) {
      const key = g.trim().toLowerCase();
      if (key) genreCount.set(key, (genreCount.get(key) ?? 0) + 1);
    }
    venueCount.set(r.venueId, (venueCount.get(r.venueId) ?? 0) + 1);
  }

  // Welke events heb ik al gesaved? Niet opnieuw aanbevelen.
  const savedEventRows = await db
    .selectDistinct({ eventId: schema.occurrences.eventId })
    .from(schema.saves)
    .innerJoin(
      schema.occurrences,
      eq(schema.saves.occurrenceId, schema.occurrences.id)
    )
    .where(eq(schema.saves.userId, me));
  for (const r of savedEventRows) savedEventIds.add(r.eventId);

  // Welke occurrences heb ik weggeswipet?
  const dismissRows = await db
    .select({ occurrenceId: schema.dismisses.occurrenceId })
    .from(schema.dismisses)
    .where(eq(schema.dismisses.userId, me));
  const dismissedOccIds = new Set(dismissRows.map((r) => r.occurrenceId));

  const [followedRaw, blockedRaw] = await Promise.all([
    getFollowedVenueIds(me),
    getBlockedVenueIds(me),
  ]);
  const followedVenueIds = new Set(followedRaw);
  const blockedSet = new Set(blockedRaw);

  // Stap 2 — kandidaat-events: published, niet-geblokte venue, niet al
  // gesaved. We pakken hier breed (geen featured-filter, alle categorieën)
  // omdat de score zelf het sorteert.
  const eventConditions: SQL[] = [
    eq(schema.events.published, true),
    eq(schema.venues.published, true),
  ];
  if (savedEventIds.size > 0) {
    eventConditions.push(not(inArray(schema.events.id, [...savedEventIds])));
  }
  if (blockedSet.size > 0) {
    eventConditions.push(not(inArray(schema.events.venueId, [...blockedSet])));
  }

  const candidates = await db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      description: schema.events.description,
      kind: schema.events.kind,
      imageUrl: schema.events.imageUrl,
      posterUrl: schema.events.posterUrl,
      stillUrl: schema.events.stillUrl,
      trailerUrl: schema.events.trailerUrl,
      category: schema.events.category,
      featured: schema.events.featured,
      genres: schema.events.genres,
      venue: {
        id: schema.venues.id,
        slug: schema.venues.slug,
        name: schema.venues.name,
        address: schema.venues.address,
        lat: schema.venues.lat,
        lng: schema.venues.lng,
        type: schema.venues.type,
        scene: schema.venues.scene,
        subtype: schema.venues.subtype,
        imageUrl: schema.venues.imageUrl,
        priceNote: schema.venues.priceNote,
      },
    })
    .from(schema.events)
    .innerJoin(schema.venues, eq(schema.events.venueId, schema.venues.id))
    .where(and(...eventConditions));

  // Stap 3 — score elke kandidaat. Filter score=0 weg.
  type Scored = (typeof candidates)[number] & { score: number };
  const scored: Scored[] = [];
  for (const ev of candidates) {
    let score = 0;
    for (const g of ev.genres ?? []) {
      const key = g.trim().toLowerCase();
      if (key) score += genreCount.get(key) ?? 0;
    }
    score += 2 * (venueCount.get(ev.venue.id) ?? 0);
    if (followedVenueIds.has(ev.venue.id)) score += 5;
    if (score > 0) scored.push({ ...ev, score });
  }

  if (scored.length === 0) return c.json({ events: [] });

  // Stap 4 — match tegen toekomstige occurrences (next 21 dagen). Events
  // zonder occurrence-in-range vallen weg. Dismisses filteren we per
  // occurrence — als alle next-occurrences gedismisst zijn, valt 't event
  // weg.
  const horizonEnd = new Date();
  horizonEnd.setDate(horizonEnd.getDate() + 21);
  const occRange = await findEventsWithOccurrencesInRange({
    from: new Date(),
    to: horizonEnd,
    eventIds: scored.map((s) => s.id),
  });

  // Sorteer op score (desc), met als secundaire sleutel de eerstvolgende
  // occurrence (asc) zodat events met gelijke score vandaag-eerst.
  const eventScores = new Map(scored.map((s) => [s.id, s.score]));
  const ranked: string[] = [...occRange.eventIds]
    .filter((id) => {
      const occ = occRange.byEvent.get(id);
      if (!occ) return false;
      // Tenminste één niet-gedismist occurrence in range.
      return occ.all.some((o) => !dismissedOccIds.has(o.id));
    })
    .sort((a, b) => {
      const dScore = (eventScores.get(b) ?? 0) - (eventScores.get(a) ?? 0);
      if (dScore !== 0) return dScore;
      const aT = occRange.byEvent.get(a)?.next?.startsAt.getTime() ?? Infinity;
      const bT = occRange.byEvent.get(b)?.next?.startsAt.getTime() ?? Infinity;
      return aT - bT;
    })
    .slice(0, 30);

  const eventById = new Map(scored.map((s) => [s.id, s]));
  const ordered = ranked
    .map((id) => ({
      event: eventById.get(id)!,
      occ: occRange.byEvent.get(id)!,
    }))
    .filter((x) => x.event);

  // Standaard friend-pills + series + denormalisatie, gelijk aan GET /events.
  const eventIds = ordered.map((x) => x.event.id);
  const allOccurrenceIds = ordered.flatMap(({ occ }) =>
    occ.all
      .filter((o) => !dismissedOccIds.has(o.id))
      .map((o) => o.id)
  );
  const friendsByOcc = await buildFriendsByOccurrence(me, allOccurrenceIds);
  const seriesMap = await buildSeriesByEvent(eventIds);

  const events = ordered.map(({ event, occ }) => {
    const isExhibition = event.kind === 'exhibition';
    const occurrencesInRange = occ.all
      .filter((o) => !dismissedOccIds.has(o.id))
      .map((o) => {
        const f = friendsByOcc.get(o.id);
        return {
          ...o,
          startsAt: isExhibition
            ? normalizeExhibitionTime(o.startsAt as unknown as string, 'start')!
            : o.startsAt,
          endsAt: isExhibition
            ? normalizeExhibitionTime(o.endsAt as unknown as string | null, 'end')
            : o.endsAt,
          friendsSaved: f?.friends ?? [],
          friendsSavedCount: f?.count ?? 0,
        };
      });
    const headOcc = occurrencesInRange[0] ?? null;
    const headFriends = headOcc ? friendsByOcc.get(headOcc.id) : undefined;
    return {
      ...event,
      startsAt: headOcc?.startsAt ?? null,
      endsAt: headOcc?.endsAt ?? null,
      priceCents: headOcc?.priceCents ?? null,
      priceNote: headOcc?.priceNote ?? null,
      ticketUrl: headOcc?.ticketUrl ?? null,
      occurrenceCount: occurrencesInRange.length,
      nextOccurrenceVenue: headOcc?.venue ?? null,
      occurrencesInRange,
      friendsSaved: headFriends?.friends ?? [],
      friendsSavedCount: headFriends?.count ?? 0,
      venueFollowed: followedVenueIds.has(event.venue.id),
      series: seriesMap.get(event.id) ?? [],
    };
  });

  return c.json({ events });
});

/**
 * Distinct genre-lijst voor de filter-sheet in de Agenda. Groepeert
 * per category zodat de mobile UI muziek-genres scheidt van theater
 * en kunst. Alleen toekomstige, gepubliceerde events meegerekend.
 */
eventsRoute.get('/genres', async (c) => {
  // Genres-buckets: alleen events met minstens één toekomstige (of nog
  // lopende, voor exhibitions) occurrence tellen mee.
  const rows = await db
    .select({
      genre: sql<string>`unnest(${schema.events.genres})`.as('genre'),
      category: schema.events.category,
      n: count(),
    })
    .from(schema.events)
    .innerJoin(schema.venues, eq(schema.events.venueId, schema.venues.id))
    .innerJoin(
      schema.occurrences,
      eq(schema.occurrences.eventId, schema.events.id)
    )
    .where(
      and(
        eq(schema.events.published, true),
        eq(schema.venues.published, true),
        // Effectieve eindtijd: endsAt of startsAt + 4u default.
        sql`COALESCE(${schema.occurrences.endsAt}, ${schema.occurrences.startsAt} + INTERVAL '4 hours') >= NOW()`,
        sql`${schema.occurrences.status} <> 'cancelled'`
      )
    )
    .groupBy(sql`unnest(${schema.events.genres})`, schema.events.category)
    .orderBy(schema.events.category, desc(count()));

  const genres = rows.map((r) => ({
    genre: r.genre,
    category: r.category,
    count: Number(r.n),
  }));
  return c.json({ genres });
});

/**
 * "Net binnen" — events op createdAt desc. Twee query-modes:
 *
 *  - `?since=ISO`: alleen events met createdAt > since (gebruikt door
 *    de homepage-shortcut badge en als primaire lijst op /new). Cap
 *    op 30 dagen terug om gigantische payloads voor langdurig-
 *    inactieve gebruikers te voorkomen.
 *  - geen `since`: laatste N events (default 10, cap 100). Fallback-
 *    query die /new client-side firet wanneer de since-query leeg is,
 *    zodat de pagina nooit kaal blijft.
 *
 * Filter: published + venue published + ≥1 toekomstige occurrence
 * (events die al voorbij zijn op moment van scrape zijn ruis).
 *
 * Lean shape — dezelfde velden als `/events?lean=1` zodat de mobile
 * client met EventListRow + bestaande types kan renderen.
 */
eventsRoute.get('/new', async (c) => {
  const sinceParam = c.req.query('since');
  let since: Date | null = null;
  if (sinceParam) {
    const parsed = new Date(sinceParam);
    if (Number.isNaN(parsed.getTime()))
      return c.json({ error: 'bad-since' }, 400);
    // Cap aan de oude kant: gebruiker die 3 maanden weg is geweest
    // krijgt geen lijst van honderden weken oude items.
    const minSince = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    since = parsed < minSince ? minSince : parsed;
  }

  // Default limit verschilt per mode: with-since 200 (volledig
  // gewenst), without-since 10 (alleen "wat is er sowieso recent
  // toegevoegd" voor de fallback-rij).
  const defaultLimit = since ? 200 : 10;
  const limit = Math.min(
    Number(c.req.query('limit') ?? defaultLimit),
    since ? 500 : 100
  );

  const me = await maybeUserId(c);
  const blockedVenueIds = me
    ? new Set(await getBlockedVenueIds(me))
    : new Set<string>();

  const eventRows = await db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      kind: schema.events.kind,
      category: schema.events.category,
      featured: schema.events.featured,
      genres: schema.events.genres,
      imageUrl: schema.events.imageUrl,
      posterUrl: schema.events.posterUrl,
      stillUrl: schema.events.stillUrl,
      trailerUrl: schema.events.trailerUrl,
      createdAt: schema.events.createdAt,
      venue: {
        id: schema.venues.id,
        slug: schema.venues.slug,
        name: schema.venues.name,
        lat: schema.venues.lat,
        lng: schema.venues.lng,
        type: schema.venues.type,
        imageUrl: schema.venues.imageUrl,
        wijk: schema.venues.wijk,
      },
    })
    .from(schema.events)
    .innerJoin(schema.venues, eq(schema.events.venueId, schema.venues.id))
    .where(
      and(
        eq(schema.events.published, true),
        eq(schema.venues.published, true),
        since ? gt(schema.events.createdAt, since) : sql`true`,
        blockedVenueIds.size > 0
          ? not(inArray(schema.venues.id, Array.from(blockedVenueIds)))
          : sql`true`
      )
    )
    .orderBy(desc(schema.events.createdAt))
    .limit(limit);

  if (eventRows.length === 0) return c.json({ events: [] });

  // Stap 2: future occurrences voor deze events.
  const occRange = await findEventsWithOccurrencesInRange({
    eventIds: eventRows.map((e) => e.id),
  });

  const followedVenueIds = me
    ? new Set(await getFollowedVenueIds(me))
    : new Set<string>();

  // Stap 3: lean response — strip events zonder upcoming occurrence
  // (events.createdAt > since maar alle occurrences zijn voorbij — bv.
  // een laat-gescraped event van vorige week).
  const events = eventRows
    .filter((e) => occRange.byEvent.has(e.id))
    .map((event) => {
      const occ = occRange.byEvent.get(event.id)!;
      const isExhibition = event.kind === 'exhibition';
      const nextStarts = occ.next?.startsAt ?? null;
      const nextEnds = occ.next?.endsAt ?? null;
      return {
        ...event,
        startsAt: isExhibition
          ? normalizeExhibitionTime(nextStarts as unknown as string | null, 'start')
          : nextStarts,
        endsAt: isExhibition
          ? normalizeExhibitionTime(nextEnds as unknown as string | null, 'end')
          : nextEnds,
        priceCents: occ.next?.priceCents ?? null,
        priceNote: occ.next?.priceNote ?? null,
        ticketUrl: occ.next?.ticketUrl ?? null,
        occurrenceCount: occ.count,
        nextOccurrenceVenue: occ.next?.venue ?? null,
        occurrencesInRange: occ.all.map((o) => ({
          ...o,
          startsAt: isExhibition
            ? normalizeExhibitionTime(o.startsAt as unknown as string, 'start')!
            : o.startsAt,
          endsAt: isExhibition
            ? normalizeExhibitionTime(o.endsAt as unknown as string | null, 'end')
            : o.endsAt,
          friendsSaved: [],
          friendsSavedCount: 0,
        })),
        friendsSaved: [],
        friendsSavedCount: 0,
        venueFollowed: followedVenueIds.has(event.venue.id),
        series: [],
        myInvitesCount: 0,
      };
    });

  return c.json({ events });
});

eventsRoute.get('/:id', async (c) => {
  const id = c.req.param('id');

  const [row] = await db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      description: schema.events.description,
      kind: schema.events.kind,
      imageUrl: schema.events.imageUrl,
      posterUrl: schema.events.posterUrl,
      stillUrl: schema.events.stillUrl,
      trailerUrl: schema.events.trailerUrl,
      category: schema.events.category,
      featured: schema.events.featured,
      genres: schema.events.genres,
      venue: {
        id: schema.venues.id,
        slug: schema.venues.slug,
        name: schema.venues.name,
        address: schema.venues.address,
        lat: schema.venues.lat,
        lng: schema.venues.lng,
        type: schema.venues.type,
        scene: schema.venues.scene,
        subtype: schema.venues.subtype,
        description: schema.venues.description,
        imageUrl: schema.venues.imageUrl,
        priceNote: schema.venues.priceNote,
      },
    })
    .from(schema.events)
    .innerJoin(schema.venues, eq(schema.events.venueId, schema.venues.id))
    .where(
      and(
        eq(schema.events.id, id),
        eq(schema.events.published, true),
        eq(schema.venues.published, true)
      )
    )
    .limit(1);

  if (!row) return c.json({ error: 'event not found' }, 404);

  const me = await maybeUserId(c);
  const seriesMap = await buildSeriesByEvent([row.id]);
  // Detail-page: ook afgelopen events kunnen geopend worden via een
  // share-link of saved-link, dus pak ook past-occurrences als fallback.
  const occMap = await buildOccurrencesByEvent([row.id], { includePast: true });
  const occ = occMap.get(row.id);
  const occurrenceIdsAll = (occ?.all ?? []).map((o) => o.id);
  const friendsByOcc = me
    ? await buildFriendsByOccurrence(me, occurrenceIdsAll)
    : new Map();
  // Event-level friendsSaved = friends van de nextOccurrence (= huidige
  // weergave wanneer geen ?o=… gekozen). Per-occurrence friends staat
  // op de occurrences-lijst zodat de mobile-UI bij ?o=switch de juiste
  // pill toont.
  const headFriends = occ?.next ? friendsByOcc.get(occ.next.id) : undefined;

  // Mijn eigen verstuurde invitations voor dit event — zowel 1-op-1 als
  // groep-invites. Voor 1-op-1: één rij per (invitation, recipient).
  // Voor groep: één rij per (invitation, groepslid) — zo zie ik in de
  // crew-lijst voor elk groepslid de actuele status en kan ik per
  // persoon een reminder sturen. Status komt uit `invitation_responses`
  // van de andere user(s); eigen response (initiator = 'going') wordt
  // weggefilterd via ne(userId, me).
  const myInvites =
    me && occurrenceIdsAll.length > 0
      ? await db
          .select({
            id: schema.invitations.id,
            status: schema.invitationResponses.status,
            message: schema.invitations.message,
            occurrenceId: schema.invitations.occurrenceId,
            occurrenceStartsAt: schema.occurrences.startsAt,
            reminderSentAt: schema.invitationResponses.reminderSentAt,
            groupName: schema.groups.name,
            toUserId: schema.users.id,
            toName: schema.users.name,
            toHandle: schema.users.handle,
            toAvatarUrl: schema.users.avatarUrl,
          })
          .from(schema.invitations)
          .innerJoin(
            schema.invitationResponses,
            and(
              eq(
                schema.invitationResponses.invitationId,
                schema.invitations.id
              ),
              ne(schema.invitationResponses.userId, me)
            )!
          )
          .innerJoin(
            schema.users,
            eq(schema.users.id, schema.invitationResponses.userId)
          )
          .innerJoin(
            schema.occurrences,
            eq(schema.occurrences.id, schema.invitations.occurrenceId)
          )
          .leftJoin(
            schema.groups,
            eq(schema.groups.id, schema.invitations.groupId)
          )
          .where(
            and(
              eq(schema.invitations.fromUserId, me),
              isNull(schema.invitations.revokedAt),
              inArray(schema.invitations.occurrenceId, occurrenceIdsAll)
            )
          )
          .orderBy(asc(schema.invitations.createdAt))
      : [];

  // Inkomende uitnodigingen waarop ik 'going' heb geantwoord — voor de
  // "connection"-markering in het crew-blok. Een going-respons is een
  // expliciete RSVP, naast de spontane save. Pakt zowel 1-op-1 (waar
  // iemand mij persoonlijk uitnodigde) als groep-invites (waar ik via
  // een groep meedoe). Voor crew-context tonen we de initiator als
  // "verbinding"; bij groep-invites is dat degene die de groep heeft
  // uitgenodigd.
  const incomingAcceptedInvites =
    me && occurrenceIdsAll.length > 0
      ? await db
          .select({
            id: schema.invitations.id,
            occurrenceId: schema.invitations.occurrenceId,
            fromUserId: schema.users.id,
            fromName: schema.users.name,
            fromHandle: schema.users.handle,
            fromAvatarUrl: schema.users.avatarUrl,
          })
          .from(schema.invitations)
          .innerJoin(
            schema.invitationResponses,
            and(
              eq(
                schema.invitationResponses.invitationId,
                schema.invitations.id
              ),
              eq(schema.invitationResponses.userId, me),
              eq(schema.invitationResponses.status, 'going')
            )!
          )
          .innerJoin(
            schema.users,
            eq(schema.users.id, schema.invitations.fromUserId)
          )
          .where(
            and(
              isNull(schema.invitations.revokedAt),
              ne(schema.invitations.fromUserId, me),
              inArray(schema.invitations.occurrenceId, occurrenceIdsAll)
            )
          )
      : [];

  // People going via invitations — alle going-responses op invitations
  // waar IK ook in zit (als initiator óf als groepslid). Dit pakt
  // groepsleden die niet noodzakelijk vrienden van mij zijn maar wel
  // 'going' hebben gereageerd op een groep-invite waar ik deel van
  // ben. Inclusief 1-op-1's. Eigen response wordt uitgesloten.
  const peopleGoing: Array<{
    user: { id: string; name: string; handle: string | null; avatarUrl: string | null };
    occurrenceId: string;
    viaGroupName: string | null;
  }> = [];
  if (me && occurrenceIdsAll.length > 0) {
    // Stap 1: invitation-ids waar ik in zit (response-rij heb).
    const myInvolvedIds = await db
      .selectDistinct({ id: schema.invitationResponses.invitationId })
      .from(schema.invitationResponses)
      .innerJoin(
        schema.invitations,
        eq(schema.invitations.id, schema.invitationResponses.invitationId)
      )
      .where(
        and(
          eq(schema.invitationResponses.userId, me),
          isNull(schema.invitations.revokedAt),
          inArray(schema.invitations.occurrenceId, occurrenceIdsAll)
        )
      );

    if (myInvolvedIds.length > 0) {
      const ids = myInvolvedIds.map((r) => r.id);
      const rows = await db
        .select({
          userId: schema.users.id,
          userName: schema.users.name,
          userHandle: schema.users.handle,
          userAvatarUrl: schema.users.avatarUrl,
          occurrenceId: schema.invitations.occurrenceId,
          groupName: schema.groups.name,
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
        .leftJoin(
          schema.groups,
          eq(schema.groups.id, schema.invitations.groupId)
        )
        .where(
          and(
            inArray(schema.invitationResponses.invitationId, ids),
            eq(schema.invitationResponses.status, 'going'),
            ne(schema.invitationResponses.userId, me)
          )
        );
      for (const r of rows) {
        peopleGoing.push({
          user: {
            id: r.userId,
            name: r.userName,
            handle: r.userHandle,
            avatarUrl: r.userAvatarUrl,
          },
          occurrenceId: r.occurrenceId,
          viaGroupName: r.groupName,
        });
      }
    }
  }

  const isExhibition = row.kind === 'exhibition';
  // Per occurrence z'n eigen friendsSaved injecteren zodat de mobile-UI
  // bij een `?o=` switch direct de juiste pill toont zonder extra fetch.
  const occurrencesWithFriends = (occ?.all ?? []).map((o) => {
    const f = friendsByOcc.get(o.id);
    return {
      ...o,
      startsAt: isExhibition
        ? normalizeExhibitionTime(o.startsAt as unknown as string, 'start')!
        : o.startsAt,
      endsAt: isExhibition
        ? normalizeExhibitionTime(o.endsAt as unknown as string | null, 'end')
        : o.endsAt,
      friendsSaved: f?.friends ?? [],
      friendsSavedCount: f?.count ?? 0,
    };
  });

  const nextStarts = occ?.next?.startsAt ?? null;
  const nextEnds = occ?.next?.endsAt ?? null;
  return c.json({
    event: {
      ...row,
      // Gedenormaliseerd vanuit nextOccurrence — voor list-clients die
      // ook detail krijgen via dezelfde shape.
      startsAt: isExhibition
        ? normalizeExhibitionTime(nextStarts as unknown as string | null, 'start')
        : nextStarts,
      endsAt: isExhibition
        ? normalizeExhibitionTime(nextEnds as unknown as string | null, 'end')
        : nextEnds,
      priceCents: occ?.next?.priceCents ?? null,
      priceNote: occ?.next?.priceNote ?? null,
      ticketUrl: occ?.next?.ticketUrl ?? null,
      occurrenceCount: occ?.count ?? 0,
      nextOccurrenceVenue: occ?.next?.venue ?? null,
      occurrences: occurrencesWithFriends,
      friendsSaved: headFriends?.friends ?? [],
      friendsSavedCount: headFriends?.count ?? 0,
      series: seriesMap.get(row.id) ?? [],
      myInvites: myInvites.map((i) => ({
        id: i.id,
        status: i.status,
        message: i.message,
        occurrenceId: i.occurrenceId,
        occurrenceStartsAt: i.occurrenceStartsAt,
        reminderSentAt: i.reminderSentAt,
        viaGroupName: i.groupName,
        to: {
          id: i.toUserId,
          name: i.toName,
          handle: i.toHandle,
          avatarUrl: i.toAvatarUrl,
        },
      })),
      peopleGoing,
      incomingAcceptedInvites: incomingAcceptedInvites.map((i) => ({
        id: i.id,
        occurrenceId: i.occurrenceId,
        from: {
          id: i.fromUserId,
          name: i.fromName,
          handle: i.fromHandle,
          avatarUrl: i.fromAvatarUrl,
        },
      })),
    },
  });
});
