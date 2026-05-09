import { eq, like } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

// Purge alle PM events zodat de nieuwe scraper ze opnieuw met
// description + image kan inzetten.
const evs = await db
  .select({ id: schema.events.id })
  .from(schema.events)
  .where(like(schema.events.id, 'evt-pm-%'));
let n = 0;
for (const e of evs) {
  await db.delete(schema.events).where(eq(schema.events.id, e.id));
  n++;
}
console.log(`purged ${n} PM events`);
process.exit(0);
