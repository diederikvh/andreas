import { ilike, or } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const r = await db
  .select({ id: schema.venues.id, name: schema.venues.name })
  .from(schema.venues)
  .where(
    or(
      ilike(schema.venues.name, '%theater amsterdam%'),
      ilike(schema.venues.name, '%internationaal%'),
      ilike(schema.venues.id, '%ita%')
    )
  );
for (const v of r) console.log(`${v.id} | ${v.name}`);
process.exit(0);
