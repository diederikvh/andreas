/**
 * One-off enrichment script — vult ontbrekende description, image en
 * genres in voor alle Film-events via OMDb (https://www.omdbapi.com).
 * Idempotent: events die al volledig zijn worden geskipt.
 *
 * Run: `pnpm tsx --env-file=.env src/scripts/enrich-films-from-omdb.ts`
 */

import { db, schema } from '../db/index.js';
import { and, eq, sql, isNull, or } from 'drizzle-orm';

const KEY = process.env.OMDB_API_KEY || 'eeeecd51';
const UA = 'AndreasBot/1.0 (+https://andreas.amsterdam)';

/** Strip suffix-haakjes en festival-prefixen voor OMDb match. */
function cleanForLookup(title: string): string {
  return title
    .split(/\s*\|\s*/)[0]
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+(ENG|NL|EN)\s+(SUBS?|SUB|ondertiteling)\s*$/i, '')
    .replace(/\s+&amp;\s+/g, ' & ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function omdb(title: string): Promise<{
  Plot?: string;
  Poster?: string;
  Genre?: string;
  Response?: string;
} | null> {
  try {
    const url = `https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${KEY}`;
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    return (await r.json()) as any;
  } catch {
    return null;
  }
}

const films = await db
  .select({
    id: schema.events.id,
    title: schema.events.title,
    description: schema.events.description,
    imageUrl: schema.events.imageUrl,
    genres: schema.events.genres,
  })
  .from(schema.events)
  .where(
    and(
      eq(schema.events.category, 'Film'),
      eq(schema.events.kind, 'show'),
      or(
        isNull(schema.events.description),
        isNull(schema.events.imageUrl),
        sql`COALESCE(array_length(${schema.events.genres}, 1), 0) = 0`
      )
    )
  );

console.log(`films to enrich: ${films.length}`);

let updated = 0;
let notFound = 0;
let alreadyOk = 0;
for (const f of films) {
  const clean = cleanForLookup(f.title);
  if (!clean) continue;
  const data = await omdb(clean);
  if (!data || data.Response !== 'True') {
    notFound += 1;
    continue;
  }
  const patch: Record<string, unknown> = {};
  if (!f.description && data.Plot && data.Plot !== 'N/A' && data.Plot.length > 20) {
    patch.description = data.Plot.trim();
  }
  if (!f.imageUrl && data.Poster && data.Poster !== 'N/A' && data.Poster.startsWith('http')) {
    patch.imageUrl = data.Poster;
  }
  if ((!f.genres || f.genres.length === 0) && data.Genre && data.Genre !== 'N/A') {
    const genres = data.Genre.split(',').map((g) => g.trim()).filter(Boolean);
    if (genres.length > 0) patch.genres = genres;
  }
  if (Object.keys(patch).length === 0) {
    alreadyOk += 1;
    continue;
  }
  await db.update(schema.events).set(patch).where(eq(schema.events.id, f.id));
  updated += 1;
  if (updated % 25 === 0) console.log(`  ${updated} updated...`);
}
console.log(`done. updated: ${updated}, not found: ${notFound}, already ok: ${alreadyOk}`);
process.exit(0);
