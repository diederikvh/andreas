/**
 * Verrijk Film+show events met poster + still + trailer van TMDb.
 *
 * Idempotent: pakt alleen events met ontbrekende velden. Bedoeld als
 * post-step na de film-scrapers (parallel met _omdb-enrich), of als
 * standalone batch-job (cron roept 'm via /admin/api/enrich-films-tmdb
 * aan, of `pnpm tsx src/scripts/enrich-films-tmdb.ts` lokaal).
 *
 * Patterns geïnspireerd op `_omdb-enrich.ts`:
 *   - cleanTitleForOmdb hergebruiken (werkt ook voor TMDb)
 *   - Year-disambiguatie via `?year=` param — voorkomt false positives
 *   - Mirror images naar Bunny (tmdb/posters/{id}.jpg, /stills/{id}.jpg)
 *   - Trailer-URL: official YouTube-trailer, NL/EN prefer, hoogste size
 *
 * Returnt een rapport zodat de admin-endpoint en het script dezelfde
 * output kunnen tonen.
 */

import { and, eq, isNull, or } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { cleanTitleForOmdb } from './_omdb-enrich.js';

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p';
const UA = 'AndreasBot/1.0 (+https://andreas.amsterdam)';

export interface TmdbEnrichResult {
  scanned: number;
  searched: number;
  tmdbHit: number;
  posterMirrored: number;
  stillMirrored: number;
  trailerFound: number;
  updated: number;
}

interface TmdbSearchResult {
  id: number;
  title: string;
  original_title: string;
  release_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  popularity?: number;
}

interface TmdbVideo {
  key: string;
  site: 'YouTube' | 'Vimeo' | string;
  type: 'Trailer' | 'Teaser' | 'Clip' | 'Featurette' | string;
  official: boolean;
  size: number;
  iso_639_1: string;
  name: string;
}

function extractYearFromTitle(title: string): number | null {
  const m = title.match(/\((19|20)\d{2}\)/);
  if (!m) return null;
  return parseInt(m[0].replace(/[()]/g, ''), 10);
}

async function tmdbFetch<T>(
  path: string,
  params: Record<string, string>,
  key: string
): Promise<T | null> {
  try {
    const p = new URLSearchParams({ api_key: key, ...params });
    const r = await fetch(`${TMDB_BASE}${path}?${p}`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

async function searchTmdb(
  title: string,
  year: number | null,
  key: string
): Promise<TmdbSearchResult | null> {
  const params: Record<string, string> = {
    query: title,
    include_adult: 'false',
    language: 'en-US',
  };
  if (year !== null) params.year = String(year);
  const data = await tmdbFetch<{ results: TmdbSearchResult[] }>(
    '/search/movie',
    params,
    key
  );
  if (!data || data.results.length === 0) return null;
  const needle = title.toLowerCase().trim();
  const exact = data.results.filter(
    (r) =>
      r.title?.toLowerCase().trim() === needle ||
      r.original_title?.toLowerCase().trim() === needle
  );
  const pool = exact.length > 0 ? exact : data.results;
  return pool.sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))[0];
}

async function fetchTrailerUrl(
  tmdbId: number,
  key: string
): Promise<string | null> {
  const data = await tmdbFetch<{ results: TmdbVideo[] }>(
    `/movie/${tmdbId}/videos`,
    {},
    key
  );
  if (!data || data.results.length === 0) return null;
  const youtube = data.results.filter(
    (v) => v.site === 'YouTube' && v.type === 'Trailer'
  );
  if (youtube.length === 0) return null;
  youtube.sort((a, b) => {
    if (a.official !== b.official) return a.official ? -1 : 1;
    const aLang = a.iso_639_1 === 'nl' ? 0 : a.iso_639_1 === 'en' ? 1 : 2;
    const bLang = b.iso_639_1 === 'nl' ? 0 : b.iso_639_1 === 'en' ? 1 : 2;
    if (aLang !== bLang) return aLang - bLang;
    return (b.size ?? 0) - (a.size ?? 0);
  });
  return `https://www.youtube.com/watch?v=${youtube[0].key}`;
}

async function mirrorImageToBunny(
  url: string,
  bunnyPath: string
): Promise<string | null> {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    return await uploadToBunny(
      bunnyPath,
      buf,
      r.headers.get('content-type') ?? 'image/jpeg'
    );
  } catch {
    return null;
  }
}

