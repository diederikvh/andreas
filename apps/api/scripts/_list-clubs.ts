import { sql, eq } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

// Alle clubs uit DB met event-count
const venues = await db
  .select({
    id: schema.venues.id,
    name: schema.venues.name,
    type: schema.venues.type,
    capacity: schema.venues.capacity,
    scene: schema.venues.scene,
    website: schema.venues.website,
    published: schema.venues.published,
    scraperConfig: schema.venues.scraperConfig,
  })
  .from(schema.venues)
  .where(sql`${schema.venues.type} = 'club'`);

const eventCounts = await db
  .select({ venueId: schema.events.venueId, n: sql<number>`count(*)::int` })
  .from(schema.events)
  .groupBy(schema.events.venueId);
const counts = new Map<string, number>();
for (const r of eventCounts) counts.set(r.venueId, r.n);

console.log(`${venues.length} clubs in DB:\n`);
const order = ['xl', 'groot', 'middel', 'klein'];
venues.sort((a, b) => order.indexOf(a.capacity ?? 'klein') - order.indexOf(b.capacity ?? 'klein'));
for (const v of venues) {
  const n = counts.get(v.id) ?? 0;
  const cfg = v.scraperConfig ?? {};
  const cfgKeys = Object.keys(cfg);
  const status = n > 0 ? `✓ ${n}` : (cfgKeys.length > 0 ? `· cfg=${cfgKeys.join(',')}` : '⬜');
  const flag = v.published ? '' : ' [unpublished]';
  console.log(`  [${v.capacity ?? '-'}] [${v.scene ?? '-'}] ${v.name.padEnd(28)} | ${status.padEnd(20)} | ${v.website ?? '-'}${flag}`);
}
process.exit(0);
