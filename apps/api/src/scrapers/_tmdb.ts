/**
 * TMDb (The Movie Database) lookup voor film-genres.
 *
 * Gebruikt door cinema-scrapers om bij nieuwe Film-events een
 * genre-array (`["Drama", "Documentaire"]`) in te vullen. TMDb's
 * `/search/movie` levert per titel een lijst met genre_ids; die
 * mappen we via `/genre/movie/list?language=nl-NL` naar Nederlandse
 * labels.
 *
 * Vereist `TMDB_API_KEY` (gratis op themoviedb.org/settings/api).
 * Zonder key gracefully skip — events krijgen dan een lege
 * genre-array, niet een crash.
 *
 * Cache:
 *   - Genre-ID → label: één fetch per server-process (genre-lijst
 *     wijzigt zelden).
 *   - Title → genres: één fetch per unieke title-call binnen
 *     dezelfde scrape-run (een scrape die "Anora" 3× opzoekt
 *     hoeft maar één keer naar TMDb).
 */

const TMDB_BASE = 'https://api.themoviedb.org/3';
const UA = 'AndreasBot/1.0 (+https://andreas.amsterdam)';

let genreMapCache: Map<number, string> | null = null;
const titleCache = new Map<string, string[]>();

/** Reset alle in-memory caches. Gebruikt door tests; productie roept
    'm niet aan — caches leven gewoon zolang het proces draait. */
export function resetTmdbCache(): void {
  genreMapCache = null;
  titleCache.clear();
}

/** Zoek genres voor een film-titel. Returnt lege array bij geen-key,
    geen-match, of netwerk-fout — caller kan 't veilig naar
    event.genres pushen. */
export async function fetchFilmGenres(title: string): Promise<string[]> {
  const key = process.env.TMDB_API_KEY;
  if (!key) return [];
  const cleanTitle = title.trim();
  if (!cleanTitle) return [];

  if (titleCache.has(cleanTitle)) return titleCache.get(cleanTitle)!;

  try {
    const genreMap = await loadGenreMap(key);
    if (genreMap.size === 0) return [];

    // /search/movie levert kandidaten gesorteerd op TMDb's eigen
    // populariteit/match-score. We pakken de eerste — voor mainstream
    // én arthouse-titels is dat bijna altijd de juiste film.
    const query = encodeURIComponent(stripParens(cleanTitle));
    const url = `${TMDB_BASE}/search/movie?api_key=${key}&query=${query}&language=nl-NL&include_adult=false`;
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) return [];
    const data = (await r.json()) as {
      results?: Array<{ id: number; genre_ids?: number[] }>;
    };
    const first = data.results?.[0];
    if (!first || !first.genre_ids?.length) {
      titleCache.set(cleanTitle, []);
      return [];
    }
    const labels = first.genre_ids
      .map((id) => genreMap.get(id))
      .filter((g): g is string => Boolean(g));
    titleCache.set(cleanTitle, labels);
    return labels;
  } catch {
    return [];
  }
}

async function loadGenreMap(apiKey: string): Promise<Map<number, string>> {
  if (genreMapCache) return genreMapCache;
  try {
    const url = `${TMDB_BASE}/genre/movie/list?api_key=${apiKey}&language=nl-NL`;
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) {
      genreMapCache = new Map();
      return genreMapCache;
    }
    const data = (await r.json()) as {
      genres?: Array<{ id: number; name: string }>;
    };
    genreMapCache = new Map((data.genres ?? []).map((g) => [g.id, g.name]));
    return genreMapCache;
  } catch {
    genreMapCache = new Map();
    return genreMapCache;
  }
}

/** Strip suffix-haakjes voor zuiverder TMDb-search. "Anora (ENG subs)"
    → "Anora", "Hour of the Wolf (1968, ENG subs)" → "Hour of the Wolf". */
function stripParens(s: string): string {
  return s
    .split(/\s*\|\s*/)[0]
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
