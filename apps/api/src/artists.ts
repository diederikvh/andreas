/**
 * Een artiest-rij op naam, los van de routes: de koppeljob gebruikt dit
 * ook, en die mag de auth-module niet meeslepen.
 */
import { sql } from 'drizzle-orm';

import { db } from './db/index.js';

/** De artiest-rij bij deze naam; maakt 'm aan als we 'm nog niet kennen.
    Ook gebruikt door de admin, bij het invullen van een line-up. */
export async function ensureArtistByName(name: string, spotifyUrl?: string): Promise<string | null> {
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
      VALUES (${id}, ${name}, ${spotifyUrl ?? null})
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
  return artistId;
}
