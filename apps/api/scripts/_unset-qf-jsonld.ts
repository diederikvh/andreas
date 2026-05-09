import { eq } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const [v] = await db
  .select({ scraperConfig: schema.venues.scraperConfig })
  .from(schema.venues)
  .where(eq(schema.venues.id, 'q-factory'));
if (!v) { console.log('q-factory niet gevonden'); process.exit(1); }
const next = { ...(v.scraperConfig ?? {}) };
delete next.jsonld;
await db.update(schema.venues).set({ scraperConfig: next }).where(eq(schema.venues.id, 'q-factory'));
console.log('jsonld config verwijderd voor q-factory');
process.exit(0);
