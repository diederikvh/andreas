import { eq, ilike, or } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const venues = await db
  .select({ id: schema.venues.id, name: schema.venues.name, scraperConfig: schema.venues.scraperConfig })
  .from(schema.venues)
  .where(or(ilike(schema.venues.name, '%q-factory%'), ilike(schema.venues.id, '%q-factory%'), ilike(schema.venues.name, '%qfactory%')));
for (const v of venues) console.log(`found: ${v.id} | ${v.name}`);
if (venues.length === 0) {
  console.log('q-factory niet gevonden');
  process.exit(1);
}
const venue = venues[0];
const next = {
  ...(venue.scraperConfig ?? {}),
  jsonld: {
    url: 'https://www.ticketmaster.nl/venue/poppodium-q-factory-amsterdam-tickets/qfactory/108',
  },
};
await db.update(schema.venues).set({ scraperConfig: next }).where(eq(schema.venues.id, venue.id));
console.log(`+ ${venue.id} → jsonld config gezet`);
process.exit(0);
