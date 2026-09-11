import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import { auth } from '../auth.js';
import { db, schema } from '../db/index.js';

/**
 * Events die gebruikers zelf aanmelden omdat Andreas ze nog niet kent —
 * fase 6 van docs/share-naar-andreas.md.
 *
 * Wat hier binnenkomt is een **aanmelding**, geen event: het landt in
 * `event_submissions` en wacht op een mens in de admin. Het alternatief
 * (direct een `events`-rij met `published = false`) zou betekenen dat elke
 * publieke query die filter moet kennen, en één vergeten filter is een
 * half event in de app.
 *
 * Maar wachten op die review mag geen prijs zijn voor wie de moeite nam.
 * Daarom kan je aan een aanmelding "ik ga" hebben (`submission_going`):
 * voor jezelf staat het meteen in je plannen, en wie daarna hetzelfde
 * affiche scant komt via `GET /submissions/match` in dezelfde wachtkamer
 * in plaats van een tweede aanmelding te maken. Publiek is het nergens:
 * niet in `/events`, niet in `/search`, niet in de gids.
 *
 * De payload is precies wat de whitelist in de app doorlaat: titel,
 * artiesten, venue, datum, tijd, stad. Het gedeelde bestand, de OCR-tekst
 * en alle ticketgegevens blijven op het toestel — zie fase 1.7.
 */
export const submissionsRoute = new Hono();

/** Zelfde grenzen als de whitelist aan de client-kant. De server vertrouwt
    die niet: dit is een publiek endpoint. */
const MAX = { title: 160, venue: 120, city: 80, artist: 120 } as const;
const MAX_ARTISTS = 8;

/** Acht of meer cijfers op een rij is geen eventtitel maar een ticket-,
    order- of barcodenummer. Zou zulke data hier tóch aankomen (oudere
    client, of iemand die met de API speelt), dan weigeren we het veld in
    plaats van het op te slaan. */
const NUMERIC_RUN = /(?:\d[ -]?){8,}/;

function clean(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  if (/[\r\n]/.test(value)) return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0 || trimmed.length > max) return null;
  if (NUMERIC_RUN.test(trimmed)) return null;
  return trimmed;
}

function cleanDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? value.trim() : null;
}

