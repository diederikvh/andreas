/**
 * Read-only test: hoeveel van onze ~400 Film+show events vindt OMDb,
 * en voor hoeveel daarvan levert 'ie een Poster-URL? Schrijft NIETS
 * naar de DB — puur dekkings-rapport zodat we een geïnformeerde
 * keuze kunnen maken tussen TMDb / OMDb / wat-we-al-hebben.
 *
 * Vereist: OMDB_API_KEY in .env. Free-tier limit: 1000 req/dag (we
 * doen er ~400, ruim binnen budget).
 *
 * Gebruik:
 *   OMDB_API_KEY=… pnpm tsx --env-file=.env src/scripts/inspect-omdb-coverage.ts
 */

import { and, eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { cleanTitleForOmdb } from '../scrapers/_omdb-enrich.js';

interface OmdbResponse {
  Title?: string;
  Year?: string;
  Plot?: string;
  Poster?: string;
  Genre?: string;
  Response?: string;
  Error?: string;
}

async function fetchOmdb(title: string, key: string): Promise<OmdbResponse | null> {
  try {
    const url = `https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${key}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    return (await r.json()) as OmdbResponse;
  } catch {
    return null;
  }
}

async function main() {
  const key = process.env.OMDB_API_KEY;
  if (!key) {
    console.error('OMDB_API_KEY ontbreekt');
    process.exit(1);
  }

  const films = await db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      imageUrl: schema.events.imageUrl,
    })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.category, 'Film'),
        eq(schema.events.kind, 'show')
      )
    );

  console.log(`Scanning ${films.length} Film+show events tegen OMDb...\n`);

  const stats = {
    total: films.length,
    hit: 0,
    miss: 0,
    hitWithPoster: 0,
    hitWithoutPoster: 0,
    hitButNAPoster: 0,
  };
  const hits: Array<{ title: string; clean: string; year?: string; poster?: string }> = [];
  const misses: Array<{ title: string; clean: string }> = [];

  let i = 0;
  for (const f of films) {
    i += 1;
    const clean = cleanTitleForOmdb(f.title);
    if (!clean) {
      stats.miss += 1;
      misses.push({ title: f.title, clean });
      continue;
    }
    const data = await fetchOmdb(clean, key);
    const isHit = data?.Response === 'True';
    if (!isHit) {
      stats.miss += 1;
      misses.push({ title: f.title, clean });
    } else {
      stats.hit += 1;
      const hasPoster =
        Boolean(data?.Poster) && data!.Poster !== 'N/A' && data!.Poster!.startsWith('http');
      if (hasPoster) {
        stats.hitWithPoster += 1;
        hits.push({
          title: f.title,
          clean,
          year: data?.Year,
          poster: data?.Poster,
        });
      } else if (data?.Poster === 'N/A') {
        stats.hitButNAPoster += 1;
      } else {
        stats.hitWithoutPoster += 1;
      }
    }
    if (i % 50 === 0) console.log(`  …${i}/${films.length}`);
    // 100ms throttle — beleefd tegen OMDb, en met 400 films nog steeds
    // ~40s totaal.
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log('\n=== Dekkings-rapport ===');
  console.log(`Totaal events:           ${stats.total}`);
  console.log(`Hits (titel-match):      ${stats.hit} (${pct(stats.hit, stats.total)})`);
  console.log(`  ↳ met poster-URL:      ${stats.hitWithPoster} (${pct(stats.hitWithPoster, stats.total)})`);
  console.log(`  ↳ met N/A-poster:      ${stats.hitButNAPoster}`);
  console.log(`  ↳ zonder poster-field: ${stats.hitWithoutPoster}`);
  console.log(`Misses:                  ${stats.miss} (${pct(stats.miss, stats.total)})`);

  console.log('\n=== Sample 10 hits met poster ===');
  for (const h of hits.slice(0, 10)) {
    console.log(`  "${h.title}" → OMDb "${h.clean}" (${h.year})`);
    console.log(`    ${h.poster}`);
  }

  console.log('\n=== Sample 10 misses (titels die OMDb niet kent) ===');
  for (const m of misses.slice(0, 10)) {
    const cleaned = m.clean !== m.title ? ` → "${m.clean}"` : '';
    console.log(`  "${m.title}"${cleaned}`);
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
