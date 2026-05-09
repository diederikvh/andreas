import { eq, like } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const evs = await db
  .select({ id: schema.events.id })
  .from(schema.events)
  .where(like(schema.events.id, 'evt-ot-%'));
let n = 0;
for (const e of evs) {
  await db.delete(schema.events).where(eq(schema.events.id, e.id));
  n++;
}
console.log(`purged ${n} OT301 events`);
process.exit(0);
