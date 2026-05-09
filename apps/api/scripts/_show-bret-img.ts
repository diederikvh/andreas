import { eq, and, like } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const e = await db
  .select({ id: schema.events.id, title: schema.events.title, imageUrl: schema.events.imageUrl })
  .from(schema.events)
  .where(and(eq(schema.events.venueId, 'bret'), like(schema.events.id, 'evt-cel-%')))
  .limit(5);
for (const x of e) console.log(`${x.id} | ${x.title.slice(0, 30)} | ${x.imageUrl}`);
process.exit(0);
