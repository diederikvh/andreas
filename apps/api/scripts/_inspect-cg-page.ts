/**
 * Pak één Concertgebouw-page met title-mismatch en log de eerste 5
 * Event JSON-LD blokken zodat we kunnen zien waar de echte show
 * zit vs welke we per ongeluk pakken.
 */

const UA = 'Andreas-Scraper/1.0';

const url = process.argv[2] ?? 'https://www.concertgebouw.nl/concerten/concertgebouworkest-kinderconcert-de-neus-6';
const r = await fetch(url, { headers: { 'user-agent': UA } });
const html = await r.text();

console.log(`URL: ${url}`);
console.log(`Status: ${r.status} | length: ${html.length}\n`);

const blocks: unknown[] = [];
for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]+?)<\/script>/g)) {
  try {
    const d = JSON.parse(m[1].trim());
    const items = Array.isArray(d) ? d : d?.['@graph'] ? d['@graph'] : [d];
    for (const it of items) {
      if (it && typeof it === 'object' && /Event/i.test(String((it as Record<string, unknown>)['@type']))) {
        blocks.push(it);
      }
    }
  } catch {}
}

console.log(`Event JSON-LD blocks: ${blocks.length}\n`);
for (let i = 0; i < blocks.length; i++) {
  const b = blocks[i] as Record<string, unknown>;
  console.log(`--- block ${i} ---`);
  console.log(`  @type: ${b['@type']}`);
  console.log(`  name: ${b['name']}`);
  console.log(`  startDate: ${b['startDate']}`);
  console.log(`  url: ${b['url'] ?? '(none)'}`);
}

process.exit(0);
