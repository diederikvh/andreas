/**
 * Last.fm als bron voor artiestgenres.
 *
 * Spotify geeft sinds 2026 geen genres meer aan een app in development
 * mode, en MusicBrainz-tags zijn dun (de helft van de artiesten mét een
 * MusicBrainz-record heeft er geen). Last.fm-tags komen van luisteraars
 * en zijn precies het soort woorden waar de genrelijst op matcht:
 * "synthpop", "deep house", "post-punk".
 *
 * `artist.getInfo` in plaats van `getTopTags`: die geeft ook het aantal
 * luisteraars, en dat hebben we nodig om een naamgenoot te weigeren.
 * Met een MusicBrainz-id is de match exact; op naam alleen niet.
 */
import { genresOf, type Category } from './alerts/genres.js';

const API_URL = 'https://ws.audioscrobbler.com/2.0/';

/** Alleen tags die iets zeggen: een genre uit onze lijst, of een decennium
    ("80s"). Last.fm-tags zijn van luisteraars, en daar zit veel ruis
    tussen: "want to see live", "the netherlands", "jazz favorites ram". */
const CATS: Category[] = ['Muziek', 'Theater'];
const DECADE = /^(19|20)?\d0'?s$/;
const useful = (t: string) =>
  DECADE.test(t) ||
  // Een ruim patroon als "%jazz%" vangt ook "breda jazz festival 2019" en
  // "jazz favorites ram": geen cijfers, geen lijstjes, hooguit drie woorden.
  (!/\d|favou?rite/.test(t) && t.split(/\s+/).length <= 3 && CATS.some((c) => genresOf(c, [t]).length > 0));
/** Onder dit aantal luisteraars komen de tags van een handvol mensen, en
    dan staat er "pidgeot house". */
const MIN_LISTENERS_FOR_TAGS = 500;

/** Tags die niets over de muziek zeggen. */
const NOISE = new Set([
  'seen live', 'favorites', 'favourites', 'favorite', 'albums i own', 'love', 'awesome', 'beautiful',
  'male vocalists', 'female vocalists', 'male vocalist', 'female vocalist', 'singer', 'band',
  'dutch', 'nederlands', 'nederland', 'british', 'uk', 'english', 'american', 'usa', 'belgian',
  'german', 'french', 'canadian', 'australian', 'swedish', 'irish', 'scottish', 'amsterdam', 'london',
]);

export type LastfmArtist = { name: string; mbid: string | null; listeners: number; tags: string[] };

/**
 * Eén artiest. `null` als Last.fm niet bereikbaar was (dan niets
 * markeren en later opnieuw), `undefined` als de artiest onbekend is.
 */
export async function lastfmArtist(
  name: string,
  mbid?: string | null
): Promise<LastfmArtist | undefined | null> {
  const key = process.env.LASTFM_API_KEY;
  if (!key) return null;
  const params = new URLSearchParams({ method: 'artist.getinfo', api_key: key, format: 'json', autocorrect: '1' });
  if (mbid) params.set('mbid', mbid);
  else params.set('artist', name);
  try {
    const r = await fetch(`${API_URL}?${params}`, { signal: AbortSignal.timeout(10000) });
    if (r.status === 429 || r.status >= 500) return null;
    const data = (await r.json()) as {
      error?: number;
      artist?: {
        name: string;
        mbid?: string;
        stats?: { listeners?: string };
        tags?: { tag?: { name: string }[] | { name: string } };
      };
    };
    // 6 = onbekende artiest; 29 = te snel.
    if (data.error === 29) return null;
    if (data.error || !data.artist) return undefined;
    const raw = data.artist.tags?.tag;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return {
      name: data.artist.name,
      mbid: data.artist.mbid || null,
      listeners: Number(data.artist.stats?.listeners ?? 0),
      tags:
        Number(data.artist.stats?.listeners ?? 0) < MIN_LISTENERS_FOR_TAGS
          ? []
          : list.map((t) => t.name.trim().toLowerCase()).filter((t) => t && !NOISE.has(t) && useful(t)),
    };
  } catch {
    return null;
  }
}
