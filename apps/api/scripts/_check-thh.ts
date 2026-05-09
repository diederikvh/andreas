import { eq, and, like } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const evs = await db
  .select({
    id: schema.events.id, title: schema.events.title,
    description: schema.events.description, imageUrl: schema.events.imageUrl,
    genres: schema.events.genres,
  })
  .from(schema.events)
  .where(and(eq(schema.events.venueId, 'thuishaven'), like(schema.events.id, 'evt-thh-%')));
const wd = evs.filter((e) => e.description && e.description.length > 30).length;
const wm = evs.filter((e) => e.imageUrl?.startsWith('https://andreas-x.b-cdn.net/')).length;
console.log(`thuishaven: ${evs.length} events | desc=${wd}/${evs.length} | mirrored=${wm}/${evs.length}`);
for (const e of evs.slice(0, 12)) {
  console.log(`  ${e.title.slice(0, 55).padEnd(55)} | desc[${e.description?.length ?? 0}] | genres=${(e.genres ?? []).join(',')}`);
}
process.exit(0);
