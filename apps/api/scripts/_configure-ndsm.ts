import { eq, ilike, or } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const venues = await db
  .select({ id: schema.venues.id, name: schema.venues.name, scraperConfig: schema.venues.scraperConfig })
  .from(schema.venues)
  .where(or(ilike(schema.venues.name, '%ndsm%'), ilike(schema.venues.id, '%ndsm%')));
for (const v of venues) console.log(`  found: ${v.id} | ${v.name}`);

if (venues.length === 0) {
  console.log('geen NDSM venue');
  process.exit(1);
}

// Pick the loods one
const venue = venues.find((v) => /loods/i.test(v.name)) ?? venues[0];
const next = {
  ...(venue.scraperConfig ?? {}),
  theater: {
    sitemapUrl: 'https://www.ndsmloods.nl/event_listing-sitemap.xml',
    showUrlPattern: '^https://www\\.ndsmloods\\.nl/evenement/[a-z0-9-]+/?$',
  },
};
await db.update(schema.venues).set({ scraperConfig: next }).where(eq(schema.venues.id, venue.id));
console.log(`+ ${venue.id} → theater config gezet`);
process.exit(0);
