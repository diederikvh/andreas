import { inArray } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const ids = [
  'afas-live',
  'carre',
  'de-lamar',
  'delamar',
  'theater-amsterdam',
  'de-meervaart',
  'meervaart',
  'johan-cruijff-arena',
  'boom-chicago',
  'rai-theater',
];

const rows = await db
  .select({ id: schema.venues.id, name: schema.venues.name, scraperConfig: schema.venues.scraperConfig })
  .from(schema.venues)
  .where(inArray(schema.venues.id, ids));

for (const r of rows) {
  console.log(`${r.id.padEnd(25)} | ${r.name.padEnd(28)} | tm=${JSON.stringify(r.scraperConfig?.ticketmaster ?? null)}`);
}
process.exit(0);
