import { eq, like } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const r = await db
  .select({
    eId: schema.events.id, title: schema.events.title,
    ticketUrl: schema.occurrences.ticketUrl,
  })
  .from(schema.events)
  .leftJoin(schema.occurrences, eq(schema.occurrences.eventId, schema.events.id))
  .where(like(schema.events.id, 'evt-wz-%'));
for (const x of r.slice(0, 6)) {
  console.log(`  ${x.title.slice(0, 35).padEnd(35)} → ${x.ticketUrl?.slice(0, 110)}`);
}
process.exit(0);
