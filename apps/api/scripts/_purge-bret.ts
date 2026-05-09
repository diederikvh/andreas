import { eq, like, and } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const evs = await db
  .select({ id: schema.events.id })
  .from(schema.events)
  .where(and(eq(schema.events.venueId, 'bret'), like(schema.events.id, 'evt-cel-%')));
let n = 0;
for (const e of evs) {
  await db.delete(schema.events).where(eq(schema.events.id, e.id));
  n++;
}
console.log(`purged ${n} BRET events`);
process.exit(0);
