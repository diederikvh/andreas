/**
 * Read-only test: zelfde scope als OMDb-coverage (alle Film+show
 * events), maar tegen TMDb's search-API met year-disambiguatie.
 * Schrijft NIETS naar de DB.
 *
 * Verschil met OMDb:
 *   - Year-param voorkomt false positives (Zion 2018 vs 2025)
 *   - Poster-URLs zijn TMDb-CDN (stabieler dan Amazon)
 *   - Multiple resoluties beschikbaar (w92 t/m original 2000+)
 *   - Rate-limit ruim (50 rps; we doen er ~10 per seconde)
 *
 * Vereist: TMDB_API_KEY in .env.
 */

import { and, eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { cleanTitleForOmdb } from '../scrapers/_omdb-enrich.js';

interface TmdbSearchResult {
  id: number;
  title: string;
  original_title: string;
  release_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  popularity?: number;
}

interface TmdbSearchResponse {
  results: TmdbSearchResult[];
  total_results: number;
}

/** Extract jaar uit titel zoals "Anora (2024)" of "Suspiria (1977)". */
function extractYearFromTitle(title: string): number | null {
  const m = title.match(/\((19|20)\d{2}\)/);
  if (!m) return null;
  const year = parseInt(m[0].replace(/[()]/g, ''), 10);
  return Number.isFinite(year) ? year : null;
}

async function searchTmdb(
  title: string,
  year: number | null,
  key: string
): Promise<TmdbSearchResponse | null> {
  try {
    const params = new URLSearchParams({
      api_key: key,
      query: title,
      include_adult: 'false',
      language: 'en-US',
    });
    if (year !== null) params.set('year', String(year));
    const r = await fetch(
      `https://api.themoviedb.org/3/search/movie?${params}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!r.ok) return null;
    return (await r.json()) as TmdbSearchResponse;
  } catch {
    return null;
  }
}

/** Kies het beste resultaat: exact-title-match (case-insensitive) op
 *  title OF original_title; bij meerdere kandidaten neem de hoogste
 *  popularity. Year-filter wordt door TMDb al via de param afgehandeld. */
function pickBestMatch(
  results: TmdbSearchResult[],
  cleanTitle: string
): TmdbSearchResult | null {
  if (results.length === 0) return null;
  const needle = cleanTitle.toLowerCase().trim();
  const exact = results.filter(
    (r) =>
      r.title?.toLowerCase().trim() === needle ||
      r.original_title?.toLowerCase().trim() === needle
  );
  const pool = exact.length > 0 ? exact : results;
  return pool.sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))[0];
}

async function main() {
  const key = process.env.TMDB_API_KEY;
  if (!key) {
    console.error('TMDB_API_KEY ontbreekt');
    process.exit(1);
  }

  const films = await db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      imageUrl: schema.events.imageUrl,
      venueId: schema.events.venueId,
    })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.category, 'Film'),
        eq(schema.events.kind, 'show')
      )
    );

  console.log(`Scanning ${films.length} Film+show events tegen TMDb...\n`);

  const stats = {
    total: films.length,
    hit: 0,
    miss: 0,
    hitWithPoster: 0,
    hitWithoutPoster: 0,
    hitWithBackdrop: 0,
    yearHelped: 0, // hits where year-param was used
  };
  const hits: Array<{
    title: string;
    clean: string;
    matched: string;
    year?: string;
    poster?: string;
  }> = [];
  const misses: Array<{
    title: string;
    clean: string;
    year: number | null;
    venueId: string;
    reason: 'no-match' | 'no-poster';
  }> = [];

  let i = 0;
  for (const f of films) {
    i += 1;
    const year = extractYearFromTitle(f.title);
    const clean = cleanTitleForOmdb(f.title);
    if (!clean) {
      stats.miss += 1;
      misses.push({ title: f.title, clean, year, venueId: f.venueId, reason: 'no-match' });
      continue;
    }
    const data = await searchTmdb(clean, year, key);
    const best = data ? pickBestMatch(data.results, clean) : null;

    if (!best) {
      stats.miss += 1;
      misses.push({ title: f.title, clean, year, venueId: f.venueId, reason: 'no-match' });
    } else {
      stats.hit += 1;
      if (year !== null) stats.yearHelped += 1;
      if (best.poster_path) {
        stats.hitWithPoster += 1;
        hits.push({
          title: f.title,
          clean,
          matched: best.title,
          year: best.release_date?.slice(0, 4),
          poster: `https://image.tmdb.org/t/p/w500${best.poster_path}`,
        });
      } else {
        stats.hitWithoutPoster += 1;
        misses.push({ title: f.title, clean, year, venueId: f.venueId, reason: 'no-poster' });
      }
      if (best.backdrop_path) stats.hitWithBackdrop += 1;
    }
    if (i % 50 === 0) console.log(`  …${i}/${films.length}`);
    // 100ms throttle — ver onder TMDb's 50 rps limit, maar beleefd.
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log('\n=== TMDb dekkings-rapport ===');
  console.log(`Totaal events:           ${stats.total}`);
  console.log(`Hits (titel-match):      ${stats.hit} (${pct(stats.hit, stats.total)})`);
  console.log(`  ↳ met poster:          ${stats.hitWithPoster} (${pct(stats.hitWithPoster, stats.total)})`);
  console.log(`  ↳ ook met backdrop:    ${stats.hitWithBackdrop} (${pct(stats.hitWithBackdrop, stats.total)})`);
  console.log(`  ↳ geen poster:         ${stats.hitWithoutPoster}`);
  console.log(`Misses:                  ${stats.miss} (${pct(stats.miss, stats.total)})`);
  console.log(`Year-param gebruikt:     ${stats.yearHelped}/${stats.hit}`);

  console.log('\n=== Sample 10 hits met poster ===');
  for (const h of hits.slice(0, 10)) {
    console.log(`  "${h.title}" → TMDb "${h.matched}" (${h.year})`);
    console.log(`    ${h.poster}`);
  }

  // Volledige misses-lijst, gegroepeerd per venue. Per venue gesorteerd
  // op title zodat de output stabiel is en je makkelijk patronen ziet
  // ("die ene venue is verantwoordelijk voor 30 misses").
  console.log('\n=== Volledige misses-lijst ===');
  const byVenue = new Map<string, typeof misses>();
  for (const m of misses) {
    const list = byVenue.get(m.venueId) ?? [];
    list.push(m);
    byVenue.set(m.venueId, list);
  }
  const venuesSorted = [...byVenue.entries()].sort(
    (a, b) => b[1].length - a[1].length
  );
  for (const [venueId, list] of venuesSorted) {
    console.log(`\n[${venueId}] — ${list.length} misses`);
    for (const m of list.sort((a, b) => a.title.localeCompare(b.title))) {
      const cleaned = m.clean !== m.title ? ` → "${m.clean}"` : '';
      const yr = m.year ? ` [year=${m.year}]` : '';
      const tag = m.reason === 'no-poster' ? ' (geen poster)' : '';
      console.log(`  "${m.title}"${cleaned}${yr}${tag}`);
    }
  }

  process.exit(0);
}

function pct(part: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.round((part / total) * 1000) / 10}%`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
