/**
 * Vult `event_artists`: welke artiest bij welk komend event hoort, en als
 * wat (optreden of tribute).
 *
 * Drie bronnen, in deze volgorde van gewicht:
 *   - de line-up, voor alle artiesten (die koppeling is al exact);
 *   - de titel (`titleHasName`), alleen voor artiesten die iemand volgt.
 *     Over álle ~10.000 artiesten is dat te zwaar, en voor wie niemand
 *     volgt vraagt ook niemand erom;
 *   - het programma van een klassiek concert: een gevolgde componist
 *     wiens naam in titel of beschrijving staat is `werk_van`. Op
 *     volledige naam, of op achternaam ("Beethovens Tripelconcert") als de
 *     artiest klassieke genres heeft (Last.fm). Zonder die eis werd Men I
 *     Trust een componist omdat er "trust" in een programma stond.
 *     "Max Richter's Vivaldi" is ook werk van, geen optreden.
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

/** Woorden van een tekst, met een spatie aan beide kanten. */
const words = (e: string) => `(' ' || lower(trim(regexp_replace(${e}, '[^[:alnum:]]+', ' ', 'g'))) || ' ')`;
/** Een klassiek concert, aan de labels van de zaal. */
const CLASSICAL = `EXISTS (SELECT 1 FROM unnest(e.genres) g
  WHERE g ~* '^(klassiek|klassieke muziek|classical|kamermuziek|chamber music|barok|baroque|opera|orkest|orchestral|symfonisch|koor)$')`;
/** Woorden in de naam van een gezelschap, geen persoon. */
const ENSEMBLE = `collegium|vocale|ensemble|orkest|orchest|orchestra|koor|choir|kwartet|quartet|consort|trio|sinfonia|sinfonietta|philharmoni|kamerkoor|cappella|baroque`;
/** Artiest-tags (Last.fm) die op een componist wijzen. */
const CLASSICAL_TAGS = `ARRAY['classical', 'contemporary classical', 'modern classical', 'composer', 'baroque', 'opera', 'romantic', 'neoclassical', 'minimalism', 'film composer', 'german composer', 'italian composer', 'compositeur']`;

