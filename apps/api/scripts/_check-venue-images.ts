import { inArray } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const ids = ['johan-cruijff-arena', 'boom-chicago', 'rai-theater', 'paradiso', 'melkweg', 'ziggodome'];
const rows = await db
  .select({ id: schema.venues.id, name: schema.venues.name, imageUrl: schema.venues.imageUrl })
  .from(schema.venues)
  .where(inArray(schema.venues.id, ids));
for (const r of rows) console.log(`${r.id.padEnd(25)} | ${r.imageUrl}`);
process.exit(0);
