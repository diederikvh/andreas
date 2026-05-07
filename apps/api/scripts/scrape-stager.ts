/**
 * Run de Stager-scraper lokaal tegen de productie-Stager-API én onze
 * eigen DB. Bedoeld voor ad-hoc backfills, debug-runs, en handmatige
 * tests voordat we op cron switchen.
 *
 *   pnpm tsx --env-file=.env scripts/scrape-stager.ts
 *   pnpm tsx --env-file=.env scripts/scrape-stager.ts --venue radion
 *
 * --venue <id|slug>  draai alleen voor de gegeven venue (handig om
 *                    Mediamatic apart te debuggen zonder Cinetol te
 *                    raken).
 */

import { db, schema } from '../src/db/index.js';
import { scrapeStager } from '../src/scrapers/stager.js';

const args = process.argv.slice(2);
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
const results = await scrapeStager(venueIds ? { venueIds } : undefined);

console.log(`\nStager-scraper klaar in ${Date.now() - startedAt}ms\n`);
for (const r of results) {
  console.log(`${r.venueName} (shop ${r.shopId})`);
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
