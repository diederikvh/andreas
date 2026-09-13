import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';

/**
 * Aanmeldingen koppelen aan een event dat inmiddels gescrapet is.
 *
 * Iemand meldt een avond aan die Andreas nog niet kent; twee weken later
 * zet de zaal 'm alsnog op z'n site en komt hij binnen via een scraper.
 * Vanaf dat moment staan er twee dingen over dezelfde avond in de app: de
 * aanmelding van die persoon, en het echte event. Deze job maakt daar één
 * ding van.
 *
 * **De voorwaarden zijn expres streng**, want een verkeerde koppeling is
 * erger dan geen koppeling: dan verhuist iemands ticket naar de verkeerde
 * avond.
 *
 *  - dezelfde zaal (op `venue_id`, dus alleen als we de zaal kennen)
 *  - dezelfde kalenderdag, Amsterdamse tijd
 *  - titelgelijkenis boven 0,6 (trigram, migratie 0056)
 *  - en **precies één** event dat aan dat alles voldoet. Twee kandidaten
 *    op dezelfde avond in dezelfde zaal? Dan laat de machine het liggen en
 *    beslist een mens in de admin.
 *
 * `status` blijft staan. Een automatische koppeling is geen afhandeling:
 * hij blijft in de admin-lijst staan, nu met een event eraan, zodat je 'm
 * nog kan terugdraaien.
 */
export async function linkSubmissionsToEvents(): Promise<
  { id: string; title: string | null; eventId: string }[]
> {
  const { rows } = await db.execute<{
    id: string;
    title: string | null;
    event_id: string;
  }>(sql`
    with kandidaten as (
      select s.id as sub, e.id as evt,
             count(*) over (partition by s.id) as n
      from event_submissions s
      join events e
        on e.published
       and e.venue_id = s.venue_id
      join occurrences o
        on o.event_id = e.id
       and o.status <> 'cancelled'
       and to_char(o.starts_at at time zone 'Europe/Amsterdam', 'YYYY-MM-DD') = s.date
      where s.event_id is null
        and s.status <> 'rejected'
        and s.venue_id is not null
        and s.date is not null
        and similarity(e.title, coalesce(s.title, s.artists[1], '')) > 0.6
      group by s.id, e.id
    )
    update event_submissions s
       set event_id = k.evt
      from kandidaten k
     where k.sub = s.id
       and k.n = 1
    returning s.id, s.title, s.event_id
  `);
  return rows.map((r) => ({ id: r.id, title: r.title, eventId: r.event_id }));
}
