/**
 * Titels in normale schrijfwijze. Zalen zetten namen vaak in kapitalen
 * ("ELMER", "HET GOEDE DOEL®"); in een lijst schreeuwt dat, en de
 * artiestenpagina schrijft dezelfde naam gewoon.
 *
 * Alleen titels die helemaal uit hoofdletters bestaan, en voorzichtig:
 *   - staat de titel als artiest bij ons met gewone schrijfwijze, dan die
 *     ("NUBIYAN TWIST" → "Nubiyan Twist");
 *   - staat die artiest zelf ook in kapitalen, dan laten we het: dat is
 *     vaak bewuste stilering (FKJ, SPYAIR, BUNT.);
 *   - anders elk woord met een hoofdletter en verder klein; bekende
 *     afkortingen (ADE, DJ, B2B), woorden met cijfers ("SBP4") en
 *     landcodes tussen haakjes ("(DE)") blijven staan.
 * ®/™ gaan er altijd af.
 */
import { sql } from 'drizzle-orm';

import { db } from '../db/index.js';

/** Afkortingen die kapitalen horen te blijven. */
const KEEP = new Set([
  'ADE', 'DJ', 'DJS', 'MC', 'XL', 'XXL', 'UK', 'US', 'USA', 'NL', 'EU', 'TV', 'VR', 'AI', 'LP', 'EP', 'OST', 'NYE',
  'NDSM', 'KINK', 'LGBTQ', 'LGBTQIA', 'NASA', 'BBNG', 'JFK', 'ABBA', 'AC', 'DC', 'II', 'III', 'IV', 'VI', 'VII',
]);
/** Kleine woorden, behalve vooraan. */
const SMALL = new Set(['de', 'het', 'een', 'van', 'voor', 'en', 'of', 'op', 'met', 'in', 'aan', 'the', 'and', 'to', 'at', 'a', 'an', 'with']);

const isAllCaps = (t: string) => /\p{Lu}{2}/u.test(t) && !/\p{Ll}/u.test(t);

export function normalTitle(title: string, artistSpelling?: string | null): string {
  const clean = title.replace(/[®™]/g, '').trim();
  if (!isAllCaps(clean)) return clean;
  if (artistSpelling) return isAllCaps(artistSpelling) ? clean : artistSpelling;
  let first = true;
  return clean.replace(/[\p{L}\p{N}’']+/gu, (w, at: number) => {
    const lower = w.toLowerCase();
    // Landcode tussen haakjes: "(DE)", "(USA)".
    const inParens = clean[at - 1] === '(' && clean[at + w.length] === ')' && w.length <= 3;
    const out =
      KEEP.has(w) || /\d/.test(w) || inParens
        ? w
        : SMALL.has(lower) && !first
          ? lower
          : w[0] + w.slice(1).toLowerCase();
    first = false;
    return out;
  });
}

/** Komende titels bijwerken. Scrapers voegen events alleen toe en
    overschrijven de titel daarna niet, dus eenmaal netjes blijft netjes. */
export async function normalizeTitles(): Promise<number> {
  const rows = await db.execute<{ id: string; title: string; artist: string | null }>(sql`
    SELECT e.id, e.title,
      (SELECT ar.name FROM artists ar
       WHERE lower(ar.name) = lower(trim(regexp_replace(e.title, '[®™]', '', 'g'))) LIMIT 1) AS artist
    FROM events e
    WHERE e.published AND e.title ~ '[®™]|[[:upper:]]{2}'
      AND EXISTS (SELECT 1 FROM occurrences o WHERE o.event_id = e.id AND o.starts_at > NOW())
  `);
  let changed = 0;
  for (const r of rows.rows) {
    const next = normalTitle(r.title, r.artist);
    if (next && next !== r.title) {
      await db.execute(sql`UPDATE events SET title = ${next} WHERE id = ${r.id}`);
      changed++;
    }
  }
  return changed;
}
