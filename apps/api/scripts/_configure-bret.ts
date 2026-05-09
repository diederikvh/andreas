import { eq } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const [v] = await db
  .select({ id: schema.venues.id, scraperConfig: schema.venues.scraperConfig })
  .from(schema.venues)
  .where(eq(schema.venues.id, 'bret'));
if (!v) { console.log('bret venue niet gevonden'); process.exit(1); }
const next = { ...(v.scraperConfig ?? {}), celebratix: { channel: 'fuef7' } };
await db.update(schema.venues).set({ scraperConfig: next }).where(eq(schema.venues.id, 'bret'));
console.log(`+ bret → celebratix(channel=fuef7) gezet`);
process.exit(0);
