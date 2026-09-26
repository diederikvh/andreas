/**
 * POST /zoek — de gids in de app: zoeken met filters.
 *
 * Geen model: de app stuurt vaste velden (periode, stad, soort, genres,
 * artiesten, trefwoorden, titel) en `searchStructured` zoekt precies dat.
 * Zoeken in eigen woorden gaat via de MCP, met de AI van de gebruiker.
 * De `reply` zegt in één zin waarop gezocht is; de `events` zijn de bron van
 * waarheid voor de UI.
 *
 * Auth verplicht; alleen users met `guideEnabled` (opt-in via admin). Elke
 * zoekopdracht wordt gelogd en voedt "Voor jou".
 */
import { and, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { auth } from '../auth.js';
import { db, displayGenres, schema } from '../db/index.js';
import { GENRES, GENRE_KEYS, type GenreKey } from '../alerts/genres.js';
import { logSearch, searchEvents, type SearchEventsArgs } from '../alerts/search.js';
import {
  findEventsWithOccurrencesInRange,
  headOccurrenceInWindow,
} from './_helpers.js';

export const zoekRoute = new Hono();

zoekRoute.use('*', bodyLimit({ maxSize: 8 * 1024 }));

const CITIES = schema.city.enumValues;
const CATEGORIES = ['Muziek', 'Film', 'Theater', 'Kunst', 'Lezing', 'Literatuur'];

zoekRoute.post('/', async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'unauthorized' }, 401);

  const [user] = await db
    .select({ guideEnabled: schema.users.guideEnabled })
    .from(schema.users)
    .where(eq(schema.users.id, session.user.id))
    .limit(1);
  if (!user?.guideEnabled) {
    return c.json({ error: 'De gids is voor jou nog niet beschikbaar.' }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'ongeldige JSON' }, 400);
  }

  // Een oudere app stuurt nog een vrije vraag. Die vertalen we niet meer.
  if (typeof body.message === 'string' && body.fields === undefined) {
    return c.json({
      reply:
        'De gids zoekt nu met filters. Werk de app bij, of vraag het in eigen woorden aan je eigen AI: andreas.amsterdam/ai.',
      events: [],
      reasonByEventId: {},
      updatedProfile: body.profile ?? null,
    });
  }

  const fields = cleanFields((body.fields ?? {}) as Record<string, unknown>);
  const { events: found, total, window, unknownVenues } = await searchEvents(session.user.id, {
    ...fields,
    limit: 20,
  });
  const events = await hydrateEvents(
    found.map((e) => e.id),
    { from: new Date(window.from), to: new Date(window.to) }
  );
  await logSearch(session.user.id, `(filters) ${describeFields(fields)}`.slice(0, 500), fields, found);

  return c.json({
    reply: summarize(fields, found.length, total, window, unknownVenues),
    events,
    reasonByEventId: Object.fromEntries(found.map((e) => [e.id, e.why])),
    total,
  });
});

/** Wat de app stuurt is niet te vertrouwen: alleen bekende waarden door. */
function cleanFields(raw: Record<string, unknown>): SearchEventsArgs {
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()).slice(0, 10) : undefined;
  const oneOf = <T extends string>(v: unknown, allowed: readonly T[]) => strings(v)?.filter((x): x is T => allowed.includes(x as T));
  const date = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
  let from = date(raw.from);
  let to = date(raw.to);
  if (from && !to) to = from;
  if (to && !from) from = to;
  if (from && to && to < from) [from, to] = [to, from];
  const nonEmpty = <T>(xs: T[] | undefined) => (xs?.length ? xs : undefined);
  return {
    from,
    to,
    cities: nonEmpty(oneOf(raw.cities, CITIES)),
    categories: nonEmpty(oneOf(raw.categories, CATEGORIES)),
    genres: nonEmpty(oneOf(raw.genres, GENRE_KEYS as readonly GenreKey[])),
    venues: nonEmpty(strings(raw.venues)),
    artists: nonEmpty(strings(raw.artists)),
    keywords: nonEmpty(strings(raw.keywords)),
    query: typeof raw.query === 'string' && raw.query.trim() ? raw.query.trim().slice(0, 100) : undefined,
    priceMaxEuros: typeof raw.priceMaxEuros === 'number' && raw.priceMaxEuros >= 0 ? raw.priceMaxEuros : undefined,
  };
}

