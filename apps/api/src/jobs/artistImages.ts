/**
 * Foto's bij artiesten zetten.
 *
 * Twee bronnen, in die volgorde. **Spotify** zolang we het id kennen:
 * dat staat in de `spotify_url` die de MusicBrainz-verrijking meegaf,
 * dus daar is de match bewezen. **Deezer** voor de rest, en die gaat
 * puur op naam -- zie `deezer.ts` voor waarom dat zwakker is.
 *
 * De wachtrij loopt op "nooit geprobeerd eerst, daarna de oudste
 * poging", zonder voorrang per bron: die twee groepen door elkaar
 * betekent dat een 429 bij Spotify de Deezer-groep niet stillegt.
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
import { deezerArtistImage } from '../deezer.js';
import { searchSpotifyArtists, spotifyIdFromUrl } from '../spotify-search.js';

/** Bron onbereikbaar (429, time-out). Anders dan "geen foto gevonden":
    de klus stopt erop en de rij blijft ongemoeid. */
export class ImageSourceUnavailable extends Error {}

/**
 * Eén artiest langs beide bronnen, en meteen wegschrijven.
 *
 * Spotify eerst zolang we het id hebben, want die match is bewezen.
 * Daarna Deezer op naam. De poging wordt altijd vastgelegd, ook als er
 * niets uitkwam -- zie `imageTriedAt` in het schema.
 *
 * Gooit `ImageSourceUnavailable` als geen van beide bronnen antwoord
 * gaf; dan is er niet gezocht en hoort er dus ook niets gemarkeerd.
 */
export async function fetchArtistImage(row: {
  id: string;
  name: string;
  spotify_url: string | null;
}): Promise<string | null> {
  let reachable = false;
  let imageUrl: string | null = null;

  const want = row.spotify_url ? spotifyIdFromUrl(row.spotify_url) : null;
  if (want) {
    const hits = await searchSpotifyArtists(row.name, 5);
    if (hits !== null) {
      reachable = true;
      // Alleen het resultaat met hetzelfde id. Een naamgenoot bovenaan is
      // precies wat we niet willen, en dat gebeurt vaker dan je denkt bij
      // klassieke musici en dj-aliassen.
      imageUrl = hits.find((h) => h.spotifyId === want)?.imageUrl ?? null;
    }
  } else {
    // Geen id, dus geen bewijs mogelijk -- Deezer op naam is hier het
    // beste dat er is. Andersom niet: valt de id-vergelijking bij
    // Spotify om, dan stonden er dus vijf ándere artiesten met deze naam
    // bovenaan, en juist dan is een naammatch bij Deezer het minst
    // betrouwbaar. Dat leverde foto's op bij "Abel", "Aldo" en "Amina"
    // en vrijwel zeker de verkeerde.
    try {
      imageUrl = await deezerArtistImage(row.name);
      reachable = true;
    } catch {
      // Bron eruit; niets markeren.
    }
  }

  if (!reachable) throw new ImageSourceUnavailable(row.name);

  await db.execute(sql`
    UPDATE artists
    SET image_tried_at = now()${imageUrl ? sql`, image_url = ${imageUrl}` : sql``}
    WHERE id = ${row.id}
  `);
  return imageUrl;
}

export async function fillArtistImages(
  opts: { limit?: number; dryRun?: boolean } = {}
): Promise<{ looked: number; filled: number; missed: string[] }> {
  const limit = opts.limit ?? 200;
  const rows = await db.execute<{ id: string; name: string; spotify_url: string }>(sql`
    SELECT id, name, spotify_url FROM artists
    WHERE image_url IS NULL
    -- Wie iemand volgt eerst: die staat in een lijst in de app. De rest
    -- (duizenden uit line-ups) komt daarna, op volgorde.
    ORDER BY image_tried_at NULLS FIRST,
      EXISTS (SELECT 1 FROM artist_follows f WHERE f.artist_id = artists.id) DESC, id
    LIMIT ${limit}
  `);

  let filled = 0;
  let looked = 0;
  const missed: string[] = [];
  // Ligt Spotify eruit (429), dan slaan we de artiesten die 'm nodig
  // hebben over en gaan we door met de rest. De rij zet die groep
  // vooraan, dus zonder dit zou één 429 de hele nacht stilleggen terwijl
  // Deezer gewoon bereikbaar is.
  let spotifyPlat = false;
  for (const row of rows.rows ?? []) {
    const viaSpotify = !!row.spotify_url;
    if (viaSpotify && spotifyPlat) continue;
    looked++;
    if (opts.dryRun) continue;
    let url: string | null;
    try {
      url = await fetchArtistImage(row);
    } catch {
      if (viaSpotify) {
        spotifyPlat = true;
        looked--;
        continue;
      }
      // Deezer eruit en dan is er niets meer over om te proberen.
      break;
    }
    if (url) filled++;
    else missed.push(row.name);
    // Rustig aan. De app-sleutel is dezelfde die de zoek in de app
    // gebruikt, dus een te snelle inhaalslag legt die zoek stil met een
    // 429 -- dat is één keer gebeurd en het kost niemand iets om hier
    // een halve seconde te wachten.
    await new Promise((r) => setTimeout(r, 500));
  }
  return { looked, filled, missed: missed.slice(0, 10) };
}
