import { eq } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const evs = await db
  .select({ id: schema.events.id, title: schema.events.title, startsAt: schema.events.id })
  .from(schema.events)
  .where(eq(schema.events.venueId, 'paradiso'));

const byTitle = new Map<string, { id: string; title: string }[]>();
for (const e of evs) {
  const k = e.title.trim().toLowerCase();
  const arr = byTitle.get(k) ?? [];
  arr.push({ id: e.id, title: e.title });
  byTitle.set(k, arr);
}

const dupes = [...byTitle.values()].filter((a) => a.length > 1);
console.log(`Paradiso title-dupes: ${dupes.length} clusters\n`);
for (const arr of dupes) {
  console.log(`"${arr[0].title}":`);
  for (const e of arr) console.log(`  ${e.id}`);
  console.log();
}
process.exit(0);
