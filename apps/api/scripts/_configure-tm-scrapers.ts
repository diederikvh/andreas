import { eq } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

/**
 * Activeer Ticketmaster Discovery API voor 8 Amsterdamse venues. Voor
 * AFAS Live nemen we ook "AFAS Live Loge" mee — TM splitst een paar
 * shows over twee venueIds. Carré / DeLaMar / Meervaart / Theater
 * Amsterdam: voor verkoop hebben deze hun eigen sites, maar TM heeft
 * de tour-acts (musicals + tour-comedians + Engelstalige tour-acts).
 */

const config: Array<{ id: string; venueIds: string[] }> = [
  { id: 'afas-live', venueIds: ['Z598xZbpZk661'] }, // AFAS Live Loge
  { id: 'johan-cruijff-arena', venueIds: ['Z198xZbpZevF'] },
  { id: 'boom-chicago', venueIds: ['Z598xZbpZ7Fvk'] },
  { id: 'rai-theater', venueIds: ['Z598xZbpZeFv1'] },
  { id: 'carre', venueIds: ['Z198xZbpZ7ek'] },
  { id: 'delamar', venueIds: ['Z598xZbpZAedk'] },
  { id: 'meervaart', venueIds: ['Z598xZbpZee17'] },
  { id: 'theater-amsterdam', venueIds: ['Z598xZbpZAvak'] },
];

for (const c of config) {
  const [existing] = await db
    .select({ scraperConfig: schema.venues.scraperConfig })
    .from(schema.venues)
    .where(eq(schema.venues.id, c.id));
  if (!existing) {
    console.log(`  ! ${c.id} ontbreekt`);
    continue;
  }
  const next = {
    ...(existing.scraperConfig ?? {}),
    ticketmaster: { venueIds: c.venueIds },
  };
  await db.update(schema.venues).set({ scraperConfig: next }).where(eq(schema.venues.id, c.id));
  console.log(`  + ${c.id} → ticketmaster=${JSON.stringify(c.venueIds)}`);
}
process.exit(0);
