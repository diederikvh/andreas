import { eq } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

/** Verwijder alle TM-gescrapeerde events (id starts with 'evt-tm-'). */
const venueIds = [
  'afas-live',
  'johan-cruijff-arena',
  'boom-chicago',
  'rai-theater',
  'carre',
  'delamar',
  'meervaart',
  'theater-amsterdam',
];
let total = 0;
for (const vid of venueIds) {
  const events = await db
    .select({ id: schema.events.id })
    .from(schema.events)
    .where(eq(schema.events.venueId, vid));
  const tmEvents = events.filter((e) => e.id.startsWith('evt-tm-'));
  for (const e of tmEvents) {
    await db.delete(schema.events).where(eq(schema.events.id, e.id));
  }
  console.log(`  ${vid}: ${tmEvents.length} TM events deleted`);
  total += tmEvents.length;
}
console.log(`\n${total} TM events purged.`);
process.exit(0);
