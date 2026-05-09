/**
 * Voor elke venue: tel title-dupes (events met identieke title binnen
 * dezelfde venue). Geeft snel overzicht of een scraper z'n events
 * blijft samenvoegen of dat 'r issues zijn.
 */
import { eq } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const venues = await db.select().from(schema.venues);

type Row = { name: string; total: number; clusters: number; extra: number };
const rows: Row[] = [];

for (const v of venues) {
  const evs = await db
    .select({ id: schema.events.id, title: schema.events.title })
    .from(schema.events)
    .where(eq(schema.events.venueId, v.id));
  if (evs.length === 0) continue;
  const byTitle = new Map<string, string[]>();
  for (const e of evs) {
    const k = e.title.trim().toLowerCase();
    const arr = byTitle.get(k) ?? [];
    arr.push(e.id);
    byTitle.set(k, arr);
  }
  const clusters = [...byTitle.values()].filter((a) => a.length > 1);
  const extra = clusters.reduce((a, arr) => a + arr.length - 1, 0);
  rows.push({ name: v.name, total: evs.length, clusters: clusters.length, extra });
}

rows.sort((a, b) => b.extra - a.extra);

console.log(`Venue                              Total   Dupes (clusters/extra)`);
console.log('─'.repeat(70));
for (const r of rows) {
  if (r.extra === 0) continue;
  console.log(
    `${r.name.padEnd(35)} ${String(r.total).padStart(5)}    ${String(
      r.clusters
    ).padStart(3)} / ${r.extra}`
  );
}
const clean = rows.filter((r) => r.extra === 0).length;
const dirty = rows.filter((r) => r.extra > 0).length;
console.log('─'.repeat(70));
console.log(`Schoon: ${clean} venues  |  met dupes: ${dirty} venues`);
process.exit(0);
