import { eq } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const [v] = await db
  .select({ id: schema.venues.id, name: schema.venues.name, scraperConfig: schema.venues.scraperConfig })
  .from(schema.venues)
  .where(eq(schema.venues.id, 'frascati'));
if (!v) {
  console.log('frascati niet gevonden');
  process.exit(1);
}
const next = {
  ...(v.scraperConfig ?? {}),
  theater: {
    sitemapUrl: 'https://www.frascatitheater.nl/sitemap.xml',
    showUrlPattern: '^https://www\\.frascatitheater\\.nl/nl/agenda/[a-z0-9-]+$',
  },
};
await db.update(schema.venues).set({ scraperConfig: next }).where(eq(schema.venues.id, 'frascati'));
console.log(`+ ${v.id} (${v.name}) → theater config gezet`);
process.exit(0);