function cleanTime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  if (Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

async function optionalUserId(c: Context): Promise<string | null> {
  // Anoniem aanmelden mag: de importflow werkt zonder account, en iemand
  // weigeren omdat hij er geen heeft is precies de verkeerde drempel.
  try {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    return session?.user.id ?? null;
  } catch {
    return null;
  }
}

/**
 * POST /submissions — meld een onbekend event aan.
 *
 * Body: `{ title, artists, venue, date, time, city, source }`.
 * Antwoord: `{ id }`, of 400 als er te weinig overblijft om iets mee te
 * kunnen.
 */
submissionsRoute.post('/', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const title = clean(body.title, MAX.title);
  const venueName = clean(body.venue, MAX.venue);
  const artists = Array.isArray(body.artists)
    ? body.artists
        .map((a) => clean(a, MAX.artist))
        .filter((a): a is string => a !== null)
        .slice(0, MAX_ARTISTS)
    : [];

  // Zonder titel/artiest én zonder venue valt er niets te reviewen.
  if (!title && artists.length === 0 && !venueName) {
    return c.json({ error: 'te weinig gegevens' }, 400);
  }

  const userId = await optionalUserId(c);

  // Grof plafond tegen per-ongeluk-spam: 20 aanmeldingen per dag per
  // gebruiker. Anonieme sessies vallen hierbuiten (geen stabiele sleutel),
  // dus dit is een vangrail en geen beveiliging.
  if (userId) {
    const since = new Date(Date.now() - 24 * 3600_000);
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.eventSubmissions)
      .where(
        and(
          eq(schema.eventSubmissions.userId, userId),
          gte(schema.eventSubmissions.createdAt, since)
        )
      );
    if (count >= 20) return c.json({ error: 'rate_limited' }, 429);
  }

  // Matcht de venuenaam op een venue die we kennen? Dan is dit bijna zeker
  // een echt event en kan de review korter. Exact op genormaliseerde naam:
  // fuzzy matchen doet de app al, en een verkeerde gok hier zou de
  // aanmelding aan de verkeerde zaal hangen.
  let venueId: string | null = null;
  if (venueName) {
    const [hit] = await db
      .select({ id: schema.venues.id })
      .from(schema.venues)
      .where(sql`lower(${schema.venues.name}) = lower(${venueName})`)
      .limit(1);
    venueId = hit?.id ?? null;
  }

  const source =
    body.source === 'scan' || body.source === 'share'
      ? (body.source as 'scan' | 'share')
      : null;

  const id = `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  await db.insert(schema.eventSubmissions).values({
    id,
    title,
    artists,
    venueName,
    venueId,
    date: cleanDate(body.date),
    time: cleanTime(body.time),
    city: clean(body.city, MAX.city),
    userId,
    source,
  });

  // Meteen in je eigen plannen. Dit is het hele punt: je hebt net zelf
  // ingevuld waar je heen gaat, dan is "wacht op goedkeuring" het
  // verkeerde antwoord. Alleen met account — zonder account is er geen
  // agenda om het in te zetten.
  if (userId) {
    await db
      .insert(schema.submissionGoing)
      .values({ submissionId: id, userId })
      .onConflictDoNothing();
  }

  return c.json({ id, going: Boolean(userId) });
});

/** Wat een aanmelding aan de app teruggeeft. Geen userId, geen bron. */
function toCard(row: {
  id: string;
  title: string | null;
  artists: string[];
  venueName: string | null;
  city: string | null;
  date: string | null;
  time: string | null;
  status: string;
  eventId: string | null;
}) {
  return {
    id: row.id,
    title: row.title,
    artists: row.artists,
    venue: row.venueName,
    city: row.city,
    date: row.date,
    time: row.time,
    /** `true` zodra een mens er een echt event van heeft gemaakt; dan
        staat het ook gewoon in je plannen en mag deze kaart weg. */
    published: Boolean(row.eventId),
    eventId: row.eventId,
    status: row.status,
  };
}

/**
 * GET /submissions/mine — aanmeldingen waar ik heen ga.
 *
 * Voedt het groepje "wacht op Andreas" in de plannenlijst. Afgewezen
 * aanmeldingen vallen eruit: die gaan nooit meer een event worden en in je
 * agenda laten staan is liegen.
 */
submissionsRoute.get('/mine', async (c) => {
  const userId = await optionalUserId(c);
  if (!userId) return c.json({ submissions: [] });

  const rows = await db
    .select({
      id: schema.eventSubmissions.id,
      title: schema.eventSubmissions.title,
      artists: schema.eventSubmissions.artists,
      venueName: schema.eventSubmissions.venueName,
      city: schema.eventSubmissions.city,
      date: schema.eventSubmissions.date,
      time: schema.eventSubmissions.time,
      status: schema.eventSubmissions.status,
      eventId: schema.eventSubmissions.eventId,
    })
    .from(schema.submissionGoing)
    .innerJoin(
      schema.eventSubmissions,
      eq(schema.submissionGoing.submissionId, schema.eventSubmissions.id)
    )
    .where(
      and(
        eq(schema.submissionGoing.userId, userId),
        sql`${schema.eventSubmissions.status} <> 'rejected'`
      )
    )
    .orderBy(desc(schema.submissionGoing.createdAt));

  return c.json({ submissions: rows.map(toCard) });
});

/**
 * GET /submissions/match?title=&venue=&date= — is dit al aangemeld?
 *
 * Dit is de tweede helft van de keuzelijst in de importflow: naast de
 * echte events van Andreas zoekt die ook hier, want een avond die iemand
 * zelf heeft toegevoegd is voor de volgende scanner net zo goed een
 * kandidaat. Zonder dat staat dezelfde avond straks vier keer in de
 * wachtkamer.
 *
 * Zoeken op deel-van-de-titel (en op venue als die meekomt), niet exact:
 * de OCR leest "LOWERTOWN" waar iemand anders "Lowertown 2" invulde, en
 * een exacte vergelijking vindt dan niets. Dezelfde datum weegt mee in de
 * volgorde maar is geen eis — een half gelezen datum mag een kandidaat
 * niet wegfilteren.
 */
submissionsRoute.get('/match', async (c) => {
  const title = clean(c.req.query('title'), MAX.title);
  const venue = clean(c.req.query('venue'), MAX.venue);
  const date = cleanDate(c.req.query('date'));
  if (!title && !venue) return c.json({ submissions: [] });

  const rows = await db
    .select({
      id: schema.eventSubmissions.id,
      title: schema.eventSubmissions.title,
      artists: schema.eventSubmissions.artists,
      venueName: schema.eventSubmissions.venueName,
      city: schema.eventSubmissions.city,
      date: schema.eventSubmissions.date,
      time: schema.eventSubmissions.time,
      status: schema.eventSubmissions.status,
      eventId: schema.eventSubmissions.eventId,
    })
    .from(schema.eventSubmissions)
    .where(
      and(
        sql`${schema.eventSubmissions.status} <> 'rejected'`,
        isNull(schema.eventSubmissions.eventId),
        title
          ? sql`(
              ${schema.eventSubmissions.title} ilike ${'%' + title + '%'}
              or ${title} ilike '%' || ${schema.eventSubmissions.title} || '%'
            )`
          : sql`${schema.eventSubmissions.venueName} ilike ${'%' + venue + '%'}`
      )
    )
    // Zelfde datum eerst: bij twee aanmeldingen met dezelfde naam is de
    // avond die jij deelde bijna altijd de juiste. Geen datum? Dan alleen
    // op recentheid — een constante in ORDER BY leest Postgres als
    // kolomnummer ("ORDER BY position 0 is not in select list").
    .orderBy(
      ...(date
        ? [
            sql`case when ${schema.eventSubmissions.date} = ${date} then 0 else 1 end`,
          ]
        : []),
      desc(schema.eventSubmissions.createdAt)
    )
    .limit(5);

  return c.json({ submissions: rows.map(toCard) });
});

/**
 * POST /submissions/:id/going — ga ook naar deze aanmelding.
 * DELETE hetzelfde pad haalt je er weer af.
 */
submissionsRoute.post('/:id/going', async (c) => {
  const userId = await optionalUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  const id = c.req.param('id');

  const [sub] = await db
    .select({ id: schema.eventSubmissions.id, status: schema.eventSubmissions.status })
    .from(schema.eventSubmissions)
    .where(eq(schema.eventSubmissions.id, id))
    .limit(1);
  if (!sub || sub.status === 'rejected') {
    return c.json({ error: 'not_found' }, 404);
  }

  await db
    .insert(schema.submissionGoing)
    .values({ submissionId: id, userId })
    .onConflictDoNothing();
  return c.json({ going: true });
});

submissionsRoute.delete('/:id/going', async (c) => {
  const userId = await optionalUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  await db
    .delete(schema.submissionGoing)
    .where(
      and(
        eq(schema.submissionGoing.submissionId, c.req.param('id')),
        eq(schema.submissionGoing.userId, userId)
      )
    );
  return c.json({ going: false });
});
