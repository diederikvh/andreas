import { db, schema } from '../src/db/index.js';
import { eq, like, and } from 'drizzle-orm';

const rows = await db
  .select({ id: schema.events.id, title: schema.events.title })
  .from(schema.events)
  .where(and(eq(schema.events.venueId, 'p60'), like(schema.events.title, '%RADAR%')));
console.log('events:', rows);

for (const ev of rows) {
  const occs = await db
    .select({ id: schema.occurrences.id, startsAt: schema.occurrences.startsAt })
    .from(schema.occurrences)
    .where(eq(schema.occurrences.eventId, ev.id));
  console.log(`  occurrences for ${ev.id}:`, occs);
}
process.exit(0);