const dayFmt = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', weekday: 'short', day: 'numeric', month: 'short' });
const cityName = (c: string) => c.split('-').map((p) => p[0].toUpperCase() + p.slice(1)).join(' ');

/** Waarop gezocht is, in één zin: "Jazz in Utrecht, za 27 sep: 4 gevonden." */
function summarize(
  f: SearchEventsArgs,
  shown: number,
  total: number,
  window: { from: string; to: string },
  unknownVenues: string[]
): string {
  const what = [
    ...(f.genres ?? []).map((k) => GENRES[k].label),
    ...(f.genres?.length ? [] : (f.categories ?? []).map((c) => c.toLowerCase())),
  ];
  const parts = [
    what.length ? what.join(', ') : 'Alles',
    f.artists?.length ? `met ${f.artists.join(', ')}` : '',
    f.keywords?.length ? `met ${f.keywords.map((k) => `"${k}"`).join(' of ')}` : '',
    f.query ? `"${f.query}"` : '',
    f.venues?.length ? `in ${f.venues.join(', ')}` : '',
    f.cities?.length ? `in ${f.cities.map(cityName).join(', ')}` : '',
    f.priceMaxEuros != null ? `tot €${f.priceMaxEuros}` : '',
  ].filter(Boolean);
  const a = dayFmt.format(new Date(window.from));
  const b = dayFmt.format(new Date(Date.parse(window.to) - 6 * 3_600_000 - 1));
  const period = a === b ? a : `${a} – ${b}`;
  const head = `${parts.join(' ')}, ${period}`;
  const unknown = unknownVenues.length ? ` ${unknownVenues.join(', ')} ken ik niet.` : '';
  if (total === 0) return `${head}: niets gevonden.${unknown} Probeer een langere periode of minder eisen.`;
  const count = total > shown ? `${total} gevonden, hier de eerste ${shown}` : `${total} gevonden`;
  return `${head}: ${count}.${unknown}`;
}

function describeFields(f: SearchEventsArgs): string {
  return Object.entries(f)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`)
    .join(' ');
}

/**
 * Haal volledige event-objecten op in de `ApiEvent`-shape die de mobile-app
 * verwacht (zelfde velden als GET /events). Behoudt de volgorde van `ids`
 * (= de volgorde waarin het LLM ze koos), en toont de occurrence binnen
 * HETZELFDE venster als de retrieval. Geen auth-afhankelijke velden in v1.
 */
async function hydrateEvents(ids: string[], window: { from: Date; to: Date }) {
  if (ids.length === 0) return [];

  const rows = await db
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
    .where(and(inArray(schema.events.id, ids), eq(schema.events.published, true)));

  const eventById = new Map(rows.map((r) => [r.id, r]));
  const { byEvent } = await findEventsWithOccurrencesInRange({
    from: window.from,
    to: window.to,
    eventIds: ids,
  });

  const out = [];
  for (const id of ids) {
    const event = eventById.get(id);
    const occ = byEvent.get(id);
    if (!event || !occ) continue;
    const { inWindow, head } = headOccurrenceInWindow(occ, window.from, window.to);
    if (!head) continue;
    out.push({
      ...event,
      startsAt: head.startsAt,
      endsAt: head.endsAt,
      priceCents: head.priceCents,
      priceNote: head.priceNote,
      ticketUrl: head.ticketUrl,
      occurrenceCount: inWindow.length || occ.count,
      nextOccurrenceVenue: head.venue ?? null,
      occurrencesInRange: (inWindow.length ? inWindow : occ.all).map((o) => ({
        ...o,
        friendsSaved: [],
        friendsSavedCount: 0,
      })),
      friendsSaved: [],
      friendsSavedCount: 0,
      venueFollowed: false,
      series: [],
      myInvitesCount: 0,
    });
  }
  return out;
}
