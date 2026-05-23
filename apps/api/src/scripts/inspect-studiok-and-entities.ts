/**
 * Eénmalig diagnose-script:
 *   1. Welke Studio/K dupes zijn er nog (zelfde event + startsAt +
 *      ticketUrl met andere occId)?
 *   2. Welke film-titles bevatten nog HTML-entities (&amp;, &#nnn;)?
 *   3. Wanneer is de laatste Studio/K occurrence-insert gemaakt?
 *      (sanity: is de daily-scrape al gedraaid sinds de deploy?)
 */
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

async function main() {
  console.log('=== 1. Studio/K dupe occurrences (same event+startsAt+ticketUrl, diff occId) ===\n');
  const dupesRes = await db.execute(sql`
    SELECT e.title, o.starts_at, o.ticket_url, COUNT(*) as n,
           array_agg(o.id) as occ_ids,
           array_agg(o.created_at::text) as occ_created
    FROM occurrences o
    JOIN events e ON e.id = o.event_id
    WHERE o.venue_id = 'aa-studio-k'
      AND e.category = 'Film'
      AND e.kind = 'show'
    GROUP BY e.title, o.starts_at, o.ticket_url
    HAVING COUNT(*) > 1
    ORDER BY o.starts_at
  `);
  console.log(`Dupe-slots: ${dupesRes.rows.length}`);
  for (const r of dupesRes.rows) {
    console.log(`  "${r.title}" @ ${r.startsAt}`);
    console.log(`    ticket=${r.ticketUrl}`);
    const ids = r.occ_ids as string[];
    const created = r.occ_created as string[];
    for (let i = 0; i < ids.length; i++) {
      console.log(`    occ ${ids[i]} created=${created[i]}`);
    }
  }

  console.log('\n=== 2. Studio/K occurrences in DB (alle, met createdAt) ===\n');
  const allRes = await db.execute(sql`
    SELECT e.title, o.starts_at, o.id, o.created_at
    FROM occurrences o
    JOIN events e ON e.id = o.event_id
    WHERE o.venue_id = 'aa-studio-k'
      AND e.category = 'Film'
      AND e.kind = 'show'
      AND o.starts_at >= NOW()
    ORDER BY o.starts_at, e.title
  `);
  console.log(`Future Studio/K occs: ${allRes.rows.length}`);
  // Group by event title voor leesbaarheid
  const byTitle = new Map<string, any[]>();
  for (const r of allRes.rows) {
    const list = byTitle.get(r.title as string) ?? [];
    list.push(r);
    byTitle.set(r.title as string, list);
  }
  for (const [title, list] of byTitle) {
    console.log(`\n  "${title}" (${list.length} occs):`);
    for (const r of list) {
      console.log(`    ${r.startsAt} occ-id=${r.id} created=${r.createdAt}`);
    }
  }

  console.log('\n=== 3. Wanneer laatste Studio/K occurrence-insert? ===\n');
  const latestRes = await db.execute(sql`
    SELECT MIN(o.created_at) as oldest, MAX(o.created_at) as latest, COUNT(*) as n
    FROM occurrences o
    JOIN events e ON e.id = o.event_id
    WHERE o.venue_id = 'aa-studio-k'
      AND e.category = 'Film'
      AND e.kind = 'show'
  `);
  console.log(latestRes.rows[0]);

  console.log('\n=== 4. Film-events met HTML-entities in de title ===\n');
  const entitiesRes = await db.execute(sql`
    SELECT id, title, venue_id, created_at
    FROM events
    WHERE category = 'Film'
      AND kind = 'show'
      AND (
        title LIKE '%&amp;%' OR
        title LIKE '%&quot;%' OR
        title LIKE '%&apos;%' OR
        title LIKE '%&#%' OR
        title LIKE '%&nbsp;%' OR
        title LIKE '%&lt;%' OR
        title LIKE '%&gt;%'
      )
    ORDER BY created_at DESC
  `);
  console.log(`Events met HTML-entities in title: ${entitiesRes.rows.length}`);
  for (const r of entitiesRes.rows) {
    console.log(`  "${r.title}" venue=${r.venueId} id=${r.id} created=${r.createdAt}`);
  }

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
