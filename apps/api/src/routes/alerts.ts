/**
 * Meldingen in de app: dezelfde regels die je via Claude instelt, nu ook
 * op een scherm.
 *
 *   GET    /alerts          — mijn regels, met de laatste treffers
 *   GET    /alerts/genres   — de vaste genres om uit te kiezen
 *   GET    /alerts/found    — "Gevonden voor jou": alles wat meldingen en
 *                             gevolgde artiesten recent opleverden
 *   PATCH  /alerts/:id      — aan/uit (`{ active }`), of de velden aanpassen
 *   DELETE /alerts/:id      — weg
 *   POST   /alerts/preview  — wat er nu al zou passen, zonder op te slaan
 *   POST   /alerts          — opslaan
 *
 * In de app bouw je een regel uit vaste velden: soort, stad, genres,
 * artiesten en trefwoorden. Geen model, geen kosten. Smaak in eigen
 * woorden en zalen gaan via de MCP: de AI van de gebruiker vertaalt die
 * naar dezelfde velden.
 */
import { randomUUID } from 'node:crypto';

import { and, desc, eq, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import { GENRES, GENRE_KEYS, type GenreKey } from '../alerts/genres.js';
import { previewAlert, type AlertFilters } from '../alerts/match.js';
import { describeAlert } from '../alerts/service.js';
import { auth } from '../auth.js';
import { db, schema } from '../db/index.js';

async function requireUserId(c: Context): Promise<string | Response> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  return session.user.id;
}

export const alertsRoute = new Hono();

const CITIES = new Set<string>(schema.city.enumValues);
const CATEGORIES = new Set<string>(schema.eventCategory.enumValues);

const GENRE_SET = new Set<string>(GENRE_KEYS);

type RuleInput = {
  cities: string[];
  categories: string[];
  genres: GenreKey[];
  artists: string[];
  keywords: string[];
};

type RuleBody = Partial<Record<keyof RuleInput, unknown>>;

/** Controleer wat de app stuurt. Zonder genre, artiest of trefwoord wordt
    het een stroom. */
async function readRuleInput(c: Context): Promise<RuleInput | Response> {
  return checkRuleInput(c, (await c.req.json().catch(() => ({}))) as RuleBody);
}

function checkRuleInput(c: Context, body: RuleBody): RuleInput | Response {
  const list = (v: unknown, ok?: Set<string>) =>
    Array.isArray(v)
      ? [
          ...new Set(
            v
              .filter((x): x is string => typeof x === 'string')
              .map((x) => x.trim())
              .filter((x) => x.length >= 2 && x.length <= 60 && (!ok || ok.has(x)))
          ),
        ].slice(0, 20)
      : [];
  const input = {
    cities: list(body.cities, CITIES),
    categories: list(body.categories, CATEGORIES),
    genres: list(body.genres, GENRE_SET) as GenreKey[],
    artists: list(body.artists),
    keywords: list(body.keywords),
  };
  if (!input.genres.length && !input.artists.length && !input.keywords.length) {
    // Ook wat een oudere app ziet die nog een smaakzin stuurt.
    return c.json(
      {
        error:
          'Kies een genre, artiest of trefwoord. Een melding in eigen woorden stel je in via je eigen AI: andreas.amsterdam/ai.',
      },
      400
    );
  }
  return input;
}

const nullIfEmpty = <T,>(xs: T[]) => (xs.length ? xs : null);

const filtersOf = (userId: string, i: RuleInput): AlertFilters => ({
  userId,
  venueIds: null,
  cities: nullIfEmpty(i.cities),
  categories: nullIfEmpty(i.categories),
  genres: nullIfEmpty(i.genres),
  artistNames: nullIfEmpty(i.artists),
  keywords: nullIfEmpty(i.keywords),
  priceMaxCents: null,
  startsFrom: null,
  startsUntil: null,
});

const labelOf = (i: RuleInput) => describeAlert(i);

/** De kolommen voor insert/update. */
const columnsOf = (i: RuleInput) => ({
  label: labelOf(i),
  cities: nullIfEmpty(i.cities) as (typeof schema.city.enumValues)[number][] | null,
  categories: nullIfEmpty(i.categories) as (typeof schema.eventCategory.enumValues)[number][] | null,
  genres: nullIfEmpty(i.genres),
  artistNames: nullIfEmpty(i.artists),
  keywords: nullIfEmpty(i.keywords),
  // Opnieuw ingesteld: een oude smaakregel is nu een gewone regel.
  taste: null,
});

/** De genres waaruit je in de app kiest, per soort. Kinder- en
    workshopaanbod en tributes zijn soorten om uit te sluiten, geen smaak. */
