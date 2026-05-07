/**
 * Run een specifieke scraper lokaal (tegen productie-DB via .env).
 *
 *   pnpm tsx --env-file=.env scripts/scrape.ts <name> [--venue <slug>]
 *
 *   pnpm tsx --env-file=.env scripts/scrape.ts stager
 *   pnpm tsx --env-file=.env scripts/scrape.ts ical --venue ruigoord
 *
 * Beschikbare namen komen uit `apps/api/src/scrapers/index.ts`.
 */

import { db, schema } from '../src/db/index.js';
import { scrapers, type ScraperName } from '../src/scrapers/index.js';

const args = process.argv.slice(2);
const name = args[0] as ScraperName;
const runner = scrapers[name];
if (!runner) {
  console.error(
    `✗ scraper '${name}' niet gevonden. Beschikbaar: ${Object.keys(scrapers).join(', ')}`
  );
  process.exit(1);
}

const venueFlag = args.indexOf('--venue');
const venueArg = venueFlag !== -1 ? args[venueFlag + 1] : undefined;

let venueIds: string[] | undefined;
if (venueArg) {
  const all = await db.select().from(schema.venues);
  const match = all.find((v) => v.id === venueArg || v.slug === venueArg);
  if (!match) {
    console.error(`✗ venue not found: ${venueArg}`);
    process.exit(1);
  }
  venueIds = [match.id];
}

const startedAt = Date.now();
const results = await runner(venueIds ? { venueIds } : undefined);

console.log(`\n${name}-scraper klaar in ${Date.now() - startedAt}ms\n`);
for (const r of results) {
  const url = 'url' in r ? r.url : `shop ${(r as { shopId: number }).shopId}`;
  console.log(`${r.venueName} (${url})`);
  console.log(
    `  fetched=${r.fetched}  inserted=${r.inserted}  occUpserted=${r.occurrencesUpserted}  skipped=${r.skipped}`
  );
  for (const err of r.errors) console.log(`  ! ${err}`);
}

const totals = results.reduce(
  (a, r) => ({
    fetched: a.fetched + r.fetched,
    inserted: a.inserted + r.inserted,
    occUpserted: a.occUpserted + r.occurrencesUpserted,
    skipped: a.skipped + r.skipped,
  }),
  { fetched: 0, inserted: 0, occUpserted: 0, skipped: 0 }
);
console.log(
  `\nTotaal: ${totals.fetched} events gehaald, ${totals.inserted} nieuw, ${totals.occUpserted} occurrences ge-upsert, ${totals.skipped} geskipt`
);
process.exit(0);
