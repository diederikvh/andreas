import { eq } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const v = await db.select().from(schema.venues).where(eq(schema.venues.id, 'bimhuis')).limit(1);
console.log('bimhuis config:', JSON.stringify(v[0]?.scraperConfig ?? null));

const evs = await db
  .select({ id: schema.events.id, title: schema.events.title })
  .from(schema.events)
  .where(eq(schema.events.venueId, 'bimhuis'));

const map = new Map<string, number>();
for (const e of evs) {
  const k = e.title.trim().toLowerCase();
  map.set(k, (map.get(k) ?? 0) + 1);
}
const dupes = [...map.entries()].filter(([, n]) => n > 1);
console.log(`bimhuis: ${evs.length} events, ${dupes.length} title-dupes`);
for (const [t, n] of dupes.slice(0, 5)) console.log(`  ${n}× — ${t}`);
process.exit(0);
