/**
 * Voor één title-mismatch event: pak de bron-URL uit de occurrence,
 * fetch 'm met dezelfde UA als de scraper, en log alle Event JSON-LD
 * blokken. Doel: snappen waarom we de verkeerde title pakken.
 */
import { eq, like, sql } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const slug = process.argv[2] ?? 'concertgebouworkest-kinderconcert-de-neus-6';
const eventId = `evt-th-het-concertgebouw-${slug}`;

const ev = await db.select().from(schema.events).where(eq(schema.events.id, eventId)).limit(1);
console.log(`Event in DB:`);
console.log(`  id: ${ev[0]?.id}`);
console.log(`  title: ${ev[0]?.title}`);

const occs = await db.select().from(schema.occurrences).where(eq(schema.occurrences.eventId, eventId));
console.log(`  occurrences: ${occs.length}`);
const url = occs[0]?.ticketUrl;
console.log(`  ticketUrl: ${url}\n`);

if (!url) process.exit(0);

const r = await fetch(url, { headers: { 'user-agent': 'Andreas-Scraper/1.0' } });
console.log(`Live fetch: status ${r.status}, length ${(await r.clone().text()).length}`);
const html = await r.text();

let n = 0;
for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]+?)<\/script>/g)) {
  try {
    const d = JSON.parse(m[1].trim());
    const items = Array.isArray(d) ? d : d?.['@graph'] ? d['@graph'] : [d];
    for (const it of items) {
      const t = String((it as Record<string, unknown>)['@type'] ?? '');
      if (/Event/i.test(t)) {
        n++;
        if (n <= 5) {
          console.log(`\n[block ${n}]`);
          console.log(`  @type: ${t}`);
          console.log(`  name: ${(it as Record<string, unknown>).name}`);
          console.log(`  startDate: ${(it as Record<string, unknown>).startDate}`);
          console.log(`  url: ${(it as Record<string, unknown>).url ?? '(none)'}`);
        }
      }
    }
  } catch {}
}
console.log(`\nTotaal Event JSON-LD blocks: ${n}`);
process.exit(0);
