/**
 * Lokale CLI-wrapper rond `enrichLineupArtists()`. Voor first-run
 * batch-enrichment en ad-hoc tests; in productie roept de daily cron
 * de admin-endpoint `/admin/api/enrich-artists` aan.
 *
 * Gebruik:
 *   pnpm tsx --env-file=.env src/scripts/enrich-artists.ts
 *   pnpm tsx --env-file=.env src/scripts/enrich-artists.ts --limit=20
 */

import { enrichLineupArtists } from '../scrapers/_artists-enrich.js';

const LIMIT_ARG = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.slice('--limit='.length), 10) : undefined;

async function main() {
  const start = Date.now();
  const result = await enrichLineupArtists(LIMIT);
  console.log('\n=== Rapport ===');
  console.log(`Unieke namen in lineups:    ${result.uniqueNames}`);
  console.log(`Al recent enriched:         ${result.alreadyEnriched}`);
  console.log(`Gezocht in MB:              ${result.searched}`);
  console.log(`MB-hit (artist gevonden):   ${result.mbHit}`);
  console.log(`Artists ingevoegd:          ${result.artistsInserted}`);
  console.log(`Artists bijgewerkt:         ${result.artistsUpdated}`);
  console.log(`Lineup-items gelinkt:       ${result.lineupItemsLinked}`);
  console.log(`Occurrences geüpdate:       ${result.occurrencesUpdated}`);
  if (result.fatalEarlyStop) {
    console.log(`\n⚠ Vroegtijdig gestopt door 503 — wacht en run opnieuw.`);
  }
  console.log(`Duur:                       ${((Date.now() - start) / 1000).toFixed(1)}s`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
