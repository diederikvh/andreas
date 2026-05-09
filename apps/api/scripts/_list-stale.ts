import { eq, and, isNotNull, not, like } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const venueId = process.argv[2] ?? 'delamar';
const rows = await db
  .select({ id: schema.events.id, title: schema.events.title, imageUrl: schema.events.imageUrl })
  .from(schema.events)
  .where(
    and(
      eq(schema.events.venueId, venueId),
      isNotNull(schema.events.imageUrl),
      not(like(schema.events.imageUrl, 'https://andreas-x.b-cdn.net/%'))
    )
  );
console.log(`${venueId}: ${rows.length} stale`);
for (const r of rows) console.log(`  ${r.id} | ${r.title.slice(0, 40)} | ${r.imageUrl}`);
process.exit(0);
