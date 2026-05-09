import { eq } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const [v] = await db
  .select({ id: schema.venues.id, scraperConfig: schema.venues.scraperConfig })
  .from(schema.venues)
  .where(eq(schema.venues.id, 'shelter'));
if (!v) { console.log('shelter niet gevonden'); process.exit(1); }
const next = { ...(v.scraperConfig ?? {}), fourvenues: { slug: 'shelter-amsterdam' } };
await db.update(schema.venues).set({ scraperConfig: next }).where(eq(schema.venues.id, 'shelter'));
console.log('+ shelter → fourvenues(slug=shelter-amsterdam) gezet');
process.exit(0);
