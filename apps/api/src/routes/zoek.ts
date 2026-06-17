/**
 * POST /zoek — conversationele uitgaans-zoek (de "Andreas-gids").
 *
 * Flow per beurt (brief §2): profiel-update → retrieval (harde DB-query,
 * geen AI) → LLM-call met tool-use → valideren → volledige DB-events ophalen
 * voor de gevalideerde ids → response. De `reply` is puur tekst; de `events`
 * zijn de bron van waarheid voor de UI.
 *
 * Toegang + kosten:
 *  - Auth verplicht; alleen users met `guideEnabled` (opt-in via admin).
 *  - Globale dag-kill-switch: max ~ZOEK_DAILY_MAX_REQUESTS vragen per 24u
 *    (default 330 ≈ €5/dag). Daarboven antwoorden we zonder LLM-call.
 *  - Elke beoordeelde vraag wordt gelogd (telt voor de cap + §10-inzicht).
 *
 * Stateless (brief §5): de client stuurt profiel + history elke beurt mee, de
 * server geeft het bijgewerkte profiel terug. Geen sessie-opslag in v1.
 */
import { randomUUID } from 'node:crypto';

import { and, count, eq, gte, inArray } from 'drizzle-orm';
import { Hono } from 'hono';

import { auth } from '../auth.js';
import { db, displayGenres, schema } from '../db/index.js';
import {
  findEventsWithOccurrencesInRange,
  headOccurrenceInWindow,
} from './_helpers.js';
import { runProfileUpdate, runZoekTurn } from '../zoek/llm.js';
import { detectWhenOverride, gatherCandidates } from '../zoek/retrieval.js';
import { EMPTY_PROFILE, type PreferenceProfile, type ZoekChatTurn } from '../zoek/types.js';

export const zoekRoute = new Hono();

const MAX_MESSAGE_LEN = 500;
const MAX_HISTORY = 20;
/** Globale dag-cap (kill-switch). ~1,5 cent/vraag → 330 ≈ €5/dag. */
const DAILY_MAX = Number(process.env.ZOEK_DAILY_MAX_REQUESTS ?? 330);

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

  // ── Dag-kill-switch ─────────────────────────────────────────────────────
  // Tel de vragen van de afgelopen 24u; daarboven geen LLM-call meer.
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [usage] = await db
    .select({ n: count() })
    .from(schema.zoekLogs)
    .where(gte(schema.zoekLogs.createdAt, since));
  if ((usage?.n ?? 0) >= DAILY_MAX) {
    return c.json({
      reply:
        'De gids heeft z’n dagelijkse limiet bereikt en is even niet beschikbaar. Probeer het later opnieuw.',
      events: [],
      reasonByEventId: {},
      updatedProfile: incoming,
      capped: true,
    });
  }

  // [1] profiel-update VÓÓR de retrieval, zodat de tijd-window/prijs/uitslui-
  // tingen van de huidige beurt meteen meetellen. Bij geen key/fout: incoming.
  const profile = await runProfileUpdate({ message, profile: incoming, history }, now);

  // Deterministische override voor expliciete periode-woorden ("deze maand",
  // "dit jaar", …) — altijd doorwerken, ongeacht het profiel-LLM.
  const whenOverride = detectWhenOverride(message);
  if (whenOverride) {
    profile.when = whenOverride;
    profile.whenDate = undefined;
  }

  // [2] retrieval — gecentraliseerd in gatherCandidates: expliciete tijd hard,
  // eigennaam → heel jaar, genre/sfeer → progressief verbreden vanuit kort.
  const { candidates, sparse, window } = await gatherCandidates(profile, now, {
    message,
    hasExplicitTime: whenOverride !== null,
  });

  // [3] LLM-beurt — kiest + praat. Bij geen key/failure: top-kandidaten zonder
  // model-tekst.
  const turn = await runZoekTurn({ message, profile, history, candidates, sparse });

  const chosenIds = turn
    ? turn.chosenEventIds
    : candidates.slice(0, 5).map((cand) => cand.id);
  const events = await hydrateEvents(chosenIds, window);

  // Log de beurt (telt voor de cap + voedt §10-inzicht). Niet-blokkerend bij
  // een fout: de gebruiker krijgt z'n antwoord ook als de log faalt.
  try {
    await db.insert(schema.zoekLogs).values({
      id: randomUUID(),
      userId: session.user.id,
      message,
      profile,
      shownEventIds: chosenIds,
    });
  } catch (e) {
    console.warn('[zoek] kon log niet schrijven:', (e as Error).message);
  }

  if (!turn) {
    return c.json({
      reply: sparse
        ? 'Er staat weinig dat hierop past. Wil je verder weg kijken of een andere avond?'
        : 'Dit zijn een paar opties die passen.',
      events,
      reasonByEventId: {},
      updatedProfile: profile,
    });
  }

  return c.json({
    reply: turn.reply,
    events,
    reasonByEventId: turn.reasonByEventId,
    updatedProfile: profile,
    ...(turn.needsMoreInfo ? { needsMoreInfo: turn.needsMoreInfo } : {}),
  });
});

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
    .slice(-MAX_HISTORY);
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
