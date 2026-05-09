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
  .where(and(eq(schema.events.venueId, 'ita'), like(schema.events.id, 'evt-ita-%')));

const wd = evs.filter((e) => e.description && e.description.length > 30).length;
const wm = evs.filter((e) => e.imageUrl?.startsWith('https://andreas-x')).length;
const cats: Record<string, number> = {};
for (const e of evs) cats[e.category] = (cats[e.category] ?? 0) + 1;

console.log(`ita: ${evs.length} events`);
console.log(`  desc: ${wd}/${evs.length} | mirrored img: ${wm}/${evs.length}`);
console.log(`  categories: ${JSON.stringify(cats)}`);
console.log();
for (const e of evs.slice(0, 6)) {
  console.log(`  ${e.title.slice(0, 60)}`);
  console.log(`    desc[${e.description?.length ?? 0}] | genres=${(e.genres ?? []).join(',')}`);
}

const occCounts = (await db.execute(
  sql`SELECT count(*)::int as n FROM occurrences WHERE event_id LIKE 'evt-ita-%'`
)) as unknown as Array<{ n: number }>;
const sample = (await db.execute(
  sql`SELECT event_id, count(*)::int as n FROM occurrences WHERE event_id LIKE 'evt-ita-%' GROUP BY event_id ORDER BY n DESC LIMIT 5`
)) as unknown as Array<{ event_id: string; n: number }>;
console.log(`\ntotal occurrences: ${occCounts[0]?.n ?? '-'}`);
console.log('top events met meeste occurrences:');
for (const r of sample) console.log(`  ${r.event_id}: ${r.n}`);
process.exit(0);
