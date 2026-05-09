import { eq, and, like, sql } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const evs = await db
  .select({
    id: schema.events.id,
    title: schema.events.title,
    description: schema.events.description,
    imageUrl: schema.events.imageUrl,
    genres: schema.events.genres,
  })
  .from(schema.events)
  .where(and(eq(schema.events.venueId, 'bimhuis'), like(schema.events.id, 'evt-bm-%')));

console.log(`bimhuis: ${evs.length} events`);
const wd = evs.filter((e) => e.description && e.description.length > 30).length;
const wm = evs.filter((e) => e.imageUrl?.startsWith('https://andreas-x')).length;
console.log(`  desc: ${wd}/${evs.length} | mirrored img: ${wm}/${evs.length}`);
console.log();
for (const e of evs) {
  const dlen = e.description?.length ?? 0;
  const img = e.imageUrl?.startsWith('https://andreas-x') ? '[mirror]' : (e.imageUrl ? '[remote]' : '[none]');
  console.log(`  ${e.title.slice(0, 60)}`);
  console.log(`    desc[${dlen}] | img=${img} | genres=${(e.genres ?? []).join(',')}`);
}

const dups = (await db.execute(
  sql`SELECT event_id, count(*)::int as n FROM occurrences WHERE event_id LIKE 'evt-bm-%' GROUP BY event_id HAVING count(*) > 1 ORDER BY n DESC`
)) as unknown as Array<{ event_id: string; n: number }>;
console.log(`\nevents met >1 occurrence:`);
for (const d of dups) console.log(`  ${d.event_id}: ${d.n}x`);
process.exit(0);
