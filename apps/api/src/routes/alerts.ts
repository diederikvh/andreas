/**
 * Meldingen in de app: dezelfde regels die je via Claude instelt, nu ook
 * op een scherm.
 *
 *   GET    /alerts          — mijn regels, met de laatste treffers
 *   GET    /alerts/found    — "Gevonden voor jou": alles wat meldingen en
 *                             gevolgde artiesten recent opleverden
 *   PATCH  /alerts/:id      — aan/uit (`{ active }`), of de smaak en grenzen
 *                             aanpassen (`{ taste, cities, categories }`)
 *   DELETE /alerts/:id      — weg (met alle feedback)
 *   POST   /alerts/preview  — proef op een smaak, zonder op te slaan
 *   POST   /alerts          — opslaan
 *
 * Toevoegen kan hier alleen als smaakregel: een omschrijving in eigen
 * woorden plus een grens (stad of categorie). Geen vertaalstap nodig, want
 * de omschrijving ís de regel; de keurder leest hem per nieuw event. Vaste
 * genreregels en regels op een zaal blijven via Claude lopen.
 */
import { randomUUID } from 'node:crypto';

import { and, desc, eq, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import { titleHasName, type AlertFilters } from '../alerts/match.js';
import { describeAlert, previewTaste } from '../alerts/service.js';
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

type TasteInput = { taste: string; cities: string[]; categories: string[] };

type TasteBody = { taste?: unknown; cities?: unknown; categories?: unknown };

/** Controleer wat de app stuurt. Een smaak zonder grens wordt een stroom. */
async function readTasteInput(c: Context): Promise<TasteInput | Response> {
  return checkTasteInput(c, (await c.req.json().catch(() => ({}))) as TasteBody);
}

function checkTasteInput(c: Context, body: TasteBody): TasteInput | Response {
  const taste = typeof body.taste === 'string' ? body.taste.trim() : '';
  if (taste.length < 3 || taste.length > 500) {
    return c.json({ error: 'Omschrijf in een paar woorden waar je van wil horen.' }, 400);
  }
  const list = (v: unknown, ok: Set<string>) =>
    Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && ok.has(x)))] : [];
  const cities = list(body.cities, CITIES);
  const categories = list(body.categories, CATEGORIES);
  if (cities.length === 0 && categories.length === 0) {
    return c.json({ error: 'Kies een stad of een soort, anders wordt het een stroom meldingen.' }, 400);
  }
  return { taste, cities, categories };
}

