/** Voor/na-meting rond één scraper: events, occurrences, lege events
    en dubbele titel-clusters. */
import { eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../src/db/index.js';
import { scrapers, type ScraperName } from '../src/scrapers/index.js';
import { titleKey } from '../src/scrapers/_title-dedup.js';

const name = process.argv[2] as ScraperName;
const venueIds = process.argv[3]?.split(',') ?? [];

async function snap() {
  const evs = await db.select({ id: schema.events.id, title: schema.events.title, venueId: schema.events.venueId })
    .from(schema.events)
    .where(venueIds.length ? inArray(schema.events.venueId, venueIds) : sql`true`);
  const occ = evs.length
    ? await db.select({ id: schema.occurrences.id, eventId: schema.occurrences.eventId })
        .from(schema.occurrences).where(inArray(schema.occurrences.eventId, evs.map((e) => e.id)))
    : [];
  const withOcc = new Set(occ.map((o) => o.eventId));
  const clusters = new Map<string, number>();
  for (const e of evs) {
    if (!withOcc.has(e.id)) continue;               // lege events tellen niet mee
    const k = `${e.venueId}|${titleKey(e.title)}`;
    clusters.set(k, (clusters.get(k) ?? 0) + 1);
  }
  const dup = [...clusters.values()].filter((n) => n > 1);
  return {
    events: evs.length,
    occ: occ.length,
    leeg: evs.length - withOcc.size,
    dupClusters: dup.length,
    dupExtra: dup.reduce((a, n) => a + n - 1, 0),
  };
}

const before = await snap();
console.log('vóór :', JSON.stringify(before));
for (const r of await scrapers[name]()) console.log('   ', JSON.stringify(r));
const after = await snap();
console.log('ná   :', JSON.stringify(after));
process.exit(0);
