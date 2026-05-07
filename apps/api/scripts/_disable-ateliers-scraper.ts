/** De Ateliers iCal-feed bevat exposities van oud-deelnemers in musea
 *  buiten Amsterdam — niet relevant. Dit script:
 *    1. Wist alle iCal-gescrapete events van De Ateliers
 *    2. Verwijdert `scraperConfig.ical` zodat ze niet opnieuw worden
 *       opgepakt door de daily cron
 *    3. Laat venue-record + andere config (zoals categories) intact */
import { eq, like, and } from 'drizzle-orm';
import { db, schema } from '../src/db/index.js';

const SLUG = 'de-ateliers';

const [venue] = await db
  .select()
  .from(schema.venues)
  .where(eq(schema.venues.slug, SLUG))
  .limit(1);
if (!venue) {
  console.error(`✗ venue ${SLUG} niet gevonden`);
  process.exit(1);
}
console.log(`venue: ${venue.name} (${venue.id})`);

const deleted = await db
  .delete(schema.events)
  .where(
    and(
      eq(schema.events.venueId, venue.id),
      like(schema.events.id, 'evt-ical-%')
    )
  )
  .returning({ id: schema.events.id });
console.log(`✓ ${deleted.length} iCal-events verwijderd`);

const { ical: _omit, ...rest } = venue.scraperConfig ?? {};
await db
  .update(schema.venues)
  .set({
    scraperConfig: Object.keys(rest).length > 0 ? rest : null,
  })
  .where(eq(schema.venues.id, venue.id));
console.log(`✓ scraperConfig.ical verwijderd`);
process.exit(0);
