/**
 * Zet alle stager-gescrapete events van een venue op published=true.
 *
 *   pnpm tsx --env-file=.env scripts/_publish-stager.ts <venue-slug>
 */
import { and, eq, like } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const slug = process.argv[2];
if (!slug) {
  console.error('Geef venue-slug mee (bv. splendor)');
  process.exit(1);
}

const [venue] = await db
  .select()
  .from(schema.venues)
  .where(eq(schema.venues.slug, slug));
if (!venue) {
  console.error(`✗ venue niet gevonden: ${slug}`);
  process.exit(1);
}

const result = await db
  .update(schema.events)
  .set({ published: true })
  .where(
    and(
      eq(schema.events.venueId, venue.id),
      like(schema.events.id, 'evt-stg-%')
    )
  )
  .returning({ id: schema.events.id, title: schema.events.title });

console.log(`${result.length} events op published=true gezet voor ${venue.name}:`);
for (const e of result) console.log(`  ✓ ${e.title}`);
process.exit(0);
