import { eq, inArray } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const ids = [
  'evt-par-paradiso-2871127',
  'evt-par-paradiso-2875048',
  'evt-par-paradiso-2875052',
  'evt-par-paradiso-2849197',
  'evt-par-paradiso-2849201',
];

const evs = await db
  .select()
  .from(schema.events)
  .where(inArray(schema.events.id, ids));

for (const e of evs) {
  const occs = await db
    .select()
    .from(schema.occurrences)
    .where(eq(schema.occurrences.eventId, e.id));
  console.log(`\n${e.id} — "${e.title}"`);
  console.log(`  description: ${e.description?.slice(0, 80) ?? '(none)'}`);
  for (const o of occs) {
    console.log(`  ${o.startsAt.toISOString()}  ${o.room ?? ''}  ticket=${o.ticketUrl ?? ''}`);
  }
}
process.exit(0);
