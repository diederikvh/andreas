import { sql } from 'drizzle-orm';

import { db } from '../src/db/index.js';

const r = (await db.execute(
  sql`
    SELECT
      count(DISTINCT e.id)::int AS events_total,
      count(DISTINCT CASE WHEN o.starts_at >= NOW() THEN e.id END)::int AS events_future,
      count(CASE WHEN o.starts_at >= NOW() THEN 1 END)::int AS occ_future
    FROM events e
    LEFT JOIN occurrences o ON o.event_id = e.id
    WHERE e.published = true
  `
)) as unknown as { rows: Array<{ events_total: number; events_future: number; occ_future: number }> };
console.log(r.rows[0]);
process.exit(0);
