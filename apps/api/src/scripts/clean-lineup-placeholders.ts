/**
 * Eenmalig opruim-script: strip generieke placeholder-namen ("support",
 * "tba", "special guest", etc.) uit alle bestaande lineup-arrays in de
 * occurrences-tabel. Hergebruikt de detector uit enrich.ts zodat
 * "bron-filter" en "DB-cleanup" exact dezelfde regels volgen.
 *
 * Veilig idempotent: een tweede run vindt niets meer om te wijzigen.
 * Lege lineups na de schoonmaak worden niet gewist — die kunnen
 * later weer gevuld worden door re-scrapes.
 */
import { eq, sql } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { isLineupPlaceholderName } from '../scrapers/enrich.js';

type LineupItem = {
  name: string;
  role?: 'dj' | 'support' | 'headliner' | 'act';
  artistId?: string;
};

const rows = await db
  .select({
    id: schema.occurrences.id,
    lineup: schema.occurrences.lineup,
  })
  .from(schema.occurrences)
  .where(
    sql`${schema.occurrences.lineup} IS NOT NULL AND jsonb_array_length(${schema.occurrences.lineup}) > 0`
  );

let updated = 0;
let removed = 0;

for (const r of rows) {
  const lineup = (r.lineup as LineupItem[] | null) ?? [];
  const cleaned = lineup.filter((item) => !isLineupPlaceholderName(item.name));
  if (cleaned.length === lineup.length) continue;

  removed += lineup.length - cleaned.length;
  updated += 1;

  await db
    .update(schema.occurrences)
    .set({ lineup: cleaned.length > 0 ? (cleaned as never) : null })
    .where(eq(schema.occurrences.id, r.id));
}

console.log(`scanned ${rows.length} occurrences with lineup`);
console.log(`updated ${updated} occurrences`);
console.log(`removed ${removed} placeholder entries`);
process.exit(0);
