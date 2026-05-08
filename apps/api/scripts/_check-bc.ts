import { eq, and, like, sql } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const evs = await db
  .select({
    id: schema.events.id,
    title: schema.events.title,
    description: schema.events.description,
    imageUrl: schema.events.imageUrl,
    genres: schema.events.genres,
    category: schema.events.category,
  })
  .from(schema.events)
  .where(and(eq(schema.events.venueId, 'boom-chicago'), like(schema.events.id, 'evt-bc-%')));

console.log(`${evs.length} BC events:`);
for (const e of evs) {
  const dlen = e.description?.length ?? 0;
  const img = e.imageUrl?.startsWith('https://andreas-x') ? '[mirrored]' : (e.imageUrl ? '[remote]' : '[none]');
  console.log(`  ${e.title}`);
  console.log(`    cat=${e.category} | desc[${dlen}] | img=${img} | genres=${(e.genres ?? []).join(',')}`);
}

const cnt = await db.execute(
  sql`SELECT count(*)::int AS n FROM occurrences WHERE event_id LIKE 'evt-bc-%'`
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
console.log(`\nTotaal BC occurrences: ${(cnt as any)[0]?.n ?? '-'}`);
process.exit(0);
