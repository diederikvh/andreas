/**
 * Artiesten volgen.
 *
 * Volg je iemand, dan krijg je bericht zodra er een nieuwe avond met hem
 * in de line-up binnenkomt. Alleen avonden die ná je volg-moment zijn
 * toegevoegd -- wat er al stond zie je op z'n pagina.
 *
 *   GET    /artist-follows          — wie ik volg (ids + namen)
 *   GET    /artist-follows/upcoming — komende avonden van wie ik volg
 *   POST   /artist-follows/:id      — volgen
 *   DELETE /artist-follows/:id      — niet meer volgen
 *   POST   /artist-follows/by-name  — volgen wie we nog niet kennen
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import { auth } from '../auth.js';
import { db, schema } from '../db/index.js';

async function requireUserId(c: Context): Promise<string | Response> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  return session.user.id;
}

export const artistFollowsRoute = new Hono();

artistFollowsRoute.get('/', async (c) => {
  const userId = await requireUserId(c);
  if (typeof userId !== 'string') return userId;

  const rows = await db
    .select({
      id: schema.artists.id,
      name: schema.artists.name,
      imageUrl: schema.artists.imageUrl,
      genres: schema.artists.genres,
      followedAt: schema.artistFollows.createdAt,
    })
    .from(schema.artistFollows)
    .innerJoin(
      schema.artists,
      eq(schema.artists.id, schema.artistFollows.artistId)
    )
    .where(eq(schema.artistFollows.userId, userId))
    .orderBy(asc(schema.artists.name));

  // `artistIds` blijft erin: de volg-knoppen in de zoek en op de
  // artiest-pagina kijken daarnaar, en dat is goedkoper dan per knop de
  // hele lijst doorzoeken.
  return c.json({ artistIds: rows.map((r) => r.id), artists: rows });
});

/**
 * Komende avonden van artiesten die je volgt.
 *
 * Dezelfde vraag als die de melding stelt, maar dan als lijst: wat komt
 * eraan van wie ik volg. Eén rij per event -- staat een artiest drie
 * avonden achter elkaar, dan is dat één regel met de eerste datum, net
 * als bij de melding.
 */
artistFollowsRoute.get('/upcoming', async (c) => {
  const userId = await requireUserId(c);
  if (typeof userId !== 'string') return userId;

  const rows = await db.execute<{
    event_id: string;
    title: string;
    image_url: string | null;
    category: string;
    occ_id: string;
    starts_at: Date;
    ends_at: Date | null;
    venue_slug: string;
    venue_name: string;
    venue_type: string | null;
    artist_name: string;
  }>(sql`
    SELECT DISTINCT ON (e.id)
      e.id AS event_id, e.title, e.image_url, e.category::text AS category,
      o.id AS occ_id, o.starts_at, o.ends_at,
      v.slug AS venue_slug, v.name AS venue_name, v.type::text AS venue_type,
      ar.name AS artist_name
    FROM artist_follows f
    JOIN artists ar ON ar.id = f.artist_id
    JOIN occurrences o
      ON jsonb_typeof(o.lineup) = 'array'
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(o.lineup) le
       WHERE le->>'artistId' = f.artist_id
     )
    JOIN events e ON e.id = o.event_id AND e.published
    JOIN venues v ON v.id = COALESCE(o.venue_id, e.venue_id) AND v.published
    WHERE f.user_id = ${userId}
      AND o.starts_at > NOW()
      AND o.status <> 'cancelled'
    ORDER BY e.id, o.starts_at
  `);

  const events = (rows.rows ?? [])
    .map((r) => ({
      id: r.event_id,
      title: r.title,
      imageUrl: r.image_url,
      category: r.category,
      artistName: r.artist_name,
      // Met een rauwe query levert de driver "2026-09-25 21:00:00+00" op,
      // en dát parseert JavaScriptCore op iOS niet -- je krijgt een
      // Invalid Date en de rij klapt om bij het formatteren. Node is
      // ruimer, dus hier omzetten naar ISO en niet op de client.
      occurrence: {
        id: r.occ_id,
        startsAt: new Date(r.starts_at).toISOString(),
        endsAt: r.ends_at ? new Date(r.ends_at).toISOString() : null,
      },
      venue: { slug: r.venue_slug, name: r.venue_name, type: r.venue_type },
    }))
    // DISTINCT ON dwingt een sortering op e.id af, dus de chronologie
    // moet er hier weer overheen.
    .sort(
      (a, b) =>
        new Date(a.occurrence.startsAt).getTime() -
        new Date(b.occurrence.startsAt).getTime()
    );

  return c.json({ events });
});

