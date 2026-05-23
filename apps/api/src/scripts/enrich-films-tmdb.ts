/**
 * Verrijk Film+show events met poster + still + trailer van TMDb.
 *
 * Vult drie nieuwe velden:
 *   - posterUrl  ← TMDb poster_path, gemirrored naar Bunny
 *   - stillUrl   ← TMDb backdrop_path, gemirrored naar Bunny
 *   - trailerUrl ← Full YouTube-URL van de official trailer (NL/EN
 *                  prefer, anders eerst-gevonden official)
 *
 * Idempotent: skipt events die al alle 3 velden hebben. Pakt anders
 * alleen ontbrekende velden, behoudt bestaande Bunny-URLs (geen
 * onnodige re-uploads).
 *
 * Bunny path-conventie:
 *   tmdb/posters/{tmdb_id}.jpg
 *   tmdb/stills/{tmdb_id}.jpg
 *
 * Gebruik:
 *   pnpm tsx --env-file=.env src/scripts/enrich-films-tmdb.ts
 *   pnpm tsx --env-file=.env src/scripts/enrich-films-tmdb.ts --dry-run
 *   pnpm tsx --env-file=.env src/scripts/enrich-films-tmdb.ts --limit=20
 */

import { and, eq, isNull, or, sql } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { cleanTitleForOmdb } from '../scrapers/_omdb-enrich.js';
import { uploadToBunny } from '../storage/bunny.js';

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p';
const UA = 'AndreasBot/1.0 (+https://andreas.amsterdam)';

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT_ARG = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.slice('--limit='.length), 10) : null;

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
  // Filter naar YouTube + Trailer + official. Daarna NL/EN prefer.
  const youtube = data.results.filter(
    (v) => v.site === 'YouTube' && v.type === 'Trailer'
  );
  if (youtube.length === 0) return null;
  // Sorteer: official first, dan NL/EN-talige, dan grootste size.
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
    return await uploadToBunny(bunnyPath, buf, r.headers.get('content-type') ?? 'image/jpeg');
  } catch {
    return null;
  }
}

interface FilmRow {
  id: string;
  title: string;
  posterUrl: string | null;
  stillUrl: string | null;
  trailerUrl: string | null;
}

interface RunStats {
  scanned: number;
  alreadyComplete: number;
  searched: number;
  tmdbHit: number;
  posterMirrored: number;
  stillMirrored: number;
  trailerFound: number;
  updated: number;
}

async function main() {
  const key = process.env.TMDB_API_KEY;
  if (!key) {
    console.error('TMDB_API_KEY ontbreekt');
    process.exit(1);
  }

  // Pak Film+show events waar tenminste één van de 3 velden leeg is.
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
  const films: FilmRow[] = LIMIT
    ? await baseQuery.limit(LIMIT)
    : await baseQuery;

  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN' : 'COMMIT'}`);
  console.log(`Te bewerken: ${films.length} Film-events\n`);

  const stats: RunStats = {
    scanned: films.length,
    alreadyComplete: 0,
    searched: 0,
    tmdbHit: 0,
    posterMirrored: 0,
    stillMirrored: 0,
    trailerFound: 0,
    updated: 0,
  };

  let i = 0;
  for (const f of films) {
    i += 1;
    const needsPoster = !f.posterUrl;
    const needsStill = !f.stillUrl;
    const needsTrailer = !f.trailerUrl;
    if (!needsPoster && !needsStill && !needsTrailer) {
      stats.alreadyComplete += 1;
      continue;
    }

    const year = extractYearFromTitle(f.title);
    const clean = cleanTitleForOmdb(f.title);
    if (!clean) continue;
    stats.searched += 1;

    const best = await searchTmdb(clean, year, key);
    if (!best) {
      // Geen TMDb-match — niets te doen, wachten op de volgende run
      // wanneer TMDb mogelijk wel een record heeft.
      continue;
    }
    stats.tmdbHit += 1;

    const patch: Record<string, string> = {};

    if (needsPoster && best.poster_path) {
      const sourceUrl = `${TMDB_IMG}/original${best.poster_path}`;
      if (DRY_RUN) {
        patch.posterUrl = sourceUrl;
      } else {
        const bunnyUrl = await mirrorImageToBunny(
          sourceUrl,
          `tmdb/posters/${best.id}.jpg`
        );
        if (bunnyUrl) {
          patch.posterUrl = bunnyUrl;
          stats.posterMirrored += 1;
        }
      }
    }

    if (needsStill && best.backdrop_path) {
      const sourceUrl = `${TMDB_IMG}/original${best.backdrop_path}`;
      if (DRY_RUN) {
        patch.stillUrl = sourceUrl;
      } else {
        const bunnyUrl = await mirrorImageToBunny(
          sourceUrl,
          `tmdb/stills/${best.id}.jpg`
        );
        if (bunnyUrl) {
          patch.stillUrl = bunnyUrl;
          stats.stillMirrored += 1;
        }
      }
    }

    if (needsTrailer) {
      const trailer = await fetchTrailerUrl(best.id, key);
      if (trailer) {
        patch.trailerUrl = trailer;
        stats.trailerFound += 1;
      }
    }

    if (Object.keys(patch).length === 0) continue;

    if (!DRY_RUN) {
      await db.update(schema.events).set(patch).where(eq(schema.events.id, f.id));
    }
    stats.updated += 1;

    if (i % 25 === 0) {
      console.log(
        `  …${i}/${films.length}  hits=${stats.tmdbHit} posters=${stats.posterMirrored} stills=${stats.stillMirrored} trailers=${stats.trailerFound}`
      );
    }
    // 100ms throttle — netjes binnen TMDb's 50rps en geeft Bunny
    // de tijd voor sequentiële PUTs.
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log('\n=== Rapport ===');
  console.log(`Gescand:           ${stats.scanned}`);
  console.log(`Al compleet:       ${stats.alreadyComplete}`);
  console.log(`Gezocht in TMDb:   ${stats.searched}`);
  console.log(`TMDb-hits:         ${stats.tmdbHit}`);
  console.log(`Posters gemirrord: ${stats.posterMirrored}`);
  console.log(`Stills gemirrord:  ${stats.stillMirrored}`);
  console.log(`Trailers gevonden: ${stats.trailerFound}`);
  console.log(`Events geüpdate:   ${stats.updated}`);
  console.log(DRY_RUN ? '\nDRY-RUN — niks in de DB geschreven.' : '\nDone.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