// ponytail: volledige ronde per tik (~1 s bij 3.900 koppelingen); incrementeel
// op o.created_at als dit met de catalogus meegroeit tot tientallen seconden.
export async function linkEventArtists(): Promise<{ linked: number; removed: number }> {
  const res = await db.execute<{ linked: number; removed: number }>(sql`
    WITH upcoming_occ AS (
      SELECT o.event_id, o.lineup
      FROM occurrences o
      WHERE o.starts_at > NOW() AND o.status <> 'cancelled'
    ),
    -- Eén rij per event voor de titel en het programma; de line-up per
    -- avond, want een festival heeft per dag een andere.
    upcoming AS (SELECT DISTINCT event_id FROM upcoming_occ),
    found AS (
      -- Line-up: exact, voor iedereen. Behalve een kleine line-up waarvan
      -- geen naam in de titel staat: dat is meestal de bezetting van de
      -- act, niet een rij acts. "Jack & Jack" heeft als line-up Jack
      -- Gilinsky en Jack Johnson, en dat is niet de Jack Johnson die je volgt.
      SELECT u.event_id, le->>'artistId' AS artist_id, 'optreden' AS role, 'lineup' AS source
      FROM upcoming_occ u
      JOIN events e ON e.id = u.event_id
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(u.lineup) = 'array' THEN u.lineup ELSE '[]'::jsonb END) le
      WHERE le->>'artistId' IS NOT NULL
        AND (jsonb_array_length(u.lineup) > 3 OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(u.lineup) l2
          WHERE position(${sql.raw(words("l2->>'name'"))} in ${sql.raw(words('e.title'))}) > 0
        ))
      UNION ALL
      -- Titel: alleen gevolgde artiesten.
      SELECT e.id, ar.id,
        CASE WHEN ${sql.raw(CLASSICAL)} AND position(${sql.raw(words('ar.name'))} || 's ' in ${sql.raw(words('e.title'))}) > 0 THEN 'werk_van'
             WHEN ${sql.raw(titleTributeOf('ar.name'))} THEN 'tribute'
             ELSE 'optreden' END,
        'titel'
      FROM upcoming u
      JOIN events e ON e.id = u.event_id AND e.published
      JOIN artists ar ON ar.id IN (SELECT artist_id FROM artist_follows)
      WHERE ${sql.raw(titleHasName('ar.name'))}
      UNION ALL
      -- Covers: een popartiest wiens nummers op het programma staan ("hits
      -- van De Dijk", "liedjes van … Jacques Brel", "De Dijk-hits"). Niet
      -- een naam in een bio ("werkte eerder samen met Rufus Wainwright").
      SELECT e.id, ar.id, 'covers', 'programma'
      FROM upcoming u
      JOIN events e ON e.id = u.event_id AND e.published
      JOIN artists ar ON ar.id IN (SELECT artist_id FROM artist_follows)
      -- De naam als patroon: alles behalve letters, cijfers en spaties wordt '.'.
      CROSS JOIN LATERAL (SELECT regexp_replace(lower(ar.name), '[^[:alnum:] ]', '.', 'g') AS rx) n
      -- Alleen wie genres heeft en geen klassieke: zonder genres weten we
      -- niet of het een popartiest is ("werk van Beethoven" is geen cover).
      WHERE COALESCE(cardinality(ar.genres), 0) > 0 AND NOT (ar.genres && ${sql.raw(CLASSICAL_TAGS)})
        AND ar.name ~ ' '
        AND strpos(e.description, ar.name) > 0
        AND (lower(e.description) ~ ('(hits|nummers|liedjes|songs|chansons|repertoire|covers|muziek|werk) (van|of|by) [^.]{0,40}' || n.rx)
          OR lower(e.description) ~ (n.rx || '[- ]?(hits|nummers|liedjes|songs|covers)'))
      UNION ALL
      -- Programma: klassiek concert, componist in titel of beschrijving.
      -- Nooit een gezelschap: een ensemble in de tekst speelt, of staat in
      -- iemands bio ("Collegium Vocale Gent" bij Hadewych van Gent).
      SELECT e.id, ar.id, 'werk_van', 'programma'
      FROM upcoming u
      JOIN events e ON e.id = u.event_id AND e.published
      JOIN artists ar ON ar.id IN (SELECT artist_id FROM artist_follows)
      CROSS JOIN LATERAL (SELECT ${sql.raw(words(`e.title || ' ' || COALESCE(e.description, '')`))} AS txt) t
      CROSS JOIN LATERAL (SELECT lower(regexp_replace(ar.name, '^.* ', '')) AS surname) sn
      WHERE ${sql.raw(CLASSICAL)}
        AND ar.name !~* ${ENSEMBLE}
        -- Een naam van één woord (Elmer, Prince) is geen componist te noemen.
        AND ar.name ~ ' '
        AND length(sn.surname) >= 4
        AND strpos(lower(e.title || ' ' || COALESCE(e.description, '')), sn.surname) > 0
        AND (
          -- Alleen componisten; een popartiest hier is "covers" (hierboven)
          -- of een naam in een bio. Volledige naam zoals geschreven, of
          -- de achternaam.
          -- Zonder genres (Beethoven is niet altijd getagd) mag het ook;
          -- een popartiest heeft genres en valt hier dus af.
          ((ar.genres && ${sql.raw(CLASSICAL_TAGS)} OR COALESCE(cardinality(ar.genres), 0) = 0)
            AND ar.name ~ ' ' AND strpos(e.title || ' ' || COALESCE(e.description, ''), ar.name) > 0)
          OR (ar.genres && ${sql.raw(CLASSICAL_TAGS)}
              AND (position(' ' || sn.surname || ' ' in t.txt) > 0 OR position(' ' || sn.surname || 's ' in t.txt) > 0))
        )
    ),
    best AS (
      -- De line-up wint van de titel (die is exact), de titel van het programma.
      SELECT DISTINCT ON (f.event_id, f.artist_id) f.event_id, f.artist_id, f.role, f.source
      FROM found f
      JOIN artists ar ON ar.id = f.artist_id
      ORDER BY f.event_id, f.artist_id, array_position(ARRAY['lineup', 'titel', 'programma'], f.source)
    ),
    ins AS (
      INSERT INTO event_artists (event_id, artist_id, role, source)
      SELECT event_id, artist_id, role, source FROM best
      ON CONFLICT (event_id, artist_id) DO UPDATE
        SET role = EXCLUDED.role, source = EXCLUDED.source
        WHERE event_artists.source <> 'admin'
          AND (event_artists.role, event_artists.source) IS DISTINCT FROM (EXCLUDED.role, EXCLUDED.source)
      RETURNING 1
    ),
    -- Wat niet meer gevonden wordt (titel aangepast, laatste volger weg)
    -- mag weg, maar alleen bij komende events: een koppeling van een
    -- geweest event is geschiedenis.
    del AS (
      DELETE FROM event_artists ea
      WHERE ea.source <> 'admin'
        AND ea.event_id IN (SELECT event_id FROM upcoming)
        AND NOT EXISTS (SELECT 1 FROM best b WHERE b.event_id = ea.event_id AND b.artist_id = ea.artist_id)
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM ins)::int AS linked, (SELECT count(*) FROM del)::int AS removed
  `);
  return res.rows[0];
}
