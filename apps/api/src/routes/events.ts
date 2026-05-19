import { aliasedTable, and, asc, count, desc, eq, gt, ilike, inArray, isNull, ne, not, or, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';

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

const VALID_CATEGORIES = new Set(['Muziek', 'Theater', 'Literatuur', 'Film', 'Kunst', 'Lezing']);

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
  const q = c.req.query('q');
  // ?genre= kan herhaald worden voor multi-select OR-filter.
  const genres = c.req.queries('genre') ?? [];

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

  const eligibleEvents = await db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      description: schema.events.description,
      kind: schema.events.kind,
      imageUrl: schema.events.imageUrl,
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
  const allOccurrenceIds = ordered.flatMap(({ occ }) =>
    occ.all.map((o) => o.id)
  );
  const friendsByOcc = me
    ? await buildFriendsByOccurrence(me, allOccurrenceIds)
    : new Map();
  const seriesMap = await buildSeriesByEvent(eventIds);
  const followedVenueIds = me
    ? new Set(await getFollowedVenueIds(me))
    : new Set<string>();

  const events = ordered.map(({ event, occ }) => {
    // Per occurrence: friendsSaved van vrienden die díe specifieke
    // voorstelling/avond gesaved hebben. Een film op woensdag toont
    // niet de friends van de maandag-occurrence.
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
      // Volledige lijst occurrences in de gevraagde range — Agenda en
      // Avond gebruiken dit om per moment één rij te tonen ipv één per
      // event. Een 3-daags festival verschijnt zo op alle 3 dagen.
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

eventsRoute.get('/:id', async (c) => {
  const id = c.req.param('id');

  const [row] = await db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      description: schema.events.description,
      kind: schema.events.kind,
      imageUrl: schema.events.imageUrl,
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
