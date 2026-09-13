import { sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
const a = await db.execute(sql`
  select e.venue_id, count(*) as toekomst,
         count(*) filter (where (o.starts_at at time zone 'Europe/Amsterdam') >= timestamp '2026-10-25 03:00') as na_wissel
  from occurrences o join events e on e.id=o.event_id
  where o.starts_at > now() and o.id like 'occ-ob-%' group by 1`);
console.log('— operaballet —'); console.table(a.rows);
const b = await db.execute(sql`
  select count(*) as met_save from saves s
  join occurrences o on o.id=s.occurrence_id where o.id like 'occ-ob-%' and o.starts_at > now()`);
console.log('— saves erop —'); console.table(b.rows);
process.exit(0);
