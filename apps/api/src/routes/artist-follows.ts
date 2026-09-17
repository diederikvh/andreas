/**
 * Artiesten volgen.
 *
 * Volg je iemand, dan krijg je bericht zodra er een nieuwe avond met hem
 * in de line-up binnenkomt. Alleen avonden die ná je volg-moment zijn
 * toegevoegd -- wat er al stond zie je op z'n pagina.
 *
 *   GET    /artist-follows        — de ids die ik volg
 *   POST   /artist-follows/:id    — volgen
 *   DELETE /artist-follows/:id    — niet meer volgen
 */
import { and, eq } from 'drizzle-orm';
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
    .select({ artistId: schema.artistFollows.artistId })
    .from(schema.artistFollows)
    .where(eq(schema.artistFollows.userId, userId));

  return c.json({ artistIds: rows.map((r) => r.artistId) });
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
