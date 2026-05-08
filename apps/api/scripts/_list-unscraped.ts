import { sql, eq } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

/**
 * Lijst podium-venues die in de DB GEEN events hebben (= nog niet
 * gescraped of dedicated scraper bestaat niet). Met website-URL
 * voor probe.
 */
const venues = await db
  .select({
    id: schema.venues.id,
    name: schema.venues.name,
    type: schema.venues.type,
    capacity: schema.venues.capacity,
    website: schema.venues.website,
    scraperConfig: schema.venues.scraperConfig,
  })
  .from(schema.venues)
  .where(sql`${schema.venues.type} = 'podium' AND ${schema.venues.published} = true`);

const eventRows = await db
  .select({ venueId: schema.events.venueId, n: sql<number>`count(*)::int` })
  .from(schema.events)
  .groupBy(schema.events.venueId);
const eventCounts = new Map<string, number>();
for (const r of eventRows) eventCounts.set(r.venueId, r.n);

const noEvents = venues.filter((v) => (eventCounts.get(v.id) ?? 0) === 0);

console.log(`${noEvents.length} podium-venues met 0 events:\n`);
noEvents.sort((a, b) => {
  const order = ['xl', 'groot', 'middel', 'klein'];
  return order.indexOf(a.capacity ?? 'klein') - order.indexOf(b.capacity ?? 'klein');
});
for (const v of noEvents) {
  console.log(`  [${v.capacity ?? '-'}] ${v.name.padEnd(40)} | ${v.website ?? '(geen website)'}`);
}
process.exit(0);
