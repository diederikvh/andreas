import { eq, and, like, sql } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const evs = await db
  .select({
    id: schema.events.id, title: schema.events.title,
    description: schema.events.description, imageUrl: schema.events.imageUrl,
    genres: schema.events.genres, category: schema.events.category,
  })
  .from(schema.events)
  .where(and(eq(schema.events.venueId, 'ot301'), like(schema.events.id, 'evt-ot-%')));
const wd = evs.filter((e) => e.description && e.description.length > 30).length;
const wm = evs.filter((e) => e.imageUrl?.startsWith('https://andreas-x')).length;
const cats: Record<string, number> = {};
for (const e of evs) cats[e.category] = (cats[e.category] ?? 0) + 1;
console.log(`ot301: ${evs.length} events`);
console.log(`  desc: ${wd}/${evs.length} | mirrored: ${wm}/${evs.length}`);
console.log(`  cats: ${JSON.stringify(cats)}`);
console.log();
for (const e of evs.slice(0, 12)) {
  console.log(`  ${e.title.slice(0, 55).padEnd(55)} | desc[${e.description?.length ?? 0}] | genres=${(e.genres ?? []).join(',')}`);
}

const dups = (await db.execute(
  sql`SELECT event_id, count(*)::int as n FROM occurrences WHERE event_id LIKE 'evt-ot-%' GROUP BY event_id HAVING count(*) > 1 ORDER BY n DESC LIMIT 8`
)) as unknown as Array<{ event_id: string; n: number }>;
console.log(`\nmulti-occurrence events:`);
try {
  for (const d of dups) console.log(`  ${d.event_id}: ${d.n}`);
} catch { /* result-iteratie issue */ }
process.exit(0);
