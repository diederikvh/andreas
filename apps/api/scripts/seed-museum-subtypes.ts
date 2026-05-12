import { eq } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const TARGETS: Array<{ id: string; subtype: string[] }> = [
  { id: 'foam', subtype: ['fotografie'] },
  { id: 'huis-marseille', subtype: ['fotografie'] },
  { id: 'nxt-museum', subtype: ['media', 'experimenteel'] },
];

for (const t of TARGETS) {
  const [v] = await db
    .select({ id: schema.venues.id, name: schema.venues.name, subtype: schema.venues.subtype })
    .from(schema.venues)
    .where(eq(schema.venues.id, t.id));
  if (!v) {
    console.warn(`! ${t.id} niet gevonden — overgeslagen`);
    continue;
  }
  await db.update(schema.venues).set({ subtype: t.subtype }).where(eq(schema.venues.id, t.id));
  console.log(`+ ${v.id} (${v.name}) subtype: ${JSON.stringify(v.subtype)} → ${JSON.stringify(t.subtype)}`);
}
process.exit(0);
