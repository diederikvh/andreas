import { eq } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const [v] = await db
  .select({ id: schema.venues.id, scraperConfig: schema.venues.scraperConfig })
  .from(schema.venues)
  .where(eq(schema.venues.id, 'nachbar'));
if (!v) { console.log('nachbar niet gevonden'); process.exit(1); }
const next = {
  ...(v.scraperConfig ?? {}),
  stager: { host: 'nachbar.stager.co', shopId: 5088 },
};
await db.update(schema.venues).set({ scraperConfig: next }).where(eq(schema.venues.id, 'nachbar'));
console.log('+ nachbar → stager(host=nachbar.stager.co, shopId=5352) gezet');
process.exit(0);
