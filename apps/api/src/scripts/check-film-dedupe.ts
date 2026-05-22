import { and, eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { normalizeFilmTitle } from '../scrapers/_film-dedup.js';

async function main() {
  const rows = await db
    .select({ id: schema.events.id, title: schema.events.title, venueId: schema.events.venueId })
    .from(schema.events)
    .where(and(eq(schema.events.category, 'Film'), eq(schema.events.kind, 'show')));

  const byKey = new Map<string, { id: string; title: string; venueId: string }[]>();
  for (const row of rows) {
    const key = normalizeFilmTitle(row.title);
    if (!key) continue;
    const arr = byKey.get(key) ?? [];
    arr.push(row);
    byKey.set(key, arr);
  }

  const collisions = [...byKey.entries()].filter(([_, v]) => v.length > 1);
  console.log(`Total Film+show events: ${rows.length}`);
  console.log(`Distinct normalized keys: ${byKey.size}`);
  console.log(`Collisions (dupes die gemerged moeten worden): ${collisions.length}\n`);
  for (const [key, items] of collisions) {
    console.log(`[${key}]`);
    for (const it of items) {
      console.log(`  - "${it.title}" venue=${it.venueId} id=${it.id}`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