alertsRoute.get('/genres', (c) =>
  c.json({
    genres: GENRE_KEYS.filter((k) => !['familie', 'workshop', 'tribute'].includes(k)).map((k) => ({
      key: k,
      label: GENRES[k].label,
      categories: GENRES[k].categories,
    })),
  })
);

alertsRoute.get('/', async (c) => {
  const userId = await requireUserId(c);
  if (typeof userId !== 'string') return userId;

  const alerts = await db
    .select({
      id: schema.alerts.id,
      label: schema.alerts.label,
      taste: schema.alerts.taste,
      cities: schema.alerts.cities,
      categories: schema.alerts.categories,
      genres: schema.alerts.genres,
      artistNames: schema.alerts.artistNames,
      keywords: schema.alerts.keywords,
      venueIds: schema.alerts.venueIds,
      active: schema.alerts.active,
      startsUntil: schema.alerts.startsUntil,
      createdAt: schema.alerts.createdAt,
    })
    .from(schema.alerts)
    .where(eq(schema.alerts.userId, userId))
    .orderBy(desc(schema.alerts.createdAt));

  // De laatste treffers per regel: wat er is klaargezet of verstuurd. Zo
  // zie je op het scherm wat een regel eigenlijk doet.
  const hits = await db.execute<{
    alert_id: string;
    event_id: string;
    title: string;
    venue: string;
    reason: string | null;
    sent: boolean;
    at: string;
  }>(sql`
    SELECT * FROM (
      SELECT h.*, ROW_NUMBER() OVER (PARTITION BY h.alert_id ORDER BY h.at DESC) AS n FROM (
        SELECT DISTINCT ON (r.alert_id, o.event_id)
               r.alert_id, o.event_id, e.title, v.name AS venue, r.note AS reason,
               r.sent_at IS NOT NULL AS sent, r.created_at AS at
        FROM reminders r
        JOIN alerts a ON a.id = r.alert_id AND a.user_id = ${userId}
        JOIN occurrences o ON o.id = r.occurrence_id
        JOIN events e ON e.id = o.event_id
        JOIN venues v ON v.id = COALESCE(o.venue_id, e.venue_id)
        WHERE r.created_at > NOW() - INTERVAL '30 days'
      ) h
    ) ranked
    WHERE n <= 5
  `);

  const byAlert = new Map<string, typeof hits.rows>();
  for (const h of hits.rows) byAlert.set(h.alert_id, [...(byAlert.get(h.alert_id) ?? []), h]);

  return c.json({
    alerts: alerts.map((a) => ({
      id: a.id,
      label: a.label,
      taste: a.taste,
      // Oude smaakregel van de keurder: doet niets tot hij opnieuw is ingesteld.
      legacy: a.taste !== null,
      // Een regel met zalen is via de MCP gemaakt; de app kan die niet bewerken.
      viaAi: a.venueIds !== null,
      // Voor het bewerk-formulier in de app.
      cities: a.cities ?? [],
      categories: a.categories ?? [],
      genres: a.genres ?? [],
      artists: a.artistNames ?? [],
      keywords: a.keywords ?? [],
      active: a.active,
      expired: a.startsUntil ? a.startsUntil.getTime() < Date.now() : false,
      createdAt: a.createdAt.toISOString(),
      hits: (byAlert.get(a.id) ?? [])
        .sort((x, y) => new Date(y.at).getTime() - new Date(x.at).getTime())
        .map((h) => ({
          eventId: h.event_id,
          title: h.title,
          venue: h.venue,
          reason: h.reason,
          sent: h.sent,
        })),
    })),
  });
});

/**
 * Gevonden voor jou: wat je meldingen en gevolgde artiesten opleverden, in
 * één lijst. Hier landt de gebundelde push ("3 nieuwe dingen voor jou");
 * op /new stonden die events tussen al het andere en waren ze niet terug
 * te vinden.
 *
 * Uit `reminders`, want dat is precies wat er gemeld is of om 10:00 klaar
 * staat. Alleen wat nog komt, nieuwste vondst eerst.
 */
