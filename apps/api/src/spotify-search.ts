/**
 * Zoeken in de Spotify-catalogus met app-credentials.
 *
 * Bewust géén inloggen per gebruiker. Dat zou OAuth vragen én een
 * quota-aanvraag bij Spotify -- een app staat daar standaard op 25
 * gebruikers. Met `client_credentials` mag je de catalogus doorzoeken
 * zonder dat er ook maar iemand inlogt, en dat is alles wat we hier
 * nodig hebben: de juiste schrijfwijze van een naam.
 *
 * Waarvoor: zoekt iemand een artiest die wij niet kennen, dan willen we
 * "Big Thief" opslaan en niet "big theif". Een volg-rij op een typefout
 * gaat nooit af, en dat merk je pas maanden later.
 */
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SEARCH_URL = 'https://api.spotify.com/v1/search';

export type SpotifyArtist = {
  spotifyId: string;
  name: string;
  imageUrl: string | null;
  genres: string[];
  /** 0-100. Laag betekent vaak een naamgenoot of een dood project. */
  popularity: number;
};

/** Token leeft een uur; we houden 'm vast tot vlak voor het einde. */
let cached: { token: string; until: number } | null = null;

async function token(): Promise<string | null> {
  if (cached && Date.now() < cached.until) return cached.token;
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) return null;
  try {
    const basic = Buffer.from(`${id}:${secret}`).toString('base64');
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as {
      access_token: string;
      expires_in: number;
    };
    // Een minuut marge: een token dat tijdens de vlucht verloopt kost je
    // een mislukte zoekopdracht en die zie je als "niets gevonden".
    cached = {
      token: data.access_token,
      until: Date.now() + (data.expires_in - 60) * 1000,
    };
    return cached.token;
  } catch {
    return null;
  }
}

/**
 * Zoek artiesten. Geeft een lege lijst bij elke storing: dit is een
 * extraatje boven onze eigen catalogus, en als Spotify hapert hoort de
 * zoek gewoon door te werken.
 */
export async function searchSpotifyArtists(
  q: string,
  limit = 5
): Promise<SpotifyArtist[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const t = await token();
  if (!t) return [];
  try {
    const url = `${SEARCH_URL}?q=${encodeURIComponent(term)}&type=artist&limit=${limit}`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${t}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return [];
    const data = (await r.json()) as {
      artists?: {
        items?: {
          id: string;
          name: string;
          images?: { url: string }[];
          genres?: string[];
          popularity?: number;
        }[];
      };
    };
    return (data.artists?.items ?? []).map((a) => ({
      spotifyId: a.id,
      name: a.name,
      imageUrl: a.images?.[0]?.url ?? null,
      genres: a.genres ?? [],
      popularity: a.popularity ?? 0,
    }));
  } catch {
    return [];
  }
}

/**
 * Foto's ophalen voor artiesten waarvan we het Spotify-id al kennen.
 *
 * Exact, geen naamvergelijking: het id staat in de `spotify_url` die de
 * MusicBrainz-verrijking heeft meegegeven. Daarmee is er geen kans op de
 * verkeerde artiest, en dat is precies waarom deze helft eerst gaat.
 *
 * Per aanroep maximaal 50; dat is wat Spotify toestaat.
 */
export async function spotifyArtistsByIds(
  ids: string[]
): Promise<Map<string, SpotifyArtist>> {
  const out = new Map<string, SpotifyArtist>();
  if (ids.length === 0) return out;
  const t = await token();
  if (!t) return out;
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    try {
      const r = await fetch(
        `https://api.spotify.com/v1/artists?ids=${batch.join(',')}`,
        { headers: { Authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(10000) }
      );
      // 429 betekent dat we te hard gaan; stoppen is beter dan doorrammen
      // en door Spotify geblokkeerd worden. De volgende run pakt de rest.
      if (r.status === 429) break;
      if (!r.ok) continue;
      const data = (await r.json()) as {
        artists?: ({
          id: string;
          name: string;
          images?: { url: string }[];
          genres?: string[];
          popularity?: number;
        } | null)[];
      };
      for (const a of data.artists ?? []) {
        if (!a) continue;
        out.set(a.id, {
          spotifyId: a.id,
          name: a.name,
          imageUrl: a.images?.[0]?.url ?? null,
          genres: a.genres ?? [],
          popularity: a.popularity ?? 0,
        });
      }
    } catch {
      /* hapering: volgende batch */
    }
  }
  return out;
}

/** Het artiest-id uit een Spotify-URL. */
export function spotifyIdFromUrl(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/artist\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}
