/**
 * Idempotente update: zet `venues.categories` voor alle bekende slugs.
 * Draait niet automatisch — handmatig runnen na de migratie die de
 * kolom toevoegde:
 *
 *   pnpm tsx --env-file=.env scripts/set-venue-categories.ts
 *
 * Voor nieuwe venues: dit script bijwerken óf direct via Drizzle Studio.
 */

import { eq } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const CATEGORIES_BY_SLUG: Record<
  string,
  ('Muziek' | 'Theater' | 'Literatuur' | 'Film')[]
> = {
  occii: ['Muziek'],
  paradiso: ['Muziek', 'Film'],
  perdu: ['Literatuur'],
  eye: ['Film'],
  frascati: ['Theater', 'Literatuur'],
};

let updated = 0;
for (const [slug, cats] of Object.entries(CATEGORIES_BY_SLUG)) {
  const result = await db
    .update(schema.venues)
    .set({ categories: cats })
    .where(eq(schema.venues.slug, slug))
    .returning({ id: schema.venues.id });
  if (result.length > 0) {
    updated += 1;
    // eslint-disable-next-line no-console
    console.log(`✓ ${slug} → [${cats.join(', ')}]`);
  } else {
    // eslint-disable-next-line no-console
    console.warn(`⚠ ${slug} niet gevonden — overgeslagen`);
  }
}
// eslint-disable-next-line no-console
console.log(`\n${updated} venue(s) bijgewerkt.`);
process.exit(0);
