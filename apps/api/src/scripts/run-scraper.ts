/**
 * CLI om een specifieke scraper lokaal te draaien (met productie DB
 * via DATABASE_URL in .env). Gebruikt door FOAM (playwright-based,
 * niet geschikt voor Fly) en als debugging-tool voor andere scrapers.
 *
 * Voorbeelden:
 *   pnpm scrape foam              # FOAM scraper draaien
 *   pnpm scrape nxtmuseum         # NXT scraper (ook lokaal triggerbaar)
 *   pnpm scrape rijksmuseum
 *
 * Om wekelijks te draaien — voeg toe aan launchd (macOS) of cron:
 *   0 9 * * 1 cd /Users/.../andreas && pnpm --filter @andreas/api scrape foam
 */

import { scrapers, type ScraperName } from '../scrapers/index.js';

async function main() {
  const name = process.argv[2] as ScraperName | undefined;
  if (!name) {
    console.error('Usage: pnpm scrape <scraper-name>');
    console.error('Available:', Object.keys(scrapers).sort().join(', '));
    process.exit(1);
  }
  const runner = scrapers[name];
  if (!runner) {
    console.error(`Unknown scraper: ${name}`);
    console.error('Available:', Object.keys(scrapers).sort().join(', '));
    process.exit(1);
  }
  const startedAt = Date.now();
  console.log(`[run-scraper] starting ${name}...`);
  try {
    const results = await runner();
    const totals = results.reduce(
      (acc, r) => ({
        fetched: acc.fetched + r.fetched,
        inserted: acc.inserted + r.inserted,
        occurrencesUpserted: acc.occurrencesUpserted + r.occurrencesUpserted,
        skipped: acc.skipped + r.skipped,
      }),
      { fetched: 0, inserted: 0, occurrencesUpserted: 0, skipped: 0 }
    );
    console.log(
      `[run-scraper] ${name} done in ${Date.now() - startedAt}ms:`,
      JSON.stringify(totals)
    );
    for (const r of results) {
      console.log(`  venue=${r.venueId}`, JSON.stringify(r));
    }
  } catch (e) {
    console.error(`[run-scraper] ${name} failed:`, (e as Error).message);
    console.error((e as Error).stack);
    process.exit(1);
  }
  process.exit(0);
}

main();
