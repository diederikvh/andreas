/**
 * One-off enrichment script — vult ontbrekende description, image en
 * genres in voor alle Film-events via OMDb. Idempotent.
 *
 * Run: `pnpm tsx --env-file=.env src/scripts/enrich-films-from-omdb.ts`
 *
 * In productie wordt dezelfde logica nightly aangeroepen door de
 * scrape-cron via `/admin/api/enrich-films-omdb`.
 */

import { enrichFilmsFromOmdb } from '../scrapers/_omdb-enrich.js';

if (!process.env.OMDB_API_KEY) {
  console.error('OMDB_API_KEY ontbreekt in .env');
  process.exit(1);
}

const result = await enrichFilmsFromOmdb();
console.log(
  `done. scanned: ${result.scanned}, updated: ${result.updated}, not found: ${result.notFound}, already ok: ${result.alreadyOk}`
);
process.exit(0);
