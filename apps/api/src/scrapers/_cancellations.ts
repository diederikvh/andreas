/**
 * Zet occurrences op status `'cancelled'` zodra de event-TITEL een
 * annulerings-marker bevat ("GEANNULEERD" / "AFGELAST" / "CANCELLED" …).
 *
 * Waarom een centrale sweep i.p.v. per-scraper: de ~90 scrapers doen elk
 * hun eigen occurrence-insert en zetten status meestal hard op
 * `'scheduled'`. Venues markeren een afgelaste voorstelling vaak door
 * "GEANNULEERD" vóór de titel te plakken zonder een aparte status-API.
 * Die titel-marker glipt dan door alle publieke filters (zoek/gids, MCP,
 * SEO) heen, want die filteren op `status <> 'cancelled'`, niet op titel.
 *
 * Eén idempotente sweep — gemodelleerd naar `_effective-genres.ts` —
 * vangt álle scrapers (bestaand én toekomstig) in één plek. Draait in de
 * post-scrape pipeline (`scrape-stager.yml`) via
 * `/admin/api/recompute-cancellations`.
 *
 * Bewust géén titel-opschoning: de marker blijft staan zodat (a) de sweep
 * idempotent blijft en bij re-scrape opnieuw matcht, en (b) iemand die de
 * voorstelling had gered op de detail-pagina de reden ("GEANNULEERD")
 * blijft zien naast de cancelled-badge.
 *
 * Titel-marker = hele event afgelast: er is geen occurrence-titel, dus een
 * marker zit altijd op event-niveau en cancelt álle occurrences van dat
 * event. Een echt partiële annulering (één datum van een reeks) komt via
 * een per-occurrence status-API binnen, niet via de event-titel.
 */
import { sql } from 'drizzle-orm';

import { db } from '../db/index.js';

/**
 * Annulerings-markers in een event-titel, als word-boundary-regex voor
 * Postgres `~*` (case-insensitive). NL: geannuleerd/afgelast. EN:
 * cancelled/canceled. FR: annulé/annule. DE: abgesagt. `\y` = word-
 * boundary zodat we geen substrings binnen langere woorden raken.
 */
export const CANCELLED_TITLE_REGEX =
  '\\y(geannuleerd|afgelast|cancelled|canceled|annul[ée]|abgesagt)\\y';

/** True als de titel een annulerings-marker bevat (JS-spiegel van de SQL). */
export function titleSignalsCancelled(title: string): boolean {
  return /\b(geannuleerd|afgelast|cancelled|canceled|annul[ée]|abgesagt)\b/i.test(
    title
  );
}

export async function recomputeCancellations(): Promise<{ updated: number }> {
  const result = await db.execute(sql`
    UPDATE occurrences o
    SET status = 'cancelled'
    FROM events e
    WHERE o.event_id = e.id
      AND o.status <> 'cancelled'
      AND e.title ~* ${CANCELLED_TITLE_REGEX}
  `);

  // node-postgres geeft rowCount; Neon-http kan 'm anders noemen.
  const updated =
    (result as unknown as { rowCount?: number; rowsAffected?: number })
      .rowCount ??
    (result as unknown as { rowsAffected?: number }).rowsAffected ??
    0;
  return { updated };
}
