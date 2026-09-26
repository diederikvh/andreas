/**
 * POST /zoek — de gids in de app.
 *
 * Eén Haiku-vertaling per vraag: de vraag (met de gespreksgeschiedenis en de
 * datum van vandaag) wordt vaste velden — absolute datums, genres uit de
 * vaste lijst, zalen, artiesten. Daarna zoekt `searchStructured` precies
 * dat, zonder keurder. De `reply` vat samen wat er begrepen is; de `events`
 * zijn de bron van waarheid voor de UI.
 *
 * Toegang + kosten:
 *  - Auth verplicht; alleen users met `guideEnabled` (opt-in via admin).
 *  - Globale dag-kill-switch en per-user dag-cap (zie hieronder).
 *  - Elke vraag wordt gelogd (telt voor de cap en voedt "Voor jou").
 *
 * Stateless: de client stuurt profiel + history elke beurt mee. Het profiel
 * gaat ongewijzigd terug (de app verwacht het); de context zit in de history.
 */
import { and, count, eq, gte, inArray } from 'drizzle-orm';
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
import { EMPTY_PROFILE, type PreferenceProfile, type ZoekChatTurn } from '../zoek/types.js';

export const zoekRoute = new Hono();

const MAX_MESSAGE_LEN = 500;
const MAX_HISTORY = 20;
/** Harde body-cap: 20 history-turns × 500 tekens + profiel past ruim in
    32KB. Voorkomt dat een grote body de LLM-input (en kosten) opblaast of
    het geheugen belast vóór validatie. */
const MAX_BODY_BYTES = 32 * 1024;
zoekRoute.use('*', bodyLimit({ maxSize: MAX_BODY_BYTES }));
/** Globale dag-cap (kill-switch). ~1,5 cent/vraag → 330 ≈ €5/dag. */
const DAILY_MAX = Number(process.env.ZOEK_DAILY_MAX_REQUESTS ?? 330);
/** Per-user dag-cap: ruim voor normaal gebruik, blokkeert één account dat de
    globale cap probeert leeg te trekken of kosten op te stapelen. */
const PER_USER_DAILY_MAX = Number(process.env.ZOEK_PER_USER_DAILY_MAX ?? 60);

zoekRoute.post('/', async (c) => {
  // ── Auth + toegang ────────────────────────────────────────────────────
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

  let body: { message?: unknown; profile?: unknown; history?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'ongeldige JSON' }, 400);
  }

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) return c.json({ error: 'message is verplicht' }, 400);
  if (message.length > MAX_MESSAGE_LEN) {
    return c.json({ error: 'message te lang' }, 400);
  }

  const incoming = mergeProfile(body.profile);
  const history = sanitizeHistory(body.history);
  const now = new Date();

  // ── Kill-switches: globaal + per-user ────────────────────────────────────
  // Globaal beschermt het budget; per-user voorkomt dat één gebruiker (of een
  // gelekte sessie) in z'n eentje de globale cap leegtrekt en de gids voor
  // iedereen platlegt — én begrenst de kosten die één account kan maken.
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [[usage], [mine]] = await Promise.all([
    db.select({ n: count() }).from(schema.zoekLogs).where(gte(schema.zoekLogs.createdAt, since)),
    db
      .select({ n: count() })
      .from(schema.zoekLogs)
      .where(
        and(
          gte(schema.zoekLogs.createdAt, since),
          eq(schema.zoekLogs.userId, session.user.id)
        )
      ),
  ]);
  if ((usage?.n ?? 0) >= DAILY_MAX || (mine?.n ?? 0) >= PER_USER_DAILY_MAX) {
    return c.json({
      reply:
        'De gids heeft z’n dagelijkse limiet bereikt en is even niet beschikbaar. Probeer het later opnieuw.',
      events: [],
      reasonByEventId: {},
      updatedProfile: incoming,
      capped: true,
    });
  }

  const fields = await translate(message, history, now);
  const { events: found, total, window, unknownVenues } = await searchEvents(session.user.id, {
    ...(fields ?? {}),
    limit: 10,
  });
  const ids = found.map((e) => e.id);
  const events = await hydrateEvents(ids, { from: new Date(window.from), to: new Date(window.to) });
  await logSearch(session.user.id, message, fields ?? {}, found);

  return c.json({
    reply: fields
      ? summarize(fields, found.length, total, window, unknownVenues)
      : 'Ik kon je vraag even niet vertalen. Dit staat er de komende week.',
    events,
    reasonByEventId: Object.fromEntries(found.map((e) => [e.id, e.why])),
    updatedProfile: incoming,
  });
});

// ─── Vertaling: vraag → velden ──────────────────────────────────────────────

const MODEL = 'claude-haiku-4-5';
const CITIES = schema.city.enumValues;
const CATEGORIES = ['Muziek', 'Film', 'Theater', 'Kunst', 'Lezing', 'Literatuur'];

