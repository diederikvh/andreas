import { eq, and, like } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const evs = await db
  .select({
    id: schema.events.id, title: schema.events.title,
    description: schema.events.description, imageUrl: schema.events.imageUrl,
    genres: schema.events.genres,
  })
  .from(schema.events)
  .where(and(eq(schema.events.venueId, 'de-brakke-grond'), like(schema.events.id, 'evt-bg-%')));

const wd = evs.filter((e) => e.description && e.description.length > 30).length;
const wm = evs.filter((e) => e.imageUrl?.startsWith('https://andreas-x')).length;
console.log(`brakkegrond: ${evs.length} events | desc=${wd}/${evs.length} | mirrored=${wm}/${evs.length}`);
for (const e of evs) {
  console.log(`  ${e.title.slice(0, 50).padEnd(50)} | desc[${e.description?.length ?? 0}] | genres=${(e.genres ?? []).join(',')}`);
}
process.exit(0);
