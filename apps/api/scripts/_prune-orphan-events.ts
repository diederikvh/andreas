/**
 * Verwijder events zonder occurrences. Die ontstaan doordat de
 * titel-dedup occurrences naar het canonieke event verhuist (zie
 * _title-dedup.ts) en doordat bronnen shows offline halen.
 *
 * Ze zijn onzichtbaar in de app — zonder datum komt een event in geen
 * enkele lijst — maar ze vervuilen de dupe-checks en de tellingen.
 *
 * Guard: `share_invites.event_id` en `events_in_series.event_id`
 * verwijzen direct naar events. Een wees waar zo'n verwijzing aan hangt
 * slaan we over; die zou een uitnodiging of een serie breken.
 *
 * Dry-run tenzij --apply.
 */
import { inArray, sql } from 'drizzle-orm';
import { db, schema } from '../src/db/index.js';

const APPLY = process.argv.includes('--apply');

const rows: any = await db.execute(sql`
  SELECT e.id, e.venue_id, e.title, e.created_at
  FROM events e
  WHERE NOT EXISTS (SELECT 1 FROM occurrences o WHERE o.event_id = e.id)
  ORDER BY e.venue_id, e.id
`);
const orphans = (rows.rows ?? rows) as { id: string; venue_id: string; title: string }[];
console.log(`events zonder occurrences: ${orphans.length}`);
if (!orphans.length) process.exit(0);

const ids = orphans.map((o) => o.id);
const invites = await db.select({ eventId: schema.shareInvites.eventId })
  .from(schema.shareInvites).where(inArray(schema.shareInvites.eventId, ids));
const series = await db.select({ eventId: schema.eventsInSeries.eventId })
  .from(schema.eventsInSeries).where(inArray(schema.eventsInSeries.eventId, ids));
const blocked = new Set([...invites, ...series].map((r) => r.eventId).filter(Boolean) as string[]);

const deletable = orphans.filter((o) => !blocked.has(o.id));
const perVenue = new Map<string, number>();
for (const o of deletable) perVenue.set(o.venue_id, (perVenue.get(o.venue_id) ?? 0) + 1);

console.log(`  overgeslagen (invite of serie): ${blocked.size}`);
console.log(`  ${APPLY ? 'verwijderd' : 'te verwijderen'}: ${deletable.length}`);
for (const [v, n] of [...perVenue].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`     ${v.padEnd(24)} ${n}`);
}
for (const id of blocked) console.log(`  BLIJFT ${id}`);

if (APPLY && deletable.length) {
  // In batches: één grote IN-lijst van duizenden ids is traag op Neon.
  const batch = 200;
  let done = 0;
  for (let i = 0; i < deletable.length; i += batch) {
    const slice = deletable.slice(i, i + batch).map((o) => o.id);
    await db.delete(schema.events).where(inArray(schema.events.id, slice));
    done += slice.length;
  }
  console.log(`\nklaar: ${done} events verwijderd`);
}
process.exit(0);
