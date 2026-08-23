/**
 * Classificeer title-clusters in drie soorten. Aggregatie in SQL —
 * alle events+occurrences naar Node halen timede uit.
 *
 *   zelfde-dag  → echte dubbelen (het Lofi-geval)
 *   run         → aaneengesloten dagen = één show, meerdere avonden
 *   terugkerend → verspreide datums = wekelijkse/maandelijkse avond
 */
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';

const rows = (await db.execute(sql`
  WITH ev AS (
    SELECT e.id, e.venue_id, lower(btrim(e.title)) AS key,
           min(o.starts_at) AS first_start
    FROM events e
    JOIN occurrences o ON o.event_id = e.id
    GROUP BY e.id, e.venue_id, lower(btrim(e.title))
  ),
  cl AS (
    SELECT venue_id, key, count(*) AS n,
           array_agg(DISTINCT (first_start AT TIME ZONE 'Europe/Amsterdam')::date ORDER BY (first_start AT TIME ZONE 'Europe/Amsterdam')::date) AS days
    FROM ev GROUP BY venue_id, key HAVING count(*) > 1
  )
  SELECT venue_id, key, n, days,
         array_length(days, 1) AS n_days,
         (SELECT max(d2 - d1) FROM (
            SELECT d AS d1, lead(d) OVER (ORDER BY d) AS d2
            FROM unnest(days) AS d
          ) g WHERE d2 IS NOT NULL) AS max_gap
  FROM cl ORDER BY n DESC
`)) as unknown as { rows: any[] };

const list = rows.rows ?? (rows as any);
// Postgres geeft de array als literal-string terug, niet als JS-array.
const daysOf = (r: any): string[] =>
  Array.isArray(r.days) ? r.days : String(r.days).replace(/^[{]|[}]$/g, '').split(',').filter(Boolean);
const TODAY = new Date().toISOString().slice(0, 10);
const kindOf = (r: any) =>
  Number(r.n_days) <= 1 ? 'zelfdeDag' : Number(r.max_gap) <= 1 ? 'run' : 'terugkerend';

const agg: Record<string, { clusters: number; extra: number }> = {
  zelfdeDag: { clusters: 0, extra: 0 }, run: { clusters: 0, extra: 0 }, terugkerend: { clusters: 0, extra: 0 },
};
const perVenue = new Map<string, Record<string, number>>();
for (const r of list) {
  const k = kindOf(r);
  agg[k].clusters++;
  agg[k].extra += Number(r.n) - 1;
  const pv = perVenue.get(r.venue_id) ?? { zelfdeDag: 0, run: 0, terugkerend: 0 };
  pv[k]++;
  perVenue.set(r.venue_id, pv);
}

console.log('soort          clusters   rijen te veel');
console.log('─'.repeat(45));
for (const k of ['zelfdeDag', 'run', 'terugkerend']) {
  console.log(`${k.padEnd(14)} ${String(agg[k].clusters).padStart(8)} ${String(agg[k].extra).padStart(15)}`);
}

console.log('\n── zelfde-dag (echte dubbelen):');
for (const r of list.filter((r: any) => kindOf(r) === 'zelfdeDag')) {
  const d = daysOf(r);
  const komend = d.some((x) => x >= TODAY);
  console.log(`   ${r.n}x  ${komend ? 'KOMEND ' : 'verlopen'}  ${r.venue_id.padEnd(20)} "${String(r.key).slice(0, 42)}"  ${d.join(' ')}`);
}
console.log('\n── grootste runs (aaneengesloten dagen):');
for (const r of list.filter((r: any) => kindOf(r) === 'run').slice(0, 8)) {
  console.log(`   ${r.n}x  ${r.venue_id.padEnd(20)} "${String(r.key).slice(0, 38)}"  ${daysOf(r).slice(0, 4).join(' ')}`);
}
console.log('\n── venues met meeste terugkerende clusters:');
for (const [v, c] of [...perVenue.entries()].sort((a, b) => b[1].terugkerend - a[1].terugkerend).slice(0, 8)) {
  console.log(`   ${v.padEnd(28)} terugkerend=${c.terugkerend} run=${c.run} zelfdeDag=${c.zelfdeDag}`);
}
process.exit(0);