artistFollowsRoute.post('/:artistId', async (c) => {
  const userId = await requireUserId(c);
  if (typeof userId !== 'string') return userId;
  const artistId = c.req.param('artistId');

  const [artist] = await db
    .select({ id: schema.artists.id })
    .from(schema.artists)
    .where(eq(schema.artists.id, artistId))
    .limit(1);
  if (!artist) return c.json({ error: 'artist niet gevonden' }, 404);

  // Twee keer volgen is gewoon volgen; geen fout van maken.
  await db
    .insert(schema.artistFollows)
    .values({ userId, artistId })
    .onConflictDoNothing();

  return c.json({ following: true });
});

/**
 * Iemand volgen die nog niet in onze catalogus staat.
 *
 * Onze artiesten komen uit line-ups die we hebben binnengehaald, dus wie
 * hier nooit speelde bestaat nog niet. Dat is precies de interessantste
 * zoekopdracht: iemand vertelt je wat hij wil zien.
 *
 * We maken de rij gewoon aan. Dat kan omdat de verrijking artiesten
 * dedupliceert op `lower(name)` (met een unieke index daarop): kondigt
 * een zaal deze artiest later aan, dan vindt de scraper déze rij terug in
 * plaats van een tweede te maken, en hangt de line-up er vanzelf aan. Je
 * volg-rij blijft dus geldig en gaat af zodra het nieuws er is. Geen
 * aparte wachtlijst die uit de pas gaat lopen.
 *
 * De naam komt bij voorkeur van Spotify (via de zoek in de app), zodat we
 * "Big Thief" opslaan en niet "big theif" -- een volg-rij op een typefout
 * gaat nooit af en dat merk je pas maanden later.
 */
artistFollowsRoute.post('/by-name', async (c) => {
  const userId = await requireUserId(c);
  if (typeof userId !== 'string') return userId;

  const body = (await c.req.json()) as { name?: string; spotifyUrl?: string };
  const name = (body.name ?? '').trim();
  if (name.length < 2 || name.length > 120) {
    return c.json({ error: 'Naam ontbreekt of is te lang.' }, 400);
  }

  // Eerst kijken of we 'm toch al hebben, hoofdletter-ongevoelig -- exact
  // zoals de verrijking dat doet.
  const existing = await db.execute<{ id: string }>(
    sql`SELECT id FROM artists WHERE lower(name) = lower(${name}) LIMIT 1`
  );
  let artistId = existing.rows?.[0]?.id ?? null;

  if (!artistId) {
    // Zelfde id-vorm als de verrijking: slug plus vier tekens, zodat twee
    // artiesten met dezelfde slug elkaar niet in de weg zitten.
    const slug = name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'artiest';
    const id = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
    const inserted = await db.execute<{ id: string }>(sql`
      INSERT INTO artists (id, name, spotify_url)
      VALUES (${id}, ${name}, ${body.spotifyUrl ?? null})
      ON CONFLICT DO NOTHING
      RETURNING id
    `);
    artistId = inserted.rows?.[0]?.id ?? null;
    if (!artistId) {
      // Race met een andere schrijver op lower(name): pak de bestaande.
      const again = await db.execute<{ id: string }>(
        sql`SELECT id FROM artists WHERE lower(name) = lower(${name}) LIMIT 1`
      );
      artistId = again.rows?.[0]?.id ?? null;
    }
  }
  if (!artistId) return c.json({ error: 'Kon de artiest niet vastleggen.' }, 500);

  await db
    .insert(schema.artistFollows)
    .values({ userId, artistId })
    .onConflictDoNothing();

  return c.json({ following: true, artistId });
});

artistFollowsRoute.delete('/:artistId', async (c) => {
  const userId = await requireUserId(c);
  if (typeof userId !== 'string') return userId;

  await db
    .delete(schema.artistFollows)
    .where(
      and(
        eq(schema.artistFollows.userId, userId),
        eq(schema.artistFollows.artistId, c.req.param('artistId'))
      )
    );
  return c.json({ following: false });
});
