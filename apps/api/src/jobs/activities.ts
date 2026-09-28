/**
 * Events die iets om te doen zijn, niet om te zien, naar de categorie
 * Activiteit: quiz, podcastopname, rondleiding, workshop, masterclass, les.
 * Zalen zetten die onder Muziek, Theater of Lezing ("Backstage
 * rondleiding" bij TivoliVredenburg, "Openbare rondleiding" bij een
 * theater), en dan staan ze in de agenda tussen de concerten.
 *
 * Herkend aan het zaallabel of aan de titel (dezelfde regel als in de
 * meldingen, zie `ACTIVITY_TITLE_REGEX`).
 *
 * Alleen events van de laatste twee dagen, behalve bij `all`: zet iemand
 * er in de admin een terug naar Muziek, dan blijft dat zo.
 */
import { sql } from 'drizzle-orm';

import { ACTIVITY_TITLE_REGEX } from '../alerts/genres.js';
import { db } from '../db/index.js';

/** Zaallabels die op een activiteit wijzen. */
const LABELS = ['anders', 'quiz', 'pubquiz', 'popquiz', 'bingo', 'yoga', 'podcast', 'rondleiding', 'boekenclub', 'markt', 'spelavond', 'workshop', 'masterclass', 'cursus'];

export async function classifyActivities(opts: { all?: boolean } = {}): Promise<number> {
  const res = await db.execute(sql`
    UPDATE events e SET category = 'Activiteit'
    WHERE e.category <> 'Activiteit' AND e.published
      ${opts.all ? sql`` : sql`AND e.created_at > NOW() - INTERVAL '2 days'`}
      AND (e.title ~* ${ACTIVITY_TITLE_REGEX}
        OR EXISTS (SELECT 1 FROM unnest(e.genres) g WHERE lower(g) = ANY(${`{${LABELS.join(',')}}`}::text[])))
      AND EXISTS (SELECT 1 FROM occurrences o WHERE o.event_id = e.id AND o.starts_at > NOW())
    RETURNING 1
  `);
  return res.rows.length;
}
