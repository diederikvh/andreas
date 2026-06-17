/**
 * Herbereken `events.effective_genres` = eigen `genres` PLUS de genres van de
 * gelinkte line-up-artiesten (techno/house/…), eigen eerst, gecapt op 6.
 *
 * Puur afgeleid en idempotent: leest `events.genres` (eigendom van de genre-
 * enrich-pipeline) + `artists.genres` via de lineup-`artistId`'s, en schrijft
 * naar de aparte `effective_genres`-kolom — dus geen interferentie met die
 * pipeline. Updatet alleen rijen die écht veranderen (write-churn laag).
 *
 * Draait in de daily job ná artist- én genre-enrichment (admin-endpoint
 * `/admin/api/recompute-effective-genres`).
 */
import { sql } from 'drizzle-orm';

import { db } from '../db/index.js';

/** Max aantal labels dat we opslaan (eigen genres eerst, dan artiest-genres). */
const MAX_EFFECTIVE_GENRES = 6;

export async function recomputeEffectiveGenres(): Promise<{ updated: number }> {
  const result = await db.execute(sql`
    WITH computed AS (
      SELECT
        e.id,
        (
          e.genres || COALESCE((
            SELECT array_agg(DISTINCT ag.g)
            FROM occurrences o
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.lineup, '[]'::jsonb)) le
            JOIN artists a ON a.id = (le ->> 'artistId')
            CROSS JOIN LATERAL unnest(a.genres) AS ag(g)
            WHERE o.event_id = e.id
              AND NOT (ag.g = ANY(e.genres))
          ), ARRAY[]::text[])
        )[1:${sql.raw(String(MAX_EFFECTIVE_GENRES))}] AS eg
      FROM events e
    )
    UPDATE events e
    SET effective_genres = c.eg
    FROM computed c
    WHERE c.id = e.id
      AND e.effective_genres IS DISTINCT FROM c.eg
  `);

  // node-postgres geeft rowCount; Neon-http kan 'm anders noemen.
  const updated =
    (result as unknown as { rowCount?: number; rowsAffected?: number }).rowCount ??
    (result as unknown as { rowsAffected?: number }).rowsAffected ??
    0;
  return { updated };
}