/**
 * Hoofdfunctie. Pakt alle Film+show events waar tenminste één van
 * poster/still/trailer ontbreekt, doet TMDb-lookup, mirrort images
 * naar Bunny, en update events.
 *
 * Optionele `limit` voor lokale dry-tests; in productie wordt 'm
 * zonder limit aangeroepen (totale duur ~5-10 min voor 400 events).
 */
export async function enrichFilmsFromTmdb(
  limit?: number
): Promise<TmdbEnrichResult> {
  const key = process.env.TMDB_API_KEY;
  if (!key) {
    throw new Error('TMDB_API_KEY ontbreekt in env');
  }

  const where = and(
    eq(schema.events.category, 'Film'),
    eq(schema.events.kind, 'show'),
    or(
      isNull(schema.events.posterUrl),
      isNull(schema.events.stillUrl),
      isNull(schema.events.trailerUrl)
    )
  );
  const baseQuery = db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      posterUrl: schema.events.posterUrl,
      stillUrl: schema.events.stillUrl,
      trailerUrl: schema.events.trailerUrl,
    })
    .from(schema.events)
    .where(where);
  const films = limit ? await baseQuery.limit(limit) : await baseQuery;

  const result: TmdbEnrichResult = {
    scanned: films.length,
    searched: 0,
    tmdbHit: 0,
    posterMirrored: 0,
    stillMirrored: 0,
    trailerFound: 0,
    updated: 0,
  };

  for (const f of films) {
    const needsPoster = !f.posterUrl;
    const needsStill = !f.stillUrl;
    const needsTrailer = !f.trailerUrl;
    if (!needsPoster && !needsStill && !needsTrailer) continue;

    const year = extractYearFromTitle(f.title);
    const clean = cleanTitleForOmdb(f.title);
    if (!clean) continue;
    result.searched += 1;

    const best = await searchTmdb(clean, year, key);
    if (!best) continue;
    result.tmdbHit += 1;

    const patch: Record<string, string> = {};

    if (needsPoster && best.poster_path) {
      const sourceUrl = `${TMDB_IMG}/original${best.poster_path}`;
      const bunnyUrl = await mirrorImageToBunny(
        sourceUrl,
        `tmdb/posters/${best.id}.jpg`
      );
      if (bunnyUrl) {
        patch.posterUrl = bunnyUrl;
        result.posterMirrored += 1;
      }
    }

    if (needsStill && best.backdrop_path) {
      const sourceUrl = `${TMDB_IMG}/original${best.backdrop_path}`;
      const bunnyUrl = await mirrorImageToBunny(
        sourceUrl,
        `tmdb/stills/${best.id}.jpg`
      );
      if (bunnyUrl) {
        patch.stillUrl = bunnyUrl;
        result.stillMirrored += 1;
      }
    }

    if (needsTrailer) {
      const trailer = await fetchTrailerUrl(best.id, key);
      if (trailer) {
        patch.trailerUrl = trailer;
        result.trailerFound += 1;
      }
    }

    if (Object.keys(patch).length === 0) continue;
    await db.update(schema.events).set(patch).where(eq(schema.events.id, f.id));
    result.updated += 1;

    // 100ms throttle — netjes binnen TMDb's 50rps en geeft Bunny tijd
    // voor sequentiële PUTs.
    await new Promise((r) => setTimeout(r, 100));
  }

  return result;
}
