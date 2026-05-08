import { eq, like, and } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

/**
 * Verwijder TM-events voor venues die ook een eigen theater-scraper
 * hebben (Carré, DeLaMar, Meervaart). Theater-bron is exhaustief en
 * heeft betere multi-night data; TM was alleen een subset. Daarna
 * nemen we ticketmaster uit hun scraperConfig zodat ze niet opnieuw
 * worden gepakt bij de cron.
 */
const venueIds = ['carre', 'delamar', 'meervaart'];

let total = 0;
for (const vid of venueIds) {
  const evs = await db
    .select({ id: schema.events.id, title: schema.events.title })
    .from(schema.events)
    .where(and(eq(schema.events.venueId, vid), like(schema.events.id, 'evt-tm-%')));
  for (const e of evs) {
    await db.delete(schema.events).where(eq(schema.events.id, e.id));
  }
  console.log(`  ${vid}: ${evs.length} TM events verwijderd`);
  total += evs.length;

  const [v] = await db
    .select({ scraperConfig: schema.venues.scraperConfig })
    .from(schema.venues)
    .where(eq(schema.venues.id, vid));
  if (v?.scraperConfig?.ticketmaster) {
    const next = { ...v.scraperConfig };
    delete next.ticketmaster;
    await db.update(schema.venues).set({ scraperConfig: next }).where(eq(schema.venues.id, vid));
    console.log(`     → ticketmaster-config verwijderd`);
  }
}
console.log(`\n${total} TM events totaal verwijderd.`);
process.exit(0);
