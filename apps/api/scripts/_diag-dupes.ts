/**
 * Per venue: title-clusters met hun datums, zodat je kan zien of het
 * echte dubbelen zijn (zelfde dag) of een terugkerend event dat als
 * losse events is ingevoerd i.p.v. occurrences.
 */
import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../src/db/index.js';

const targets = process.argv.slice(2).filter((a) => !a.startsWith('-'));

for (const venueId of targets) {
  const [v] = await db.select().from(schema.venues).where(eq(schema.venues.id, venueId));
  if (!v) { console.log(`?? venue ${venueId} niet gevonden`); continue; }
  const evs = await db
    .select({ id: schema.events.id, title: schema.events.title })
    .from(schema.events)
    .where(eq(schema.events.venueId, venueId));
  const occ = await db
    .select({ eventId: schema.occurrences.eventId, startsAt: schema.occurrences.startsAt })
    .from(schema.occurrences)
    .where(inArray(schema.occurrences.eventId, evs.map((e) => e.id)));

  const datesOf = new Map<string, string[]>();
  for (const o of occ) {
    datesOf.set(o.eventId, [...(datesOf.get(o.eventId) ?? []), o.startsAt.toISOString().slice(0, 10)]);
  }
  const byTitle = new Map<string, typeof evs>();
  for (const e of evs) {
    const k = e.title.trim().toLowerCase();
    byTitle.set(k, [...(byTitle.get(k) ?? []), e] as typeof evs);
  }
  const clusters = [...byTitle.entries()].filter(([, a]) => a.length > 1).sort((a, b) => b[1].length - a[1].length);

  const prefix = evs[0]?.id.split('-').slice(0, 2).join('-') ?? '?';
  console.log(`\n═══ ${v.name} (${venueId}) — ${evs.length} events, ${occ.length} occ, ${clusters.length} clusters — id-prefix: ${prefix}`);
  for (const [title, arr] of clusters.slice(0, 6)) {
    const allDates = arr.flatMap((e) => datesOf.get(e.id) ?? []).sort();
    const uniqDates = [...new Set(allDates)];
    const verdict = uniqDates.length === 1 ? 'ZELFDE DAG' : `${uniqDates.length} losse dagen`;
    console.log(`  ${arr.length}x  "${title.slice(0, 52)}"  → ${verdict}`);
    console.log(`        occ/event: ${arr.map((e) => (datesOf.get(e.id) ?? []).length).join(',')}`);
    console.log(`        dagen: ${uniqDates.slice(0, 8).join(' ')}${uniqDates.length > 8 ? ' …' : ''}`);
  }
}
process.exit(0);
