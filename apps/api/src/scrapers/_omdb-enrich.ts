/**
 * Verrijk Film-events met OMDb-data (Plot, Poster, Genre).
 *
 * Idempotent: pakt alleen events met ontbrekende velden. Bedoeld als
 * post-step na een film-scraper-run, of als standalone batch-job (cron
 * roept 'm via /admin/api/enrich-films-omdb aan).
 *
 * Returnt een rapport zodat de admin-endpoint en het script dezelfde
 * output kunnen tonen.
 */

import { and, eq, isNull, or, sql } from 'drizzle-orm';

import { db, schema } from '../db/index.js';

const UA = 'AndreasBot/1.0 (+https://andreas.amsterdam)';

export interface OmdbEnrichResult {
  scanned: number;
  updated: number;
  notFound: number;
  alreadyOk: number;
}

interface OmdbResponse {
  Plot?: string;
  Poster?: string;
  Genre?: string;
  Response?: string;
}

/** Strip suffix-haakjes, "ENG SUBS"-labels en festival-prefixen
    zodat OMDb's title-search een betere match krijgt. */
export function cleanTitleForOmdb(title: string): string {
  return title
    .split(/\s*\|\s*/)[0]
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+(ENG|NL|EN)\s+(SUBS?|SUB|ondertiteling)\s*$/i, '')
    .replace(/\s+&amp;\s+/g, ' & ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchOmdb(title: string): Promise<OmdbResponse | null> {
  const key = process.env.OMDB_API_KEY;
  if (!key) return null;
  try {
    const url = `https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${key}`;
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    return (await r.json()) as OmdbResponse;
  } catch {
    return null;
  }
}

export async function enrichFilmsFromOmdb(): Promise<OmdbEnrichResult> {
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

  const result: OmdbEnrichResult = {
    scanned: films.length,
    updated: 0,
    notFound: 0,
    alreadyOk: 0,
  };

  for (const f of films) {
    const clean = cleanTitleForOmdb(f.title);
    if (!clean) continue;
    const data = await fetchOmdb(clean);
    if (!data || data.Response !== 'True') {
      result.notFound += 1;
      continue;
    }
    const patch: Record<string, unknown> = {};
    if (
      !f.description &&
      data.Plot &&
      data.Plot !== 'N/A' &&
      data.Plot.length > 20
    ) {
      patch.description = data.Plot.trim();
    }
    if (
      !f.imageUrl &&
      data.Poster &&
      data.Poster !== 'N/A' &&
      data.Poster.startsWith('http')
    ) {
      patch.imageUrl = data.Poster;
    }
    if (
      (!f.genres || f.genres.length === 0) &&
      data.Genre &&
      data.Genre !== 'N/A'
    ) {
      const genres = data.Genre.split(',')
        .map((g) => g.trim())
        .filter(Boolean);
      if (genres.length > 0) patch.genres = genres;
    }
    if (Object.keys(patch).length === 0) {
      result.alreadyOk += 1;
      continue;
    }
    await db
      .update(schema.events)
      .set(patch)
      .where(eq(schema.events.id, f.id));
    result.updated += 1;
  }
  return result;
}
