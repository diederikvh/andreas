import { sql } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const all = await db
  .select({ id: schema.events.id, venueId: schema.events.venueId, imageUrl: schema.events.imageUrl })
  .from(schema.events);

type Stat = { total: number; remote: number; mirrored: number; none: number; remoteSamples: string[] };
const byVenue = new Map<string, Stat>();
for (const e of all) {
  let s = byVenue.get(e.venueId);
  if (!s) { s = { total: 0, remote: 0, mirrored: 0, none: 0, remoteSamples: [] }; byVenue.set(e.venueId, s); }
  s.total++;
  if (!e.imageUrl) s.none++;
  else if (e.imageUrl.startsWith('https://andreas-x.b-cdn.net/')) s.mirrored++;
  else { s.remote++; if (s.remoteSamples.length < 2) s.remoteSamples.push(e.imageUrl.slice(0, 80)); }
}
const rows = Array.from(byVenue.entries()).map(([id, s]) => ({ id, ...s }));
rows.sort((a, b) => b.remote - a.remote || b.total - a.total);

console.log(`venue                              | total | REMOTE | mirrored | none`);
console.log(`-----------------------------------+-------+--------+----------+-----`);
for (const r of rows) {
  if (r.total === 0) continue;
  console.log(`${r.id.padEnd(35)}| ${String(r.total).padStart(5)} | ${String(r.remote).padStart(6)} | ${String(r.mirrored).padStart(8)} | ${String(r.none).padStart(4)}`);
  if (r.remote > 0) for (const s of r.remoteSamples) console.log(`  → ${s}`);
}
process.exit(0);
