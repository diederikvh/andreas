import { aliasedTable, and, asc, count, desc, eq, gt, gte, ilike, inArray, isNull, ne, not, or, sql, type SQL } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import { db, displayGenres, schema } from '../db/index.js';
import {
  buildFriendsByOccurrence,
  buildOccurrencesByEvent,
  buildSeriesByEvent,
  buildTasteProfile,
  dislikePenalty,
  findEventsWithOccurrencesInRange,
  maybeUserId,
} from './_helpers.js';
import {
  getBlockedVenueIds,
  getFollowedVenueIds,
} from './venue-follows.js';
import { resolveWhenWindow } from '../zoek/retrieval.js';
import type { PreferenceProfile } from '../zoek/types.js';

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
  // Cap op 2000 — gelijk aan wat de drukste category-pagina's (clubs/live/
  // theater) legitiem opvragen. Voorkomt de eerdere 5000-over-fetch als
  // DoS-headroom op een 512MB-machine.
  const limit = Math.min(Number(c.req.query('limit') ?? 200), 2000);

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
    // Filter op de getoonde (verrijkte) set zodat een via-line-up-artiest
    // doorgedruppeld genre ook gevonden wordt — consistent met de labels en
    // meer kans op de juiste treffer. Fallback naar eigen genres voor events
    // die nog niet herberekend zijn (zie displayGenres).
    eventConditions.push(
      sql`${displayGenres} && ARRAY[${sql.join(
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
          genres: displayGenres,
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
          genres: displayGenres,
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
 *   - all-day / doorlopende occurrences (span ≥ 23u) — een agenda gaat
 *     over "wat speelt er wánneer"; een doorlopend all-day-blok (WK-
 *     viewing, weekmarkt, audio tour) hoort daar niet als kaart tussen.
 *     Blijven vindbaar via de venue-pagina en zoek.
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
    // All-day / doorlopend: filter occurrences met een span ≥ 23u
    // (zelfde grens als isAllDayRange in de app — dekt 00:00→23:59,
    // meerdaagse blokken én weken-lange audio tours). Alleen filteren
    // als endsAt gezet is; null endsAt = default 4u, dus getimed.
    sql`(${schema.occurrences.endsAt} IS NULL OR ${schema.occurrences.endsAt} - ${schema.occurrences.startsAt} < INTERVAL '23 hours')`,
    // Effectieve eindtijd ≥ windowStart (event nog niet voorbij)
    sql`COALESCE(${schema.occurrences.endsAt}, ${schema.occurrences.startsAt} + INTERVAL '4 hours') >= ${opts.windowStart}`,
    // Start < windowEnd (event nog binnen window)
    sql`${schema.occurrences.startsAt} < ${opts.windowEnd}`,
  ];
  if (opts.filters.categories.length > 0) {
    conditions.push(inArray(schema.events.category, opts.filters.categories));
  }
  if (opts.filters.venueTypes.length > 0) {
    // Filteren op de venue die de rij ook tóónt, niet op de venue van
    // het event. Die twee lopen uiteen bij films: `events.venueId` is
    // "wie scrapete dit het eerst" en dat is soms Melkweg of Paradiso,
    // terwijl de voorstellingen in bioscopen draaien. Filterde je op
    // Podium, dan kreeg je 67 van die filmrijen mee — en omdat films
    // 's ochtends beginnen stonden ze bovenaan, dus het leek alsof
    // Podium alleen maar bioscopen opleverde.
    conditions.push(
      sql`COALESCE(
            (SELECT ov.type FROM venues ov WHERE ov.id = ${schema.occurrences.venueId}),
            ${schema.venues.type}
          ) IN (${sql.join(
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
      // Zelfde reden als bij het type-filter: zoeken op "Kriterion"
      // moet de film vinden die dáár draait, ook als het event onder
      // een ander huis is binnengekomen.
      sql`COALESCE(
            (SELECT ov.name FROM venues ov WHERE ov.id = ${schema.occurrences.venueId}),
            ${schema.venues.name}
          ) ILIKE ${needle}`,
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
 * Rows voor een reeks logische dagen. `date` = eerste dag (YYYY-MM-DD,
 * NL-local), optioneel `to` = laatste dag. Zonder `to` is het één dag,
 * zoals hiervoor.
 *
 * Het window draait 06:00 → (laatste dag + 1) 06:00 zodat een
 * 02:00-club-event bij de avond ervoor hoort — zelfde regel als
 * mobile's `groupOccurrenceRowsByDay`, die de rijen daarna per dag
 * groepeert. Sortering: startsAt ASC, dus de client hoeft alleen te
 * splitsen, niet te sorteren.
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
  // Eindpunt van de reeks. Ongeldig of vóór `date` => één dag.
  const toRaw = c.req.query('to');
  const toParam =
    toRaw && /^\d{4}-\d{2}-\d{2}$/.test(toRaw) && toRaw >= dateParam
      ? toRaw
      : dateParam;
  // Bovengrens op de reeks: een half jaar aan rijen in één response
  // helpt niemand en is een makkelijke manier om de API plat te leggen.
  // 92 dagen ≈ een kwartaal, ruim boven wat de UI aanbiedt.
  const MAX_RANGE_DAYS = 92;
  const spanDays =
    Math.round(
      (Date.parse(`${toParam}T12:00:00Z`) -
        Date.parse(`${dateParam}T12:00:00Z`)) /
        86400000
    ) + 1;
  if (spanDays > MAX_RANGE_DAYS) {
    return c.json({ error: `reeks max ${MAX_RANGE_DAYS} dagen` }, 400);
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
  const windowEnd = sql`((${toParam}::date + 1)::text || ' 06:00:00')::timestamp AT TIME ZONE 'Europe/Amsterdam'`;
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
      genres: displayGenres,
      eventVenueId: schema.venues.id,
      eventVenueName: schema.venues.name,
      eventVenueType: schema.venues.type,
      eventVenueImageUrl: schema.venues.imageUrl,
    })
    .from(schema.occurrences)
    .innerJoin(schema.events, eq(schema.events.id, schema.occurrences.eventId))
    .innerJoin(schema.venues, eq(schema.venues.id, schema.events.venueId))
    .where(and(...conditions))
    .orderBy(asc(schema.occurrences.startsAt))
    // Ongelimiteerd was prima toen dit één dag was (~50 rijen). Met een
    // reeks van een maand loopt 't in de duizenden, en alles daarna
    // (venue-overrides, friends-pills, series) schaalt mee. 1500 dekt
    // een ruime maand Amsterdam; daarboven moet de gebruiker maar
    // filteren.
    .limit(1500);

  if (rows.length === 0) return c.json({ rows: [] });

  // Occurrence-venue overrides: voor films die in meerdere bioscopen
  // draaien wijkt occ.venueId af van event.venueId. Apart fetchen,
  // niet via JOIN — drizzle's aliasedTable speelt slecht samen met de
  // TS-inferentie en de N blijft behapbaar (gecapt op 1500 rijen).
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
 * historie, gevolgde venues en vrienden-saves. Geen ML, gewoon een
 * transparante linear-weighted score:
 *
 *   +1 per save in je historie met overlappend genre
 *   +2 per save in je historie bij hetzelfde venue
 *   +5 bonus als het venue gevolgd is
 *   +3 per vriend die dit event gesaved heeft (cap 9, dus max 3 vrienden tellen)
 *
 * Inclusie: events met score > 0 OF events bij een gevolgde venue
 * (zelfs zonder smaak-match). Excludes: events die je al gesaved hebt,
 * occurrences die je weggeswipet hebt, geblokkeerde venues, exhibitions.
 *
 * Twee modes:
 *   mode=rail (default) — score-desc sort, 21d horizon (of 7d met
 *     `week=1`), cap 30. Empty als gebruiker geen profiel-input heeft.
 *   mode=feed — chronologisch (eerstvolgend eerst), open horizon,
 *     cursor-pagination (`?cursor=<isoTime>|<eventId>` + `?limit=20`).
 *     Returnt `nextCursor` voor infinite scroll.
 */
eventsRoute.get('/for-you', async (c) => {
  const me = await maybeUserId(c);
  if (!me) return c.json({ events: [], nextCursor: null });

  const mode = c.req.query('mode') === 'feed' ? 'feed' : 'rail';
  const weekOnly = c.req.query('week') === '1';
  const limit = Math.min(
    50,
    Math.max(1, parseInt(c.req.query('limit') ?? '', 10) || (mode === 'feed' ? 20 : 30)),
  );
  const cursorRaw = c.req.query('cursor') ?? null;
  let cursor: { time: number; eventId: string } | null = null;
  if (cursorRaw) {
    const [t, id] = cursorRaw.split('|');
    const tMs = Date.parse(t ?? '');
    if (!Number.isNaN(tMs) && id) cursor = { time: tMs, eventId: id };
  }
  const allowedCategories = ['Muziek', 'Theater', 'Film', 'Kunst', 'Lezing', 'Literatuur'] as const;
  type Cat = (typeof allowedCategories)[number];
  // `?category=Muziek,Film` voor multi-select. Onbekende waardes
  // worden weggefilterd; lege lijst (of geen param) = geen filter.
  const categoryRaw = c.req.query('category');
  const categoryFilters: Cat[] = categoryRaw
    ? categoryRaw
        .split(',')
        .map((s) => s.trim())
        .filter((s): s is Cat =>
          (allowedCategories as readonly string[]).includes(s),
        )
    : [];

  // Stap 1 — smaak-signaal. Ja én nee, allebei recentheids-gewogen.
  // Gedeeld met /new zodat de dagelijkse lijst op hetzelfde profiel rankt
  // als de aanbevelingen; anders leert de app wel van je oordeel maar
  // merk je dat niet op de plek waar je 't gaf.
  const taste = await buildTasteProfile(me, displayGenres);

  const [followedRaw, blockedRaw, friendIds] = await Promise.all([
    getFollowedVenueIds(me),
    getBlockedVenueIds(me),
    getFriendIdsFor(me),
  ]);
  const followedVenueIds = new Set(followedRaw);
  const blockedSet = new Set(blockedRaw);

  // Zoek-signaal — wat de gebruiker recent via de gids/MCP zocht. `want`-
  // termen (genres/sferen) zijn expliciete intentie en voeden "Voor jou";
  // `avoid`-termen drukken matches. Laatste 90 dagen, recentheids-gewogen.
  const SEARCH_HALF_LIFE_MS = 45 * 24 * 3600 * 1000;
  const searchSince = new Date(Date.now() - 90 * 24 * 3600 * 1000);
  const searchRows = await db
    .select({
      profile: schema.zoekLogs.profile,
      createdAt: schema.zoekLogs.createdAt,
    })
    .from(schema.zoekLogs)
    .where(
      and(
        eq(schema.zoekLogs.userId, me),
        gte(schema.zoekLogs.createdAt, searchSince)
      )
    )
    .orderBy(desc(schema.zoekLogs.createdAt))
    .limit(100);

  const searchedGenre = new Map<string, number>();
  const avoidSet = new Set<string>();
  for (const r of searchRows) {
    const ageMs = Math.max(0, Date.now() - new Date(r.createdAt).getTime());
    const w = Math.pow(0.5, ageMs / SEARCH_HALF_LIFE_MS);
    const p = (r.profile ?? {}) as { want?: string[]; avoid?: string[] };
    for (const term of p.want ?? []) {
      const key = term.trim().toLowerCase();
      if (key) searchedGenre.set(key, (searchedGenre.get(key) ?? 0) + w);
    }
    for (const term of p.avoid ?? []) {
      const key = term.trim().toLowerCase();
      if (key) avoidSet.add(key);
    }
  }

  // Gebruiker zonder enig profiel-signaal (geen saves, geen follows, geen
  // zoekgeschiedenis) krijgt een lege response — niets om op te scoren.
  if (
    taste.likeCount === 0 &&
    followedRaw.length === 0 &&
    searchedGenre.size === 0
  ) {
    return c.json({ events: [], nextCursor: null });
  }

  const genreCount = taste.genreLike;
  const venueCount = taste.venueLike;
  const sceneCount = taste.sceneLike;
  const wijkCount = taste.wijkLike;

  // Welke events heb ik al gesaved? Niet opnieuw aanbevelen.
  const savedEventIds = new Set<string>();
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

  // Friend-save counts per event — voor scoring (vriend-signaal). Respecteer
  // savesVisibility: alleen vrienden met 'friends' of 'favorites' tellen mee.
  // Anders duwt een 'private' saver een event omhoog terwijl de (privacy-
  // correcte) friend-pill leeg blijft → uit de ranking afleidbaar wie 't
  // saved (side-channel). Gelijk aan wat buildFriendsByOccurrence voor de
  // pills hanteert.
  const friendSaveCountByEvent = new Map<string, number>();
  if (friendIds.length > 0) {
    const rows = await db
      .select({
        eventId: schema.occurrences.eventId,
        n: count(),
      })
      .from(schema.saves)
      .innerJoin(
        schema.occurrences,
        eq(schema.saves.occurrenceId, schema.occurrences.id)
      )
      .innerJoin(schema.users, eq(schema.saves.userId, schema.users.id))
      .where(
        and(
          inArray(schema.saves.userId, friendIds),
          inArray(schema.users.savesVisibility, ['friends', 'favorites'])
        )
      )
      .groupBy(schema.occurrences.eventId);
    for (const r of rows) friendSaveCountByEvent.set(r.eventId, r.n);
  }

  // Stap 2 — kandidaat-events: published, niet-geblokte venue, niet al
  // gesaved, kind=show (exhibitions horen niet in een tijd-gebaseerde
  // feed). We pakken hier breed (geen featured-filter, alle categorieën)
  // omdat de score zelf het sorteert.
  //
  // Sluit all-day / doorlopende items uit (span ≥ 23u, zelfde grens als
  // isAllDayRange in de app + de agenda-filter): musea labelen exposities
  // soms als kind='show', en een meerdaags all-day-blok ("WK bij Skatecafe,
  // 14–20 jun, hele dag") hoort in een lijst, niet in een persoonlijke feed/
  // rail. Getimede (festival-)occurrences hebben kórte spans en blijven.
  const eventConditions: SQL[] = [
    eq(schema.events.published, true),
    eq(schema.venues.published, true),
    eq(schema.events.kind, 'show'),
    sql`NOT EXISTS (
      SELECT 1 FROM ${schema.occurrences} o
      WHERE o.event_id = ${schema.events.id}
        AND COALESCE(o.ends_at, o.starts_at) - o.starts_at >= INTERVAL '23 hours'
    )`,
  ];
  if (savedEventIds.size > 0) {
    eventConditions.push(not(inArray(schema.events.id, [...savedEventIds])));
  }
  if (blockedSet.size > 0) {
    eventConditions.push(not(inArray(schema.events.venueId, [...blockedSet])));
  }
  if (categoryFilters.length > 0) {
    eventConditions.push(inArray(schema.events.category, categoryFilters));
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
      genres: displayGenres,
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

  // Stap 3 — score elke kandidaat. Inclusie: score > 0 OF event-venue
  // is gevolgd (gevolgde venues mogen ook zonder smaak-match meedoen).
  type Scored = (typeof candidates)[number] & {
    score: number;
    reason: string | null;
    /** Ontdekkings-pick: buiten je gebruikelijke smaak, tegen de filter-
        bubbel. Krijgt een eigen plek in de rail i.p.v. op score te sorteren. */
    discovery?: boolean;
  };
  // Discovery alleen voor users mét een smaakprofiel — een nieuwe user krijgt
  // sowieso de gewone (lege/score-loze) flow.
  const hasProfile =
    genreCount.size > 0 || venueCount.size > 0 || searchedGenre.size > 0;
  const scored: Scored[] = [];
  for (const ev of candidates) {
    let score = 0;
    // Genre-match (saves) + zoek-match + onthoud de sterkste matches voor
    // de reden.
    let bestGenre: string | null = null;
    let bestGenreW = 0;
    let bestSearched: string | null = null;
    let bestSearchedW = 0;
    let avoided = false;
    for (const g of ev.genres ?? []) {
      const key = g.trim().toLowerCase();
      if (!key) continue;
      // Netto genre-signaal: wat je saved minus wat je wegtikte. Een
      // genre waar je consequent nee op zegt zakt hierdoor onder nul en
      // duwt het event omlaag in plaats van 'm alleen niet te helpen.
      const gc = genreCount.get(key) ?? 0;
      const gd = dislikePenalty(taste.genreDislike.get(key) ?? 0);
      score += gc - gd;
      if (gc - gd > bestGenreW) {
        bestGenreW = gc - gd;
        bestGenre = g;
      }
      // Zoek-signaal: events met een genre dat je vaker zócht, omhoog.
      const sg = searchedGenre.get(key) ?? 0;
      if (sg > 0) {
        score += 1.5 * sg;
        if (sg > bestSearchedW) {
          bestSearchedW = sg;
          bestSearched = g;
        }
      }
      if (avoidSet.has(key)) avoided = true;
    }
    // Afgewezen genre (uit zoekgesprekken) → flink dempen.
    if (avoided) score -= 3;
    // Venue idem: drie keer nee bij dezelfde zaal is een uitspraak over
    // die zaal. Zwaarder gedempt dan genre (factor 1.5 tegen +2 voor een
    // save) omdat je bij een venue die veel programmeert vanzelf vaker
    // nee zegt — zie de exposure-kanttekening bij buildTasteProfile.
    const vc = venueCount.get(ev.venue.id) ?? 0;
    const vd = dislikePenalty(taste.venueDislike.get(ev.venue.id) ?? 0, 1.5);
    score += 2 * vc - vd;
    const sceneW = ev.venue.scene ? sceneCount.get(ev.venue.scene) ?? 0 : 0;
    const wijkW = ev.venue.wijk ? wijkCount.get(ev.venue.wijk) ?? 0 : 0;
    const sceneD = ev.venue.scene
      ? taste.sceneDislike.get(ev.venue.scene) ?? 0
      : 0;
    // Scene en wijk zijn brede assen — die mogen meewegen maar niet
    // domineren, dus blijft het aan beide kanten bij een vaste ±1.
    if (sceneW > 0) score += 1;
    else if (sceneD > 0) score -= 1;
    if (wijkW > 0) score += 1;
    const followed = followedVenueIds.has(ev.venue.id);
    if (followed) score += 5;
    // Friend-signaal — cap op 3 vrienden (max +9) zodat één super-
    // populair event niet alles overruled. Bij ≥3 vrienden is de
    // sociale push al sterk genoeg.
    const friendN = Math.min(3, friendSaveCountByEvent.get(ev.id) ?? 0);
    score += 3 * friendN;
    if (score > 0 || followed) {
      // Reden: de meest overtuigende factor eerst. Transparant en kort,
      // in Andreas-stijl (geen superlatieven). De friend-pill toont
      // daarnaast nog wíé er gaat.
      // Géén vrienden-reden in tekst: een save is interesse, geen belofte om
      // te gaan, en de scoring telt ook privacy-verborgen saves. De
      // (privacy-correcte) friend-pill toont al wíé interesse heeft.
      let reason: string | null = null;
      if (followed) {
        reason = `Je volgt ${ev.venue.name}`;
      } else if (bestGenre && bestGenreW > 0) {
        reason = `Je houdt van ${bestGenre.toLowerCase()}`;
      } else if (bestSearched && bestSearchedW > 0) {
        reason = `Je zocht vaker naar ${bestSearched.toLowerCase()}`;
      } else if (vc > 0) {
        reason = `Je komt vaker in ${ev.venue.name}`;
      } else if (wijkW > 0 && ev.venue.wijk) {
        reason = `Vaak in ${ev.venue.wijk.charAt(0).toUpperCase()}${ev.venue.wijk.slice(1)}`;
      } else if (sceneW > 0) {
        reason = 'Past bij jouw smaak';
      }
      scored.push({ ...ev, score, reason });
    } else if (hasProfile && ev.featured && !avoided) {
      // Geen affinity-match, maar wél een editorial-pick → ontdekking buiten
      // je gebruikelijke smaak. Bewust beperkt (alleen featured) zodat 't
      // curated blijft, niet willekeurig.
      scored.push({ ...ev, score: 0, reason: 'Iets nieuws voor je', discovery: true });
    }
  }

  if (scored.length === 0) return c.json({ events: [], nextCursor: null });

  // Stap 4 — horizon bepalen. Rail-mode: 21d (of 7d met weekOnly).
  // Feed-mode: open horizon (2 jaar = effectief unlimited; cursor
  // pagineert).
  // `window=tonight` → de proactieve "Jouw avond vanavond"-kaart: alleen
  // events binnen de logische avond/nacht (tot 06:00 NL). Hergebruikt het
  // venster van de gids zodat de grens (06:00) consistent is.
  const tonightOnly = c.req.query('window') === 'tonight';
  let horizonEnd = new Date();
  if (tonightOnly) {
    horizonEnd = resolveWhenWindow(
      { when: 'tonight' } as PreferenceProfile,
      new Date()
    ).to;
  } else if (mode === 'feed') {
    horizonEnd.setFullYear(horizonEnd.getFullYear() + 2);
  } else if (weekOnly) {
    horizonEnd.setDate(horizonEnd.getDate() + 7);
  } else {
    horizonEnd.setDate(horizonEnd.getDate() + 21);
  }
  const occRange = await findEventsWithOccurrencesInRange({
    from: new Date(),
    to: horizonEnd,
    eventIds: scored.map((s) => s.id),
  });

  // Bouw sorteerlijst: { id, score, anchorTime } per event met
  // tenminste één niet-gedismist occurrence in range.
  const ranked = scored
    .map((s) => {
      const occ = occRange.byEvent.get(s.id);
      if (!occ) return null;
      const firstActive = occ.all.find((o) => !dismissedOccIds.has(o.id));
      if (!firstActive) return null;
      return {
        id: s.id,
        score: s.score,
        anchorTime: firstActive.startsAt.getTime(),
        discovery: s.discovery ?? false,
      };
    })
    .filter(<T,>(x: T | null): x is T => x !== null);

  // Sortering verschilt per mode.
  let sorted: typeof ranked;
  if (mode === 'feed') {
    sorted = [...ranked].sort((a, b) => {
      if (a.anchorTime !== b.anchorTime) return a.anchorTime - b.anchorTime;
      return a.id.localeCompare(b.id);
    });
    if (cursor) {
      sorted = sorted.filter((e) => {
        if (e.anchorTime > cursor.time) return true;
        if (e.anchorTime < cursor.time) return false;
        return e.id.localeCompare(cursor.eventId) > 0;
      });
    }
  } else {
    // Rail: affinity op score, met een paar ontdekkings-picks ertussen
    // gevlochten (niet bovenaan) zodat de lijst niet in een filterbubbel
    // dichtslaat — Letterboxd/Wrapped-gevoel, geen TikTok.
    const DISCOVERY_N = 2;
    const affinity = ranked
      .filter((r) => !r.discovery)
      .sort((a, b) => {
        const dScore = b.score - a.score;
        if (dScore !== 0) return dScore;
        return a.anchorTime - b.anchorTime;
      });
    const disc = ranked
      .filter((r) => r.discovery)
      .sort((a, b) => a.anchorTime - b.anchorTime)
      .slice(0, DISCOVERY_N);
    const merged = affinity.slice(0, Math.max(0, limit - disc.length));
    let insertAt = 3;
    for (const d of disc) {
      merged.splice(Math.min(insertAt, merged.length), 0, d);
      insertAt += 4;
    }
    sorted = merged;
  }

  const page = sorted.slice(0, limit);
  const nextCursor =
    mode === 'feed' && page.length === limit
      ? `${new Date(page[page.length - 1].anchorTime).toISOString()}|${page[page.length - 1].id}`
      : null;

  const eventById = new Map(scored.map((s) => [s.id, s]));
  const ordered = page
    .map((p) => ({
      event: eventById.get(p.id),
      occ: occRange.byEvent.get(p.id),
    }))
    // Events zonder (nog niet voorbije) occurrence vallen weg: de gedeelde
    // findEventsWithOccurrencesInRange past de categorie-bewuste cutoff al
    // toe (Muziek 4u, overig 1u grace zonder eindtijd), dus een al-afgelopen
    // 18:10-film zit niet meer in occRange en verschijnt niet in de feed.
    .filter((x): x is { event: NonNullable<typeof x.event>; occ: NonNullable<typeof x.occ> } =>
      Boolean(x.event && x.occ)
    );

  // Standaard friend-pills + series + denormalisatie, gelijk aan GET /events.
  const eventIds = ordered.map((x) => x.event.id);
  const allOccurrenceIds = ordered.flatMap(({ occ }) =>
    occ.all
      .filter((o) => !dismissedOccIds.has(o.id))
      .map((o) => o.id)
  );
  const friendsByOcc = await buildFriendsByOccurrence(me, allOccurrenceIds);
  const seriesMap = await buildSeriesByEvent(eventIds);

  const events = ordered
    .map(({ event, occ }) => {
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
    // Geen relevante (nog niet voorbije) occurrence meer → niet tonen.
    const headOcc = occurrencesInRange[0];
    if (!headOcc) return null;
    const headFriends = friendsByOcc.get(headOcc.id);
    return {
      ...event,
      startsAt: headOcc.startsAt,
      endsAt: headOcc.endsAt,
      priceCents: headOcc.priceCents,
      priceNote: headOcc.priceNote,
      ticketUrl: headOcc.ticketUrl,
      occurrenceCount: occurrencesInRange.length,
      nextOccurrenceVenue: headOcc.venue ?? null,
      occurrencesInRange,
      friendsSaved: headFriends?.friends ?? [],
      friendsSavedCount: headFriends?.count ?? 0,
      venueFollowed: followedVenueIds.has(event.venue.id),
      series: seriesMap.get(event.id) ?? [],
      // Uitlegbare aanbeveling: waarom staat dit in "Voor jou"?
      reason: event.reason,
    };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  return c.json({ events, nextCursor });
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
 * "Net binnen" — wat is er sinds `since` aan het systeem toegevoegd?
 *
 * Anker is de **occurrence**, niet het event. Een nieuwe datum bij een
 * bestaand event (Melkweg plakt er drie shows bij, een wekelijks feest
 * krijgt zijn najaarsreeks) is nieuws; die zag je hiervoor niet, want
 * toen filterde deze route op `events.createdAt`. In de praktijk is dat
 * de meerderheid — op een drukke scrape-dag hoort 80-90% van de nieuwe
 * datums bij een event dat al bestond.
 *
 * Twee query-modes:
 *  - `?since=ISO` — alles met een occurrence-createdAt > since. Cap op
 *    30 dagen terug zodat een gebruiker die een kwartaal weg was geen
 *    payload van duizenden rijen krijgt.
 *  - geen `since` — de laatst toegevoegde N. Fallback zodat /new nooit
 *    kaal blijft.
 *
 * Verder:
 *  - `?lane=film,live` filtert op baan (zie LANE_SQL).
 *  - Resultaat is **per event**, nieuwste toevoeging eerst, met
 *    `newOccurrenceCount` zodat de UI "3 nieuwe datums" kan tonen.
 *  - `total` telt de events vóór de cap, zodat de UI "15 van 47" kan
 *    zeggen en een meer-knop kan aanbieden.
 *  - `laneCounts` voedt de filter-chips zonder tweede request.
 *
 * Lean shape — gelijk aan `/events?lean=1` zodat de client 'm met
 * EventListRow en de bestaande types kan renderen.
 */

/**
 * De vier banen waarin je een avond kiest, plus een restbak. Afgeleid
 * in de query, bewust géén kolom: de regel is een heuristiek die nog
 * gaat schuiven, en dan is één plek aanpassen goedkoper dan een
 * dagelijkse job die 8k rijen herberekent.
 *
 * Muziek splitst op venue-type én aanvangstijd — Paradiso en Melkweg
 * zijn `podium` maar draaien 's nachts clubprogramma, dus tijd moet
 * meebeslissen. Spiegelt wat /clubs en /live nu client-side doen.
 *
 * ponytail: venue-type komt van het event, niet van de occurrence.
 * Wijkt alleen af bij films in meerdere bioscopen, en dáár beslist de
 * categorie de baan al.
 */
const LANES = ['film', 'theater', 'live', 'club', 'kunst'] as const;
type Lane = (typeof LANES)[number];
const AMS_HOUR = sql`EXTRACT(HOUR FROM ${schema.occurrences.startsAt} AT TIME ZONE 'Europe/Amsterdam')`;
const LANE_SQL = sql<Lane>`CASE
  WHEN ${schema.events.category} = 'Film' THEN 'film'
  WHEN ${schema.events.category} = 'Theater' THEN 'theater'
  WHEN ${schema.events.category} = 'Muziek' THEN
    CASE WHEN ${schema.venues.type} = 'club' OR ${AMS_HOUR} >= 23 OR ${AMS_HOUR} < 5
      THEN 'club' ELSE 'live' END
  ELSE 'kunst'
END`;

eventsRoute.get('/new', async (c) => {
  const sinceParam = c.req.query('since');
  let since: Date | null = null;
  if (sinceParam) {
    const parsed = new Date(sinceParam);
    if (Number.isNaN(parsed.getTime()))
      return c.json({ error: 'bad-since' }, 400);
    const minSince = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    since = parsed < minSince ? minSince : parsed;
  }

  // Baan-filter. Onbekende waardes vallen weg; lege lijst = alles.
  const laneRaw = c.req.query('lane');
  const laneFilters: Lane[] = laneRaw
    ? laneRaw
        .split(',')
        .map((s) => s.trim())
        .filter((s): s is Lane => (LANES as readonly string[]).includes(s))
    : [];

  // Cap op 15 met since: de dagpagina moet áf kunnen. Op een zaterdag
  // komen er 150 events binnen en dan is "alles" geen lijst maar een
  // klus. De client vraagt een hogere limit op via de meer-knop.
  const defaultLimit = since ? 15 : 10;
  const limit = Math.min(
    Math.max(1, Number(c.req.query('limit') ?? defaultLimit) || defaultLimit),
    200
  );

  const me = await maybeUserId(c);
  const [blockedRaw, followedRaw, taste] = me
    ? await Promise.all([
        getBlockedVenueIds(me),
        getFollowedVenueIds(me),
        buildTasteProfile(me, displayGenres),
      ])
    : [[], [], null];
  const blockedVenueIds = new Set(blockedRaw);
  const followedVenueIds = new Set(followedRaw);

  // Stap 1 — de nieuwe occurrences zelf. Alleen wat nog moet gebeuren:
  // een gisteren gescrapete voorstelling van vorige week is geen nieuws.
  // Zelfde effectieve-eindtijd-regel als de rest van de feeds.
  const occRows = await db
    .select({
      eventId: schema.occurrences.eventId,
      occurrenceId: schema.occurrences.id,
      startsAt: schema.occurrences.startsAt,
      createdAt: schema.occurrences.createdAt,
      venueId: schema.venues.id,
      scene: schema.venues.scene,
      wijk: schema.venues.wijk,
      genres: displayGenres,
      lane: LANE_SQL,
    })
    .from(schema.occurrences)
    .innerJoin(schema.events, eq(schema.events.id, schema.occurrences.eventId))
    .innerJoin(schema.venues, eq(schema.venues.id, schema.events.venueId))
    .where(
      and(
        eq(schema.events.published, true),
        eq(schema.venues.published, true),
        ne(schema.occurrences.status, 'cancelled'),
        sql`COALESCE(${schema.occurrences.endsAt}, ${schema.occurrences.startsAt} + CASE WHEN ${schema.events.category} = 'Muziek' THEN INTERVAL '4 hours' ELSE INTERVAL '1 hour' END) >= NOW()`,
        since ? gt(schema.occurrences.createdAt, since) : sql`true`,
        blockedVenueIds.size > 0
          ? not(inArray(schema.venues.id, Array.from(blockedVenueIds)))
          : sql`true`
      )
    )
    .orderBy(desc(schema.occurrences.createdAt))
    // Ruime bovengrens: de drukste dag tot nu toe leverde ~570 nieuwe
    // datums. 4000 dekt een maand-inhaalslag zonder de payload te laten
    // ontsporen; we dedupen hierna toch naar events.
    .limit(4000);

  // Stap 2 — groepeer naar event, nieuwste toevoeging eerst. Melkweg die
  // twaalf datums bij één reeks plakt is één regel in de lijst, geen
  // twaalf. De baan van het vroegste nieuwe moment wint.
  type Agg = {
    eventId: string;
    lane: Lane;
    laneStartsAt: number;
    newOccurrenceIds: string[];
    venueId: string;
    scene: string | null;
    wijk: string | null;
    genres: string[];
    /** Smaak-score; 0 zolang je nog geen profiel hebt. */
    score: number;
  };
  const byEvent = new Map<string, Agg>();
  for (const row of occRows) {
    const startMs = new Date(row.startsAt).getTime();
    const existing = byEvent.get(row.eventId);
    if (!existing) {
      byEvent.set(row.eventId, {
        eventId: row.eventId,
        lane: row.lane,
        laneStartsAt: startMs,
        newOccurrenceIds: [row.occurrenceId],
        venueId: row.venueId,
        scene: row.scene,
        wijk: row.wijk,
        genres: row.genres ?? [],
        score: 0,
      });
      continue;
    }
    existing.newOccurrenceIds.push(row.occurrenceId);
    if (startMs < existing.laneStartsAt) {
      existing.lane = row.lane;
      existing.laneStartsAt = startMs;
    }
  }

  // Al beoordeeld = weg. Een ja of nee is een oordeel over het event,
  // niet over die ene voorstelling — dus één dismiss op een film met 19
  // screenings haalt de hele film uit je lijst, anders staat 'ie er
  // morgen via screening nummer twee gewoon weer. Dit is wat de pagina
  // over dagen heen laat leeglopen in plaats van dichtslibben.
  if (me && byEvent.size > 0) {
    const ids = [...byEvent.keys()];
    const [saved, dismissed] = await Promise.all([
      db
        .select({ eventId: schema.occurrences.eventId })
        .from(schema.saves)
        .innerJoin(
          schema.occurrences,
          eq(schema.saves.occurrenceId, schema.occurrences.id)
        )
        .where(
          and(
            eq(schema.saves.userId, me),
            inArray(schema.occurrences.eventId, ids)
          )
        ),
      db
        .select({ eventId: schema.occurrences.eventId })
        .from(schema.dismisses)
        .innerJoin(
          schema.occurrences,
          eq(schema.dismisses.occurrenceId, schema.occurrences.id)
        )
        .where(
          and(
            eq(schema.dismisses.userId, me),
            inArray(schema.occurrences.eventId, ids)
          )
        ),
    ]);
    for (const r of saved) byEvent.delete(r.eventId);
    for (const r of dismissed) byEvent.delete(r.eventId);
  }

  // Tellingen vóór de cap — de chips moeten laten zien wat je wegfiltert,
  // dus die tellen we over álle banen, niet over de gefilterde set.
  const laneCounts = Object.fromEntries(LANES.map((l) => [l, 0])) as Record<Lane, number>;
  for (const agg of byEvent.values()) laneCounts[agg.lane]++;

  const matching = [...byEvent.values()].filter(
    (agg) => laneFilters.length === 0 || laneFilters.includes(agg.lane)
  );
  const total = matching.length;

  // Binnen een baan op smaak sorteren. Dit is waar het beoordelen zich
  // terugbetaalt: elke ja en nee die je gisteren gaf bepaalt mee wat er
  // vandaag in je vijftien staat. Zonder profiel (score overal 0) valt
  // 'ie terug op nieuwste-eerst, precies zoals hiervoor.
  if (taste && (taste.likeCount > 0 || taste.dislikeCount > 0)) {
    for (const agg of matching) {
      let score = 0;
      for (const g of agg.genres) {
        const key = g.trim().toLowerCase();
        if (!key) continue;
        score +=
          (taste.genreLike.get(key) ?? 0) -
          dislikePenalty(taste.genreDislike.get(key) ?? 0);
      }
      score +=
        2 * (taste.venueLike.get(agg.venueId) ?? 0) -
        dislikePenalty(taste.venueDislike.get(agg.venueId) ?? 0, 1.5);
      if (agg.scene) {
        if ((taste.sceneLike.get(agg.scene) ?? 0) > 0) score += 1;
        else if ((taste.sceneDislike.get(agg.scene) ?? 0) > 0) score -= 1;
      }
      if (agg.wijk && (taste.wijkLike.get(agg.wijk) ?? 0) > 0) score += 1;
      if (followedVenueIds.has(agg.venueId)) score += 5;
      agg.score = score;
    }
  }

  // Beurtelings uit elke baan plukken i.p.v. botweg de nieuwste 15. Een
  // rechttoe-rechtaan slice levert vijftien films op zodra de bioscoop-
  // scrapers als laatste draaiden — dan lijkt er die dag niets anders te
  // zijn gebeurd.
  const queues = new Map<Lane, Agg[]>();
  for (const agg of matching) {
    const q = queues.get(agg.lane);
    if (q) q.push(agg);
    else queues.set(agg.lane, [agg]);
  }
  // Stabiel: gelijke scores houden hun nieuwste-eerst volgorde.
  for (const q of queues.values()) q.sort((a, b) => b.score - a.score);
  const page: Agg[] = [];
  while (page.length < limit) {
    let placed = false;
    for (const q of queues.values()) {
      const next = q.shift();
      if (!next) continue;
      page.push(next);
      placed = true;
      if (page.length >= limit) break;
    }
    if (!placed) break;
  }

  if (page.length === 0)
    return c.json({ events: [], total: 0, laneCounts });

  // Stap 3 — hang de volledige lean shape aan de gekozen events.
  const occRange = await findEventsWithOccurrencesInRange({
    eventIds: page.map((a) => a.eventId),
  });

  const eventRows = await db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      kind: schema.events.kind,
      category: schema.events.category,
      featured: schema.events.featured,
      genres: displayGenres,
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
    .where(inArray(schema.events.id, page.map((a) => a.eventId)));

  const rowById = new Map(eventRows.map((r) => [r.id, r]));

  // Volgorde van `page` aanhouden (nieuwste toevoeging eerst), niet die
  // van de DB-select.
  const events = page
    .map((agg) => {
      const event = rowById.get(agg.eventId);
      const occ = event ? occRange.byEvent.get(agg.eventId) : undefined;
      if (!event || !occ) return null;
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
        lane: agg.lane,
        newOccurrenceCount: agg.newOccurrenceIds.length,
        newOccurrenceIds: agg.newOccurrenceIds,
        /** Waar een ja/nee op landt. De rij toont `occ.next` (de
            eerstvolgende voorstelling), dus daar hoort een save ook op
            te landen — niet op de toevallig laatst-gescrapete. Valt
            terug op het nieuwe moment als er geen next is. */
        rateOccurrenceId: occ.next?.id ?? agg.newOccurrenceIds[0],
        // Verschil dat de UI moet kunnen maken: "nieuw" (event bestond
        // nog niet) versus "3 datums erbij" (bestaand event, nieuwe
        // voorstellingen). Zonder since is alles per definitie 'nieuw'.
        isNewEvent: since ? new Date(event.createdAt).getTime() > since.getTime() : true,
        friendsSaved: [],
        friendsSavedCount: 0,
        venueFollowed: followedVenueIds.has(event.venue.id),
        series: [],
        myInvitesCount: 0,
      };
    })
    .filter((e) => e !== null);

  return c.json({ events, total, laneCounts });
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
      genres: displayGenres,
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
