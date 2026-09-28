/**
 * Dubbele events offline halen. Zalen zetten hetzelfde optreden soms
 * twee keer op hun site: een festivaldag én een losse pagina voor een deel
 * ervan ("London Calling" en "Angine de Poitrine e.v.a. @ London Calling"),
 * een versie met en zonder leeftijd ("Guyland (14+)"), een tikfout die
 * later verbeterd werd.
 *
 * Dubbel is: zelfde zaal, zelfde begintijd, niet in verschillende zalen
 * van het gebouw, en dezelfde titel of een line-up die voor het grootste
 * deel overlapt. Het kleinste exemplaar (minder line-up, minder avonden,
 * jonger) gaat offline met `duplicate_of` naar het event dat blijft; een
 * oude link komt zo toch goed uit (zie GET /events/:id).
 *
 * Voorzichtig:
 *   - alleen als élke komende avond van het dubbele event ook bij de
 *     blijver staat; anders zou je een voorstelling kwijtraken;
 *   - niet als iemand het bewaarde of erheen gaat.
 */
import { sql } from 'drizzle-orm';

import { db } from '../db/index.js';

export async function hideDuplicateEvents(opts: { dryRun?: boolean } = {}): Promise<{ dup: string; keeper: string }[]> {
  const found = await db.execute<{ dup: string; keeper: string }>(sql`
    WITH occ AS (
      SELECT o.event_id, COALESCE(o.venue_id, e.venue_id) venue_id, o.starts_at, lower(o.room) room,
        lower(regexp_replace(e.title, '[^[:alnum:]]+', ' ', 'g')) t,
        ARRAY(SELECT lower(le->>'name') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(o.lineup)='array' THEN o.lineup ELSE '[]' END) le) names
      FROM occurrences o JOIN events e ON e.id=o.event_id AND e.published AND e.duplicate_of IS NULL
      WHERE o.starts_at > now() AND o.status <> 'cancelled'
    ),
    pairs AS (
      SELECT DISTINCT a.event_id a, b.event_id b
      FROM occ a JOIN occ b ON a.venue_id=b.venue_id AND a.starts_at=b.starts_at AND a.event_id <> b.event_id
        AND (a.room IS NULL OR b.room IS NULL OR a.room = b.room)
      WHERE a.t = b.t
        OR (cardinality(a.names) > 0 AND cardinality(b.names) > 0
            AND 2 * (SELECT count(*) FROM unnest(a.names) n WHERE n = ANY(b.names)) > least(cardinality(a.names), cardinality(b.names)))
    ),
    size AS (
      SELECT e.id, e.created_at,
        (SELECT max(jsonb_array_length(CASE WHEN jsonb_typeof(o.lineup)='array' THEN o.lineup ELSE '[]' END)) FROM occurrences o WHERE o.event_id=e.id) nl,
        (SELECT count(*) FROM occurrences o WHERE o.event_id=e.id AND o.starts_at > now()) nocc
      FROM events e WHERE e.id IN (SELECT a FROM pairs)
    )
    -- Per paar: de kleinste wijkt voor de grootste (meer line-up, meer avonden, oudste).
    SELECT DISTINCT ON (p.b) p.b AS dup, p.a AS keeper
    FROM pairs p JOIN size sa ON sa.id=p.a JOIN size sb ON sb.id=p.b
    WHERE (sa.nl, sa.nocc, -extract(epoch from sa.created_at), p.a) > (sb.nl, sb.nocc, -extract(epoch from sb.created_at), p.b)
      -- Alleen als élke komende avond van het dubbele event ook bij de blijver staat.
      AND NOT EXISTS (
        SELECT 1 FROM occurrences od WHERE od.event_id=p.b AND od.starts_at > now() AND od.status <> 'cancelled'
          AND NOT EXISTS (SELECT 1 FROM occurrences ok WHERE ok.event_id=p.a AND ok.starts_at=od.starts_at))
      -- Wat iemand bewaarde of waar iemand heen gaat, laten we staan.
      AND NOT EXISTS (SELECT 1 FROM occurrences o JOIN saves s ON s.occurrence_id=o.id WHERE o.event_id=p.b)
      AND NOT EXISTS (SELECT 1 FROM occurrences o JOIN attendance s ON s.occurrence_id=o.id WHERE o.event_id=p.b)
    ORDER BY p.b, sa.nl DESC NULLS LAST, sa.nocc DESC
  `);
  const pairs = found.rows;
  if (opts.dryRun || pairs.length === 0) return pairs;
  for (const p of pairs) {
    await db.execute(sql`UPDATE events SET published = false, duplicate_of = ${p.keeper} WHERE id = ${p.dup}`);
  }
  // Ketens platslaan: A → B → C wordt A → C, zodat een oude link in één
  // stap bij het event uitkomt dat online staat.
  for (let i = 0; i < 3; i++) {
    await db.execute(sql`
      UPDATE events d SET duplicate_of = k.duplicate_of
      FROM events k WHERE d.duplicate_of = k.id AND k.duplicate_of IS NOT NULL`);
  }
  return pairs;
}
