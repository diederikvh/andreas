/**
 * Foto's bij artiesten zetten.
 *
 * Alleen voor wie we het Spotify-id al kennen: dat staat in de
 * `spotify_url` die de MusicBrainz-verrijking meegaf, dus er is geen
 * naamvergelijking en dus geen kans op de verkeerde artiest. Voor de
 * overige artiesten zou dat wél moeten, en daar hoort een aparte
 * afweging bij -- een foto van de verkeerde band is erger dan geen foto.
 *
 * **Via search, niet via /v1/artists.** Dat laatste geeft 403 voor een
 * app in development mode; zoeken mag wel. We zoeken dus op naam en
 * accepteren alleen het resultaat waarvan het Spotify-id gelijk is aan
 * wat wij al hadden opgeslagen. Zo is het nog steeds exact: de naam is
 * alleen de ingang, het id is het bewijs.
 *
 * **We slaan de URL op, niet het plaatje.** Spotify's voorwaarden staan
 * niet toe dat je hun beeld downloadt en zelf gaat hosten; je mag het
 * tonen zoals zij het aanleveren, met een verwijzing terug. Die
 * verwijzing staat al op de artiest-pagina. Nadeel: zo'n URL kan
 * verlopen, dus dit hoort af en toe opnieuw te draaien.
 */
import { sql } from 'drizzle-orm';

import { db } from '../db/index.js';
import { searchSpotifyArtists, spotifyIdFromUrl } from '../spotify-search.js';

export async function fillArtistImages(
  opts: { limit?: number; dryRun?: boolean } = {}
): Promise<{ looked: number; filled: number; missed: string[] }> {
  const limit = opts.limit ?? 200;
  const rows = await db.execute<{ id: string; name: string; spotify_url: string }>(sql`
    SELECT id, name, spotify_url FROM artists
    WHERE image_url IS NULL AND spotify_url IS NOT NULL
    ORDER BY id
    LIMIT ${limit}
  `);

  let filled = 0;
  let looked = 0;
  const missed: string[] = [];
  for (const row of rows.rows ?? []) {
    const want = spotifyIdFromUrl(row.spotify_url);
    if (!want) continue;
    looked++;
    const hits = await searchSpotifyArtists(row.name, 5);
    // Alleen het resultaat met hetzelfde id. Een naamgenoot bovenaan is
    // precies wat we niet willen, en dat gebeurt vaker dan je denkt bij
    // klassieke musici en dj-aliassen.
    const hit = hits.find((h) => h.spotifyId === want);
    if (!hit?.imageUrl) {
      missed.push(row.name);
      continue;
    }
    if (!opts.dryRun) {
      await db.execute(
        sql`UPDATE artists SET image_url = ${hit.imageUrl} WHERE id = ${row.id}`
      );
    }
    filled++;
    // Spotify staat een flinke snelheid toe maar niet oneindig; een
    // korte pauze houdt ons ruim onder de grens waar 429 begint.
    await new Promise((r) => setTimeout(r, 120));
  }
  return { looked, filled, missed: missed.slice(0, 10) };
}
