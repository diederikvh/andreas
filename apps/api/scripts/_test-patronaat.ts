import { scrapePatronaat } from '../src/scrapers/patronaat.js';

async function main() {
  const r = await scrapePatronaat();
  console.log(JSON.stringify(r, null, 2));
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
