import { eq, like, and } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

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
let withDesc = 0;
for (const vid of venueIds) {
  const evs = await db
    .select({ id: schema.events.id, title: schema.events.title, description: schema.events.description })
    .from(schema.events)
    .where(and(eq(schema.events.venueId, vid), like(schema.events.id, 'evt-tm-%')));
  const wd = evs.filter((e) => e.description && e.description.length > 30);
  total += evs.length;
  withDesc += wd.length;
  console.log(`\n${vid}: ${wd.length}/${evs.length} met description`);
  for (const e of evs) {
    const len = e.description?.length ?? 0;
    const preview = (e.description ?? '').slice(0, 80).replace(/\s+/g, ' ');
    const flag = len > 30 ? '✓' : '·';
    console.log(`  ${flag} [${len}] ${e.title}: ${preview}${len > 80 ? '...' : ''}`);
  }
}
console.log(`\nTotaal: ${withDesc}/${total} met description (${Math.round(withDesc / total * 100)}%)`);
process.exit(0);
