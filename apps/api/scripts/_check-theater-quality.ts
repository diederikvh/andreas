import { eq, like, and, sql } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const venueIds = ['carre', 'meervaart', 'delamar'];
for (const vid of venueIds) {
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
    .where(and(eq(schema.events.venueId, vid), like(schema.events.id, 'evt-th-%')));
  const wd = evs.filter((e) => e.description && e.description.length > 30).length;
  const wi = evs.filter((e) => e.imageUrl).length;
  const wm = evs.filter((e) => e.imageUrl?.startsWith('https://andreas-x')).length;
  const occCount = await db.execute(sql`SELECT count(*)::int AS n FROM occurrences WHERE event_id IN (SELECT id FROM events WHERE venue_id=${vid} AND id LIKE 'evt-th-%')`);
  console.log(`${vid}:`);
  console.log(`  events=${evs.length} | desc=${wd}/${evs.length} | image=${wi}/${evs.length} | mirrored=${wm}/${evs.length}`);
  console.log(`  occurrences=${(occCount as any)[0]?.n ?? '-'}`);
  // Sample categories
  const cats: Record<string, number> = {};
  for (const e of evs) cats[e.category] = (cats[e.category] ?? 0) + 1;
  console.log(`  categories=${JSON.stringify(cats)}`);
  // Sample 2 events
  for (const e of evs.slice(0, 2)) {
    console.log(`  --- ${e.title}`);
    console.log(`     desc[${e.description?.length ?? 0}]: ${(e.description ?? '').slice(0, 80)}`);
    console.log(`     genres: ${(e.genres ?? []).join(',')}`);
  }
}
process.exit(0);
