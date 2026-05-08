import { eq, isNull, like, or, and, sql } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

/**
 * Verwijder TM-events waar description leeg of erg kort is, zodat de
 * scraper ze opnieuw probeert (met de Wikipedia-search fallback).
 */
const rows = await db
  .select({ id: schema.events.id })
  .from(schema.events)
  .where(
    and(
      like(schema.events.id, 'evt-tm-%'),
      or(isNull(schema.events.description), sql`length(${schema.events.description}) < 30`)
    )
  );

let deleted = 0;
for (const r of rows) {
  await db.delete(schema.events).where(eq(schema.events.id, r.id));
  deleted++;
}
console.log(`${deleted} TM events without description deleted.`);
process.exit(0);
