import { eq } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const [venue] = await db
  .select({ id: schema.venues.id, name: schema.venues.name, scraperConfig: schema.venues.scraperConfig })
  .from(schema.venues)
  .where(eq(schema.venues.id, 'het-concertgebouw'));

if (!venue) {
  console.log('venue concertgebouw niet gevonden');
  process.exit(1);
}

const next = {
  ...(venue.scraperConfig ?? {}),
  theater: {
    sitemapUrl: 'https://www.concertgebouw.nl/sitemap.xml',
    showUrlPattern: '^https://www\\.concertgebouw\\.nl/concerten/[^/]+$',
  },
};
await db.update(schema.venues).set({ scraperConfig: next }).where(eq(schema.venues.id, 'het-concertgebouw'));
console.log(`+ ${venue.id} → theater config gezet`);
process.exit(0);
