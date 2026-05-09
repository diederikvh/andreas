/**
 * Voor elke theater-gescrapede venue: vind events met identieke titels
 * (= mogelijke duplicaten door dezelfde URL-shape issues als Concert-
 * gebouw had — numeric prefix per voorstelling, alias-pages, etc.).
 */
import { and, eq, like } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const venues = await db.select().from(schema.venues);
const targets = venues.filter((v) => Boolean(v.scraperConfig?.theater?.sitemapUrl));

console.log(`Theater-gescrapede venues: ${targets.length}\n`);

for (const v of targets) {
  const evs = await db
    .select({ id: schema.events.id, title: schema.events.title })
    .from(schema.events)
    .where(and(eq(schema.events.venueId, v.id), like(schema.events.id, 'evt-th-%')));

  const byTitle = new Map<string, { id: string; title: string }[]>();
  for (const e of evs) {
    const norm = e.title.trim().toLowerCase();
    const arr = byTitle.get(norm) ?? [];
    arr.push(e);
    byTitle.set(norm, arr);
  }

  const dupes = [...byTitle.values()].filter((arr) => arr.length > 1);
  const dupeCount = dupes.reduce((a, arr) => a + arr.length - 1, 0);
  const flag = dupes.length > 0 ? ' ⚠️' : ' ✓';
  console.log(
    `${flag} ${v.name.padEnd(28)} ${String(evs.length).padStart(4)} events  ${String(
      dupes.length
    ).padStart(3)} dupe-clusters (${dupeCount} extra)`
  );
  if (dupes.length > 0) {
    for (const arr of dupes.slice(0, 3)) {
      console.log(`     "${arr[0].title}":`);
      for (const e of arr) console.log(`       ${e.id}`);
    }
    if (dupes.length > 3) console.log(`     ... +${dupes.length - 3} meer`);
  }
}

process.exit(0);
