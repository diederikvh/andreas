/**
 * Lokale CLI-wrapper rond `enrichFilmsFromTmdb()`. Voor first-run
 * batch-enrichment en ad-hoc tests; in productie roept de daily cron
 * de admin-endpoint `/admin/api/enrich-films-tmdb` aan.
 *
 * Gebruik:
 *   pnpm tsx --env-file=.env src/scripts/enrich-films-tmdb.ts
 *   pnpm tsx --env-file=.env src/scripts/enrich-films-tmdb.ts --limit=20
 */

import { enrichFilmsFromTmdb } from '../scrapers/_tmdb-enrich.js';

const LIMIT_ARG = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.slice('--limit='.length), 10) : undefined;

async function main() {
  const start = Date.now();
  const result = await enrichFilmsFromTmdb(LIMIT);
  console.log('\n=== Rapport ===');
  console.log(`Gescand:           ${result.scanned}`);
  console.log(`Gezocht in TMDb:   ${result.searched}`);
  console.log(`TMDb-hits:         ${result.tmdbHit}`);
  console.log(`Posters gemirrord: ${result.posterMirrored}`);
  console.log(`Stills gemirrord:  ${result.stillMirrored}`);
  console.log(`Trailers gevonden: ${result.trailerFound}`);
  console.log(`Events geüpdate:   ${result.updated}`);
  console.log(`Duur:              ${((Date.now() - start) / 1000).toFixed(1)}s`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
