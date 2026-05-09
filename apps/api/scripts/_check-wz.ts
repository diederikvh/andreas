import { like } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const evs = await db
  .select({
    id: schema.events.id, venueId: schema.events.venueId,
    description: schema.events.description, imageUrl: schema.events.imageUrl,
  })
  .from(schema.events)
  .where(like(schema.events.id, 'evt-wz-%'));
const byVenue = new Map<string, { total: number; desc: number; mirror: number; remote: number; none: number }>();
for (const e of evs) {
  let s = byVenue.get(e.venueId);
  if (!s) { s = { total: 0, desc: 0, mirror: 0, remote: 0, none: 0 }; byVenue.set(e.venueId, s); }
  s.total++;
  if (e.description && e.description.length > 30) s.desc++;
  if (!e.imageUrl) s.none++;
  else if (e.imageUrl.startsWith('https://andreas-x.b-cdn.net/')) s.mirror++;
  else s.remote++;
}
for (const [v, s] of byVenue) console.log(`${v}: ${s.total} | desc=${s.desc} | mirror=${s.mirror} | remote=${s.remote} | none=${s.none}`);
process.exit(0);