const filtersOf = (userId: string, i: TasteInput): AlertFilters => ({
  userId,
  venueIds: null,
  cities: i.cities.length ? i.cities : null,
  categories: i.categories.length ? i.categories : null,
  genres: null,
  artistNames: null,
  priceMaxCents: null,
  startsFrom: null,
  startsUntil: null,
});

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
      active: schema.alerts.active,
      startsUntil: schema.alerts.startsUntil,
      createdAt: schema.alerts.createdAt,
    })
    .from(schema.alerts)
    .where(eq(schema.alerts.userId, userId))
    .orderBy(desc(schema.alerts.createdAt));

  // De laatste treffers per regel: bij een smaakregel de ja's van de
  // keurder met reden, bij een vaste regel wat er is klaargezet. Zo zie je
  // op het scherm wat een regel eigenlijk doet.
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
        SELECT av.alert_id, av.event_id, e.title, v.name AS venue, av.reason,
               EXISTS (
                 SELECT 1 FROM reminders r JOIN occurrences o ON o.id = r.occurrence_id
                 WHERE r.alert_id = av.alert_id AND o.event_id = av.event_id AND r.sent_at IS NOT NULL
               ) AS sent,
               av.created_at AS at
        FROM alert_verdicts av
        JOIN alerts a ON a.id = av.alert_id AND a.user_id = ${userId}
        JOIN events e ON e.id = av.event_id
        JOIN venues v ON v.id = e.venue_id
        WHERE av.match AND av.created_at > NOW() - INTERVAL '30 days'
        UNION ALL
        SELECT DISTINCT ON (r.alert_id, o.event_id)
               r.alert_id, o.event_id, e.title, v.name, NULL, r.sent_at IS NOT NULL, r.created_at
        FROM reminders r
        JOIN alerts a ON a.id = r.alert_id AND a.user_id = ${userId} AND a.taste IS NULL
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
      // Voor het bewerk-formulier in de app.
      cities: a.cities ?? [],
      categories: a.categories ?? [],
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
    alert_taste: string | null;
    alert_label: string | null;
    artist_name: string | null;
    sent: boolean;
  }>(sql`
    SELECT DISTINCT ON (o.event_id)
      o.event_id, e.title, v.name AS venue, v.city::text AS city, o.starts_at,
      r.kind::text AS kind, r.note AS reason, r.alert_id,
      a.taste AS alert_taste, a.label AS alert_label,
      (
        SELECT ar.name FROM artist_follows af
        JOIN artists ar ON ar.id = af.artist_id
        WHERE af.user_id = r.user_id AND (
          (jsonb_typeof(o.lineup) = 'array' AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(o.lineup) le WHERE le->>'artistId' = ar.id
          ))
          OR ${sql.raw(titleHasName('ar.name'))}
        )
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
      // Waarom het hier staat: de reden van de keurder, of welke melding
      // of artiest het vond.
      reason:
        r.kind === 'artiest'
          ? r.artist_name
            ? `Je volgt ${r.artist_name}`
            : 'Een artiest die je volgt'
          : (r.reason ?? null),
      via: r.kind === 'artiest' ? null : (r.alert_taste ?? r.alert_label ?? null),
      alertId: r.alert_id,
      // Nog niet verstuurd: komt in de push van 10:00.
      sent: r.sent,
    }));

  return c.json({ found });
});

alertsRoute.patch('/:id', async (c) => {
  const userId = await requireUserId(c);
  if (typeof userId !== 'string') return userId;
  const body = (await c.req.json().catch(() => ({}))) as TasteBody & { active?: unknown };
  const where = and(eq(schema.alerts.id, c.req.param('id')), eq(schema.alerts.userId, userId));

  // Bewerken: nieuwe smaak en grenzen. De feedback (alert_verdicts) blijft
  // staan; wat de keurder leerde gaat niet weg omdat je de tekst bijschaaft.
  if (body.taste !== undefined) {
    const input = checkTasteInput(c, body);
    if (input instanceof Response) return input;
    const label = describeAlert({ taste: input.taste, cities: input.cities, categories: input.categories });
    const [row] = await db
      .update(schema.alerts)
      .set({
        taste: input.taste,
        label,
        cities: input.cities.length ? (input.cities as (typeof schema.city.enumValues)[number][]) : null,
        categories: input.categories.length
          ? (input.categories as (typeof schema.eventCategory.enumValues)[number][])
          : null,
      })
      .where(where)
      .returning({ id: schema.alerts.id });
    if (!row) return c.json({ error: 'niet gevonden' }, 404);
    return c.json({ id: row.id, label });
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
  const input = await readTasteInput(c);
  if (input instanceof Response) return input;
  const { sampled, yes, no } = await previewTaste(filtersOf(userId, input), input.taste);
  return c.json({
    label: describeAlert({ taste: input.taste, cities: input.cities, categories: input.categories }),
    sampled,
    yes,
    no: no.slice(0, 4),
  });
});

alertsRoute.post('/', async (c) => {
  const userId = await requireUserId(c);
  if (typeof userId !== 'string') return userId;
  const input = await readTasteInput(c);
  if (input instanceof Response) return input;
  const id = randomUUID();
  const label = describeAlert({ taste: input.taste, cities: input.cities, categories: input.categories });
  await db.insert(schema.alerts).values({
    id,
    userId,
    label,
    taste: input.taste,
    cities: input.cities.length ? (input.cities as (typeof schema.city.enumValues)[number][]) : null,
    categories: input.categories.length
      ? (input.categories as (typeof schema.eventCategory.enumValues)[number][])
      : null,
  });
  return c.json({ id, label });
});
