import { eq, asc } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const venueId = process.argv[2] ?? 'boom-chicago';

const evs = await db
  .select({
    id: schema.events.id,
    title: schema.events.title,
    category: schema.events.category,
    genres: schema.events.genres,
    imageUrl: schema.events.imageUrl,
  })
  .from(schema.events)
  .where(eq(schema.events.venueId, venueId));
console.log(`\n${venueId}: ${evs.length} events`);
for (const e of evs) {
  const img = e.imageUrl ? (e.imageUrl.startsWith('https://andreas-x') ? '[mirrored]' : '[remote]') : '[none]';
  console.log(`  ${e.title}  | cat=${e.category} | genres=${(e.genres ?? []).join(',')} | img=${img}`);
}

const occs = await db
  .select({
    id: schema.occurrences.id,
    startsAt: schema.occurrences.startsAt,
    eventId: schema.occurrences.eventId,
  })
  .from(schema.occurrences)
  .innerJoin(schema.events, eq(schema.events.id, schema.occurrences.eventId))
  .where(eq(schema.events.venueId, venueId))
  .orderBy(asc(schema.occurrences.startsAt));
console.log(`\n${occs.length} occurrences (eerste 5):`);
for (const o of occs.slice(0, 5)) {
  console.log(`  ${o.startsAt.toISOString()} | ${o.eventId}`);
}
process.exit(0);
