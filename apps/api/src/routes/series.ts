import {
  and,
  arrayContains,
  asc,
  count,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  not,
  or,
  type SQL,
} from 'drizzle-orm';
import { Hono } from 'hono';

import { db, schema } from '../db/index.js';
import {
  buildFriendsByEvent,
  buildSeriesByEvent,
  findEventsWithOccurrencesInRange,
  maybeUserId,
} from './_helpers.js';
import {
  getBlockedVenueIds,
  getFollowedVenueIds,
} from './venue-follows.js';

const VALID_CATEGORIES = new Set(['Muziek', 'Theater', 'Literatuur', 'Film', 'Kunst']);

export const seriesRoute = new Hono();

/**
 * Lijst van alle series, gesorteerd op startdatum (of naam als geen
 * datum). Tellertje per serie van toekomstige events. Gebruikt voor de
 * "Series"-rij bovenaan de Venues-tab.
 */
seriesRoute.get('/', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  const category = c.req.query('category');
  // Default: alleen `featured` series — de Venues-tab top-strook is
  // bedoeld voor periode-festivals (Holland Festival, ADE, IDFA),
  // niet voor mini-series rond één tentoonstelling. Voor admin- of
  // search-context kan ?all=1 alle published series tonen.
  const showAll = c.req.query('all') === '1';

  // Verberg afgelopen series uit de lijst — series met `endsAt` in het
  // verleden zijn voorbij. Doorlopende cycli zonder vaste einddatum
  // (`endsAt IS NULL`) blijven altijd zichtbaar.
  const now = new Date();
  const stillActive = or(
    isNull(schema.series.endsAt),
    gt(schema.series.endsAt, now)
  )!;
  const conditions: SQL[] = [stillActive, eq(schema.series.published, true)];
  if (!showAll) {
    conditions.push(eq(schema.series.featured, true));
  }
  if (q.length > 0) {
    const needle = `%${q}%`;
    const matchName = ilike(schema.series.name, needle);
    const matchDesc = ilike(schema.series.description, needle);
    const combined = or(matchName, matchDesc);
    if (combined) conditions.push(combined);
  }
  if (category && VALID_CATEGORIES.has(category)) {
    conditions.push(
      arrayContains(schema.series.categories, [
        category as 'Muziek' | 'Theater' | 'Literatuur' | 'Film' | 'Kunst',
      ])
    );
  }
  const where = and(...conditions);

  const rows = await db
    .select({
      id: schema.series.id,
      slug: schema.series.slug,
      name: schema.series.name,
      description: schema.series.description,
      imageUrl: schema.series.imageUrl,
      startsAt: schema.series.startsAt,
      endsAt: schema.series.endsAt,
      categories: schema.series.categories,
    })
    .from(schema.series)
    .where(where)
    .orderBy(asc(schema.series.startsAt), asc(schema.series.name));

  // Tellertje toekomstige events per serie. Aparte query — kan later
  // naar één geaggregeerde call als dit een hot-path wordt.
  let countMap = new Map<string, number>();
  if (rows.length > 0) {
    const counts = await db
      .select({
        seriesId: schema.eventsInSeries.seriesId,
        n: count(schema.eventsInSeries.eventId),
      })
      .from(schema.eventsInSeries)
      .innerJoin(
        schema.events,
        eq(schema.events.id, schema.eventsInSeries.eventId)
      )
      .innerJoin(
        schema.occurrences,
        eq(schema.occurrences.eventId, schema.events.id)
      )
      .where(
        and(
          inArray(
            schema.eventsInSeries.seriesId,
            rows.map((r) => r.id)
          ),
          gte(schema.occurrences.startsAt, new Date())
        )
      )
      .groupBy(schema.eventsInSeries.seriesId);
    countMap = new Map(counts.map((c) => [c.seriesId, Number(c.n)]));
  }

  const series = rows.map((r) => ({
    ...r,
    eventCount: countMap.get(r.id) ?? 0,
  }));

  return c.json({ series });
});

seriesRoute.get('/:slug', async (c) => {
  const slug = c.req.param('slug');

  const [series] = await db
    .select()
    .from(schema.series)
    .where(
      and(eq(schema.series.slug, slug), eq(schema.series.published, true))
    )
    .limit(1);

  if (!series) return c.json({ error: 'series not found' }, 404);

  const me = await maybeUserId(c);
  const blocked = me ? await getBlockedVenueIds(me) : [];

  const eventConditions: SQL[] = [
    eq(schema.eventsInSeries.seriesId, series.id),
    eq(schema.events.published, true),
    eq(schema.venues.published, true),
  ];
  if (blocked.length > 0) {
    eventConditions.push(not(inArray(schema.events.venueId, blocked)));
  }

  const rows = await db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      description: schema.events.description,
      kind: schema.events.kind,
      imageUrl: schema.events.imageUrl,
      category: schema.events.category,
      featured: schema.events.featured,
      venue: {
        id: schema.venues.id,
        slug: schema.venues.slug,
        name: schema.venues.name,
        address: schema.venues.address,
        lat: schema.venues.lat,
        lng: schema.venues.lng,
      },
    })
    .from(schema.events)
    .innerJoin(
      schema.eventsInSeries,
      eq(schema.eventsInSeries.eventId, schema.events.id)
    )
    .innerJoin(schema.venues, eq(schema.events.venueId, schema.venues.id))
    .where(and(...eventConditions));

  // Filter op events met toekomstige (of nog lopende) occurrence + sort.
  const occRange = await findEventsWithOccurrencesInRange({
    eventIds: rows.map((r) => r.id),
  });
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const ordered = occRange.eventIds
    .map((id) => ({ row: rowById.get(id)!, occ: occRange.byEvent.get(id)! }))
    .filter((x) => x.row);

  const eventIds = ordered.map((x) => x.row.id);
  const friendsMap = me
    ? await buildFriendsByEvent(me, eventIds)
    : new Map();
  const seriesMap = await buildSeriesByEvent(eventIds);
  const followedVenueIds = me
    ? new Set(await getFollowedVenueIds(me))
    : new Set<string>();

  const events = ordered.map(({ row, occ }) => {
    const entry = friendsMap.get(row.id);
    return {
      ...row,
      startsAt: occ.next?.startsAt ?? null,
      endsAt: occ.next?.endsAt ?? null,
      priceCents: occ.next?.priceCents ?? null,
      priceNote: occ.next?.priceNote ?? null,
      ticketUrl: occ.next?.ticketUrl ?? null,
      occurrenceCount: occ.count,
      friendsSaved: entry?.friends ?? [],
      friendsSavedCount: entry?.count ?? 0,
      venueFollowed: followedVenueIds.has(row.venue.id),
      series: seriesMap.get(row.id) ?? [],
    };
  });

  return c.json({ series, events });
});
