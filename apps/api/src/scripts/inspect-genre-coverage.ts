/**
 * Hoe goed vangt de vaste genrelijst (`alerts/genres.ts`) het echte aanbod?
 *
 * Per categorie: hoeveel komende events minstens één vast genre krijgen,
 * hoeveel er per genre vallen, en welke labels nergens landen (meest
 * voorkomend eerst). Die laatste lijst is waar je de genrelijst bijwerkt.
 *
 * Gebruik: `pnpm tsx --env-file=.env src/scripts/inspect-genre-coverage.ts`
 */
import { sql } from 'drizzle-orm';

import { MAIN_LABELS, genresOf, normalizeGenre, type Category } from '../alerts/genres.js';
import { db } from '../db/index.js';

const res = await db.execute<{ category: Category; genres: string[] }>(sql`
  SELECT e.category::text AS category, e.genres
  FROM events e
  WHERE e.published
    AND EXISTS (SELECT 1 FROM occurrences o WHERE o.event_id = e.id AND o.starts_at > now())
`);

const byCat = new Map<Category, { total: number; covered: number; perKey: Map<string, number>; unmapped: Map<string, number> }>();
for (const row of res.rows) {
  const c = byCat.get(row.category) ?? { total: 0, covered: 0, perKey: new Map(), unmapped: new Map() };
  byCat.set(row.category, c);
  c.total++;
  // Zoals een regel matcht: alleen de eerste labels.
  const keys = genresOf(row.category, row.genres.slice(0, MAIN_LABELS));
  if (keys.length > 0) c.covered++;
  for (const k of keys) c.perKey.set(k, (c.perKey.get(k) ?? 0) + 1);
  for (const raw of row.genres) {
    if (genresOf(row.category, [raw]).length === 0) {
      const n = normalizeGenre(raw);
      c.unmapped.set(n, (c.unmapped.get(n) ?? 0) + 1);
    }
  }
}

const top = (m: Map<string, number>, n: number) =>
  [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join(', ');

for (const [cat, c] of byCat) {
  console.log(`\n## ${cat}: ${c.covered}/${c.total} events met een vast genre (${Math.round((100 * c.covered) / c.total)}%)`);
  console.log(`per genre: ${top(c.perKey, 40)}`);
  console.log(`niet gevangen: ${top(c.unmapped, 40)}`);
}
process.exit(0);
