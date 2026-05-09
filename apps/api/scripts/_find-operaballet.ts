import { ilike } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const r = await db
  .select({ id: schema.venues.id, name: schema.venues.name })
  .from(schema.venues)
  .where(ilike(schema.venues.name, '%opera%'));
for (const v of r) console.log(`${v.id} | ${v.name}`);
process.exit(0);
