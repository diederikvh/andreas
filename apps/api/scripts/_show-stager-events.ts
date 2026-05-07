/** Toon alle stager-gescrapete events per venue, compacte view. */
import { asc, eq, like } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const VENUE_SLUGS = ['radion', 'cinetol', 'if-i-cant-dance', 'splendor'];

for (const slug of VENUE_SLUGS) {
  const [venue] = await db.select().from(schema.venues).where(eq(schema.venues.slug, slug));
  if (!venue) continue;
  const events = await db
    .select()
    .from(schema.events)
    .where(eq(schema.events.venueId, venue.id))
    .orderBy(asc(schema.events.title));
  const stagerEvents = events.filter((e) => e.id.startsWith('evt-stg-'));
  console.log(`\n━━ ${venue.name} (${stagerEvents.length} stager events) ━━`);
  for (const e of stagerEvents) {
    const occs = await db
      .select()
      .from(schema.occurrences)
      .where(eq(schema.occurrences.eventId, e.id))
      .orderBy(asc(schema.occurrences.startsAt));
    const o = occs[0];
    const lineup = o?.lineup ? o.lineup.map((l) => l.name).join(', ') : '—';
    const img = e.imageUrl ? '🖼' : '·';
    const desc = e.description ? `${e.description.length}c` : '·';
    const price = o?.priceCents != null ? `€${(o.priceCents / 100).toFixed(2)}` : '—';
    console.log(`  ${img} ${e.title}`);
    console.log(`     ${o?.startsAt.toISOString().slice(0, 16) ?? '—'} | ${price} | ${o?.status} | desc=${desc} | genres=${JSON.stringify(e.genres)}`);
    console.log(`     lineup: ${lineup}`);
  }
}
process.exit(0);
