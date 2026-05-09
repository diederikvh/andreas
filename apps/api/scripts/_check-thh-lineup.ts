import { eq, sql, like, and } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const rows = await db
  .select({
    eId: schema.events.id, title: schema.events.title, imageUrl: schema.events.imageUrl,
    oId: schema.occurrences.id, lineup: schema.occurrences.lineup,
  })
  .from(schema.events)
  .leftJoin(schema.occurrences, eq(schema.occurrences.eventId, schema.events.id))
  .where(and(eq(schema.events.venueId, 'thuishaven'), like(schema.events.id, 'evt-thh-%')));

const wm = rows.filter((r) => r.imageUrl?.startsWith('https://andreas-x.b-cdn.net/')).length;
const wl = rows.filter((r) => Array.isArray(r.lineup) && r.lineup.length > 0).length;
console.log(`thuishaven: ${rows.length} | mirrored=${wm}/${rows.length} | with-lineup=${wl}/${rows.length}\n`);
for (const r of rows.slice(0, 6)) {
  const ln = Array.isArray(r.lineup) ? r.lineup : [];
  console.log(`  ${r.title.slice(0, 55).padEnd(55)}`);
  console.log(`    lineup (${ln.length}): ${ln.slice(0, 6).map((a: any) => `${a.name}${a.role ? ' [' + a.role + ']' : ''}`).join(', ')}`);
}
process.exit(0);
