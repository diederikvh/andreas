import { and, asc, eq, like, sql } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const evs = await db
  .select({
    id: schema.events.id,
    title: schema.events.title,
  })
  .from(schema.events)
  .where(
    and(eq(schema.events.venueId, 'het-concertgebouw'), like(schema.events.id, 'evt-th-%'))
  );

console.log(`het-concertgebouw events: ${evs.length}\n`);

// Groepeer op normalised titel — als zelfde concert onder verschillende
// slugs zit, krijgen we hier meerdere event-rijen voor dezelfde titel.
const byTitle = new Map<string, { id: string; title: string }[]>();
for (const e of evs) {
  const norm = e.title.trim().toLowerCase();
  const arr = byTitle.get(norm) ?? [];
  arr.push(e);
  byTitle.set(norm, arr);
}

const dupes = [...byTitle.values()].filter((arr) => arr.length > 1);
console.log(`Title-dupes (zelfde titel, meerdere events): ${dupes.length}`);
for (const arr of dupes.slice(0, 15)) {
  console.log(`\n  "${arr[0].title}" — ${arr.length} events:`);
  for (const e of arr) console.log(`    ${e.id}`);
}

// Occurrences per event — events met >1 occurrence zijn legitieme
// multi-night shows. Events met 1 occurrence zouden per concert
// uniek moeten zijn.
const occRows = (await db.execute(
  sql`
    SELECT event_id, count(*)::int as n, min(starts_at) as first_at
    FROM occurrences
    WHERE event_id LIKE 'evt-th-het-concertgebouw-%'
    GROUP BY event_id
    ORDER BY n DESC
  `
)) as unknown as Array<{ event_id: string; n: number; first_at: string }>;

const single = occRows.filter((r) => r.n === 1).length;
const multi = occRows.filter((r) => r.n > 1).length;
console.log(`\nOccurrence-distributie: ${single} single | ${multi} multi-night`);
console.log('\nTop 10 multi-night shows:');
for (const r of occRows.slice(0, 10)) {
  const ev = evs.find((e) => e.id === r.event_id);
  console.log(`  ${r.n}× — ${ev?.title ?? '?'} (${r.event_id})`);
}

// Toekomst-coverage: hoeveel events per maand vanaf vandaag?
const futureRows = (await db.execute(
  sql`
    SELECT to_char(starts_at AT TIME ZONE 'Europe/Amsterdam', 'YYYY-MM') as ym, count(*)::int as n
    FROM occurrences
    WHERE event_id LIKE 'evt-th-het-concertgebouw-%'
      AND starts_at >= NOW()
    GROUP BY ym
    ORDER BY ym ASC
  `
)) as unknown as Array<{ ym: string; n: number }>;

console.log(`\nToekomstige occurrences per maand:`);
for (const r of futureRows) console.log(`  ${r.ym}: ${r.n}`);

process.exit(0);
