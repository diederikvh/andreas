import { eq, like, and, sql } from 'drizzle-orm';

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
  .where(and(eq(schema.events.venueId, 'het-concertgebouw'), like(schema.events.id, 'evt-th-%')));

const wd = evs.filter((e) => e.description && e.description.length > 30).length;
const wm = evs.filter((e) => e.imageUrl?.startsWith('https://andreas-x')).length;
console.log(`het-concertgebouw: ${evs.length} events`);
console.log(`  description: ${wd}/${evs.length} (${Math.round((wd / evs.length) * 100)}%)`);
console.log(`  mirrored img: ${wm}/${evs.length}`);

const cats: Record<string, number> = {};
for (const e of evs) cats[e.category] = (cats[e.category] ?? 0) + 1;
console.log(`  categories: ${JSON.stringify(cats)}`);

console.log('\nSample 5 events:');
for (const e of evs.slice(0, 5)) {
  console.log(`  - ${e.title}`);
  console.log(`    cat=${e.category} | desc[${e.description?.length ?? 0}] | genres=${(e.genres ?? []).join(',')}`);
}

const occ = (await db.execute(
  sql`SELECT count(*)::int as n, min(starts_at) as first_at, max(starts_at) as last_at FROM occurrences WHERE event_id LIKE 'evt-th-het-concertgebouw-%'`
)) as unknown as Array<{ n: number; first_at: string; last_at: string }>;
console.log(`\noccurrences: ${occ[0]?.n} | first ${occ[0]?.first_at} | last ${occ[0]?.last_at}`);
process.exit(0);
