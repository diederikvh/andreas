import { eq, like, sql } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const r = await db
  .select({
    eId: schema.events.id, title: schema.events.title,
    oId: schema.occurrences.id, ticketUrl: schema.occurrences.ticketUrl,
  })
  .from(schema.events)
  .leftJoin(schema.occurrences, eq(schema.occurrences.eventId, schema.events.id))
  .where(like(schema.events.id, 'evt-cel-bret-%'));
for (const x of r.slice(0, 5)) {
  console.log(`  ${x.title.slice(0, 35).padEnd(35)} → ${x.ticketUrl?.slice(0, 100)}`);
}
process.exit(0);
