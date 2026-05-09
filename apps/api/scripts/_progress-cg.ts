import { and, eq, like, sql } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const evs = await db
  .select({ id: schema.events.id })
  .from(schema.events)
  .where(
    and(
      eq(schema.events.venueId, 'het-concertgebouw'),
      like(schema.events.id, 'evt-th-%')
    )
  );
const occ = (await db.execute(
  sql`SELECT count(*)::int as n FROM occurrences WHERE event_id LIKE 'evt-th-het-concertgebouw-%'`
)) as unknown as { rows: Array<{ n: number }> };
console.log(`events: ${evs.length}  occurrences: ${occ.rows?.[0]?.n}`);
process.exit(0);
