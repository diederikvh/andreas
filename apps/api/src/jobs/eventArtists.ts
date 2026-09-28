/**
 * Vult `event_artists`: welke artiest bij welk komend event hoort, en als
 * wat (optreden of tribute).
 *
 * Twee bronnen:
 *   - de line-up, voor alle artiesten (die koppeling is al exact);
 *   - de titel (`titleHasName`), alleen voor artiesten die iemand volgt.
 *     Over álle ~10.000 artiesten is dat te zwaar, en voor wie niemand
 *     volgt vraagt ook niemand erom.
 *
 * Elke keer alles opnieuw, en weg met koppelingen die niet meer kloppen
 * (titel gewijzigd, laatste volger weg). Dat duurt een seconde, dus het
 * draait gewoon elke herinneringstik en na een nieuwe volger.
 *
 * Een koppeling met bron `admin` raken we nooit aan.
 */
import { sql } from 'drizzle-orm';

import { titleHasName, titleTributeOf } from '../alerts/match.js';
import { db } from '../db/index.js';

// ponytail: volledige ronde per tik (~1 s bij 3.900 koppelingen); incrementeel
// op o.created_at als dit met de catalogus meegroeit tot tientallen seconden.
export async function linkEventArtists(): Promise<{ linked: number; removed: number }> {
  const res = await db.execute(sql`
    WITH upcoming AS (
      SELECT DISTINCT ON (o.event_id) o.event_id, o.lineup
      FROM occurrences o
      WHERE o.starts_at > NOW() AND o.status <> 'cancelled'
      ORDER BY o.event_id, o.starts_at
    ),
    found AS (
      -- Line-up: exact, voor iedereen.
      SELECT u.event_id, le->>'artistId' AS artist_id, 'optreden' AS role, 'lineup' AS source
      FROM upcoming u
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(u.lineup) = 'array' THEN u.lineup ELSE '[]'::jsonb END) le
      WHERE le->>'artistId' IS NOT NULL
      UNION ALL
      -- Titel: alleen gevolgde artiesten.
      SELECT e.id, ar.id,
        CASE WHEN ${sql.raw(titleTributeOf('ar.name'))} THEN 'tribute' ELSE 'optreden' END, 'titel'
      FROM upcoming u
      JOIN events e ON e.id = u.event_id AND e.published
      JOIN artists ar ON ar.id IN (SELECT artist_id FROM artist_follows)
      WHERE ${sql.raw(titleHasName('ar.name'))}
    )
    INSERT INTO event_artists (event_id, artist_id, role, source)
    -- De line-up wint van de titel: die is exact.
    SELECT DISTINCT ON (f.event_id, f.artist_id) f.event_id, f.artist_id, f.role, f.source
    FROM found f
    JOIN artists ar ON ar.id = f.artist_id
    ORDER BY f.event_id, f.artist_id, (f.source = 'lineup') DESC
    ON CONFLICT (event_id, artist_id) DO UPDATE
      SET role = EXCLUDED.role, source = EXCLUDED.source
      WHERE event_artists.source <> 'admin'
        AND (event_artists.role, event_artists.source) IS DISTINCT FROM (EXCLUDED.role, EXCLUDED.source)
    RETURNING 1
  `);

  // Wat niet meer gevonden wordt (titel aangepast, artiest ontvolgd door
  // de laatste volger) mag weg, maar alleen bij komende events: een
  // koppeling van een geweest event is geschiedenis.
  const del = await db.execute(sql`
    DELETE FROM event_artists ea
    WHERE ea.source <> 'admin'
      AND ea.created_at < NOW() - INTERVAL '1 minute'
      AND EXISTS (SELECT 1 FROM occurrences o WHERE o.event_id = ea.event_id AND o.starts_at > NOW())
      AND NOT EXISTS (
        SELECT 1 FROM occurrences o
        WHERE o.event_id = ea.event_id AND o.starts_at > NOW()
          AND jsonb_typeof(o.lineup) = 'array'
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(o.lineup) le WHERE le->>'artistId' = ea.artist_id)
      )
      AND NOT EXISTS (
        SELECT 1 FROM events e JOIN artists ar ON ar.id = ea.artist_id
        WHERE e.id = ea.event_id
          AND EXISTS (SELECT 1 FROM artist_follows af WHERE af.artist_id = ar.id)
          AND ${sql.raw(titleHasName('ar.name'))}
      )
    RETURNING 1
  `);
  return { linked: res.rows.length, removed: del.rows.length };
}