const TOOL = {
  name: 'zoek',
  description: 'De zoekvelden voor deze vraag.',
  input_schema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Eerste dag, YYYY-MM-DD. Leeg als er geen periode genoemd is.' },
      to: { type: 'string', description: 'Laatste dag, YYYY-MM-DD, tot en met.' },
      cities: { type: 'array', items: { type: 'string', enum: CITIES } },
      categories: { type: 'array', items: { type: 'string', enum: CATEGORIES } },
      genres: {
        type: 'array',
        items: { type: 'string', enum: GENRE_KEYS },
        description: GENRE_KEYS.map((k) => `${k} = ${GENRES[k].label}`).join('; '),
      },
      venues: { type: 'array', items: { type: 'string' }, description: 'Zaalnamen zoals genoemd.' },
      artists: { type: 'array', items: { type: 'string' }, description: 'Alleen als de gebruiker deze artiest wil zien optreden.' },
      query: { type: 'string', description: 'Alleen een specifieke titel (film, voorstelling, festival).' },
      priceMaxEuros: { type: 'number' },
    },
  },
} as const;

const dateFmt = new Intl.DateTimeFormat('nl-NL', {
  timeZone: 'Europe/Amsterdam',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const isoDate = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });

/** Eén Haiku-call. `null` bij geen key, fout of onbruikbaar antwoord. */
async function translate(message: string, history: ZoekChatTurn[], now: Date): Promise<SearchEventsArgs | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  // Voor 06:00 hoort het nog bij gisteravond.
  const today = new Date(now.getTime() - 6 * 3_600_000);
  const system = [
    'Je vertaalt een vraag aan Andreas (een uitgaansgids voor Nederland) naar zoekvelden. Je beantwoordt de vraag niet.',
    `Vandaag is ${dateFmt.format(today)} (${isoDate(today)}).`,
    'Datums altijd absoluut (YYYY-MM-DD). Een dag loopt tot 06:00 de volgende ochtend, dus "vannacht" en "vanavond" zijn vandaag.',
    '"Dit weekend" = vrijdag t/m zondag van deze week; "volgende week" = maandag t/m zondag daarna. Geen periode genoemd: laat from/to leeg.',
    'Genres alleen uit de lijst. "Iets zoals <artiest>" is geen artiestfilter: kies de genres die bij die artiest passen.',
    'Een stad alleen als die genoemd wordt. Een zaal onder venues, een concrete titel onder query.',
    'Gebruik de eerdere beurten: een vervolgvraag ("en zaterdag?", "liever jazz") past de vorige velden aan en houdt de rest.',
  ].join('\n');
  const messages = [
    ...history.map((t) => ({ role: t.role, content: t.content })),
    { role: 'user' as const, content: message },
  ];
  // De API wil beginnen met een user-beurt.
  while (messages[0]?.role === 'assistant') messages.shift();
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        temperature: 0,
        system,
        tools: [TOOL],
        tool_choice: { type: 'tool', name: TOOL.name },
        messages,
      }),
    });
    if (!response.ok) {
      console.warn('[zoek] Anthropic', response.status, (await response.text()).slice(0, 200));
      return null;
    }
    const data = (await response.json()) as { content?: { type: string; name?: string; input?: Record<string, unknown> }[] };
    const input = data.content?.find((b) => b.type === 'tool_use' && b.name === TOOL.name)?.input;
    return input ? cleanFields(input) : null;
  } catch (err) {
    console.warn('[zoek] vertaling mislukt', (err as Error).message);
    return null;
  }
}

/** Model-uitvoer is niet te vertrouwen: alleen bekende waarden door. */
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
    query: typeof raw.query === 'string' && raw.query.trim() ? raw.query.trim().slice(0, 100) : undefined,
    priceMaxEuros: typeof raw.priceMaxEuros === 'number' && raw.priceMaxEuros >= 0 ? raw.priceMaxEuros : undefined,
  };
}

const dayFmt = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', weekday: 'short', day: 'numeric', month: 'short' });
const cityName = (c: string) => c.split('-').map((p) => p[0].toUpperCase() + p.slice(1)).join(' ');

/** Wat er begrepen is, in één zin: "Jazz in Utrecht, za 27 sep: 4 gevonden." */
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

/** Merge een binnengekomen (mogelijk onvolledig) profiel met de lege default
    zodat ontbrekende velden nooit undefined zijn. */
function mergeProfile(raw: unknown): PreferenceProfile {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_PROFILE };
  const p = raw as Partial<PreferenceProfile>;
  return {
    ...EMPTY_PROFILE,
    ...p,
    want: Array.isArray(p.want) ? p.want : [],
    avoid: Array.isArray(p.avoid) ? p.avoid : [],
    excludeVenueIds: Array.isArray(p.excludeVenueIds) ? p.excludeVenueIds : [],
    excludeEventIds: Array.isArray(p.excludeEventIds) ? p.excludeEventIds : [],
  };
}

function sanitizeHistory(raw: unknown): ZoekChatTurn[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (t): t is ZoekChatTurn =>
        t &&
        typeof t === 'object' &&
        (t.role === 'user' || t.role === 'assistant') &&
        typeof t.content === 'string'
    )
    .slice(-MAX_HISTORY)
    // Cap óók de lengte per turn: het aantal turns was al begrensd, maar
    // zonder content-cap kon een client 20 enorme strings sturen → ongeb0nde
    // LLM-input-tokens (en kosten) per request.
    .map((t) => ({ role: t.role, content: t.content.slice(0, MAX_MESSAGE_LEN) }));
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
