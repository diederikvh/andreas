import { eq, sql, like, and, or, inArray } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const venueIds = ['carre', 'meervaart', 'delamar', 'theater-amsterdam', 'rai-theater', 'afas-live', 'johan-cruijff-arena', 'boom-chicago'];

for (const vid of venueIds) {
  const evs = await db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      source: sql<string>`split_part(${schema.events.id}, '-', 2)`,
    })
    .from(schema.events)
    .where(eq(schema.events.venueId, vid));

  // Group by normalized title
  const byTitle = new Map<string, typeof evs>();
  for (const e of evs) {
    const key = e.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 40);
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key)!.push(e);
  }
  const dups = Array.from(byTitle.values()).filter((g) => g.length > 1);
  console.log(`\n${vid}: ${evs.length} events, ${dups.length} duplicate-groepen`);
  for (const g of dups) {
    console.log(`  --- ${g[0].title}`);
    for (const e of g) console.log(`     ${e.id}`);
  }
}
process.exit(0);
