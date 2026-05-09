import { eq } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const [v] = await db
  .select({ id: schema.venues.id, scraperConfig: schema.venues.scraperConfig, published: schema.venues.published })
  .from(schema.venues)
  .where(eq(schema.venues.id, 'madam'));
if (!v) { console.log('madam niet gevonden'); process.exit(1); }
const next = { ...(v.scraperConfig ?? {}), fourvenues: { slug: 'madam@g:pwsbn' } };
await db.update(schema.venues)
  .set({ scraperConfig: next, published: true })
  .where(eq(schema.venues.id, 'madam'));
console.log(`+ madam → fourvenues(slug=madam@g:pwsbn) gezet, published=true`);
process.exit(0);