alertsRoute.get('/found', async (c) => {
  const userId = await requireUserId(c);
  if (typeof userId !== 'string') return userId;

  const rows = await db.execute<{
    event_id: string;
    title: string;
    venue: string;
    city: string;
    starts_at: string;
    kind: string;
    reason: string | null;
    alert_id: string | null;
    alert_label: string | null;
    artist_name: string | null;
    sent: boolean;
  }>(sql`
    SELECT DISTINCT ON (o.event_id)
      o.event_id, e.title, v.name AS venue, v.city::text AS city, o.starts_at,
      r.kind::text AS kind, r.note AS reason, r.alert_id,
      a.label AS alert_label,
      (
        SELECT ar.name FROM event_artists ea
        JOIN artists ar ON ar.id = ea.artist_id
        JOIN artist_follows af ON af.artist_id = ar.id AND af.user_id = r.user_id
        WHERE ea.event_id = o.event_id
        ORDER BY ea.role = 'tribute'
        LIMIT 1
      ) AS artist_name,
      r.sent_at IS NOT NULL AS sent,
      r.created_at
    FROM reminders r
    JOIN occurrences o ON o.id = r.occurrence_id
    JOIN events e ON e.id = o.event_id AND e.published
    JOIN venues v ON v.id = COALESCE(o.venue_id, e.venue_id)
    LEFT JOIN alerts a ON a.id = r.alert_id
    WHERE r.user_id = ${userId}
      AND r.kind IN ('regel', 'artiest')
      AND r.created_at > NOW() - INTERVAL '30 days'
      AND o.starts_at > NOW()
      AND o.status <> 'cancelled'
    ORDER BY o.event_id, r.created_at DESC
  `);

  const found = rows.rows
    .sort((x, y) => new Date((y as any).created_at).getTime() - new Date((x as any).created_at).getTime())
    .slice(0, 50)
    .map((r) => ({
      eventId: r.event_id,
      title: r.title,
      venue: r.venue,
      city: r.city,
      startsAt: new Date(r.starts_at).toISOString(),
      // Waarom het hier staat: welke artiest of melding het vond (en bij
      // oude vondsten de reden van de keurder).
      reason:
        r.kind === 'artiest'
          ? r.artist_name
            ? `Je volgt ${r.artist_name}`
            : 'Een artiest die je volgt'
          : (r.reason ?? null),
      via: r.kind === 'artiest' ? null : (r.alert_label ?? null),
      alertId: r.alert_id,
      // Nog niet verstuurd: komt in de push van 10:00.
      sent: r.sent,
    }));

  return c.json({ found });
});

alertsRoute.patch('/:id', async (c) => {
  const userId = await requireUserId(c);
  if (typeof userId !== 'string') return userId;
  const body = (await c.req.json().catch(() => ({}))) as RuleBody & { active?: unknown };
  const where = and(eq(schema.alerts.id, c.req.param('id')), eq(schema.alerts.userId, userId));

  // Bewerken: nieuwe velden. Zalen (via de MCP) blijven staan.
  if (body.genres !== undefined || body.artists !== undefined || body.keywords !== undefined) {
    const input = checkRuleInput(c, body);
    if (input instanceof Response) return input;
    const cols = columnsOf(input);
    const [row] = await db.update(schema.alerts).set(cols).where(where).returning({ id: schema.alerts.id });
    if (!row) return c.json({ error: 'niet gevonden' }, 404);
    return c.json({ id: row.id, label: cols.label });
  }

  if (typeof body.active !== 'boolean') return c.json({ error: 'active ontbreekt' }, 400);
  const [row] = await db
    .update(schema.alerts)
    .set({ active: body.active })
    .where(where)
    .returning({ id: schema.alerts.id });
  if (!row) return c.json({ error: 'niet gevonden' }, 404);
  return c.json({ active: body.active });
});

alertsRoute.delete('/:id', async (c) => {
  const userId = await requireUserId(c);
  if (typeof userId !== 'string') return userId;
  await db
    .delete(schema.alerts)
    .where(and(eq(schema.alerts.id, c.req.param('id')), eq(schema.alerts.userId, userId)));
  return c.json({ deleted: true });
});

alertsRoute.post('/preview', async (c) => {
  const userId = await requireUserId(c);
  if (typeof userId !== 'string') return userId;
  const input = await readRuleInput(c);
  if (input instanceof Response) return input;
  // Wat er nú al staat en past. Daarover komt geen melding (alleen over wat
  // erbij komt), maar zo zie je of de regel te ruim of te krap is.
  const { total, events } = await previewAlert(filtersOf(userId, input), 6);
  return c.json({
    label: labelOf(input),
    total,
    events: events.map((e) => ({ id: e.id, title: e.title, venue: e.venue, startsAt: e.startsAt.toISOString() })),
  });
});

alertsRoute.post('/', async (c) => {
  const userId = await requireUserId(c);
  if (typeof userId !== 'string') return userId;
  const input = await readRuleInput(c);
  if (input instanceof Response) return input;
  const id = randomUUID();
  const cols = columnsOf(input);
  await db.insert(schema.alerts).values({ id, userId, ...cols });
  return c.json({ id, label: cols.label });
});
