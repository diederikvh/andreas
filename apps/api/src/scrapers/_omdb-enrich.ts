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

/** Strip programma-context (curator-prefixen, festival-suffixen, live-
    performer-annotaties, Q&A-tags) zodat OMDb/TMDb's title-search niet
    over de venue-context valt. De helpernaam dateert van toen we alleen
    OMDb gebruikten — werkt ook voor TMDb-search en wordt daar gebruikt.

    Patterns zijn empirisch geverifieerd tegen de prod-catalogus (zie
    inspect-tmdb-coverage.ts). Bij elke pattern-toevoeging: hercheck of
    legitieme film-titels niet worden gemolesteerd.

    Volgorde van bewerkingen matters: paren-strip eerst (kan andere
    patterns onthullen), dan bullet-suffix, dan prefix, dan suffix-
    patterns, dan whitespace-collapse. */
export function cleanTitleForOmdb(title: string): string {
  return title
    // 1) Alles na " | " — legacy (sommige venues plakten venue-naam erna).
    .split(/\s*\|\s*/)[0]
    // 2) Festival/programma-bullet suffix: " • Summer of Studio/Queer",
    //    " • Open Land". Vrijwel exclusief Studio/K.
    .replace(/\s*[•·]\s*[^•·()[\]]+$/u, '')
    // 3) Curator-prefixen: "Buitenspel: TITLE", "Preview: TITLE",
    //    "Eng Subs: TITLE", "Sprouts: TITLE", "Kaboom Cult presents …".
    //    Wel uitkijken: gebruik woord-grenzen zodat we geen valide
    //    titels als "Preview to a Kill" rakeen (in praktijk: i + ^).
    .replace(
      /^(?:buitenspel|preview|eng\s+subs?|sprouts|kaboom\s+cult\s+presents|straight\s+to\s+video\s+presents)\s*:\s*/i,
      ''
    )
    // 4) Programma-suffix met hyphen-separator: " - Jim Jarmusch
    //    Revisited", " - Africadelic", " - Pass the Popcorn",
    //    " - voorpremière". Specifieke lijst — niet generiek " - X$"
    //    want te veel valide titels eindigen op " - subtitle".
    .replace(
      /\s+-\s+(?:jim\s+jarmusch\s+revisited|africadelic|pass\s+the\s+popcorn|voorpremi[eè]re|english\s+subs?)\s*$/i,
      ''
    )
    // 5) Em-dash suffix: stomme films met live-muziek-performers
    //    ("Faust — Olga Pashchenko + Jed Wentz" → "Faust"). Em-dash (—)
    //    is sterker signaal dan en-dash (–); en-dash zit vaker in
    //    echte titels (bv. "Decolonizing Minds – The Blida-Joinville
    //    Chronicles") en die laten we met rust.
    .replace(/\s+—\s+.+$/, '')
    // 6) " – by X Festival" — typisch programma-curatie context bij
    //    Cavia ("Coming of Age – by Porn Film Festival Amsterdam").
    .replace(/\s+[–-]\s+by\s+.+$/i, '')
    // 7) Generieke jaar- en annotatie-haakjes: "(2024)", "(ENG subs)",
    //    "(Benefiet Special)". Doen we ná de specifiekere patterns
    //    omdat sommige van die patterns op de paren-content rekenen.
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    // 8) Postfix-tags: "+ Q&A", "incl. introduction/panel talk".
    .replace(/\s+(?:\+|met)\s+q\s*&\s*a\s*$/i, '')
    .replace(/\s+incl\.\s+(?:introduction|panel\s+talk|intro)\s*$/i, '')
    // 9) "(ENG|NL|EN) SUBS"-suffix legacy.
    .replace(/\s+(ENG|NL|EN)\s+(SUBS?|SUB|ondertiteling)\s*$/i, '')
    // 10) Datum-suffix: " - 5 Juni 19:00" / " - 5 juni 19:00" (Cinema
    //     De Vlugt voegt soms een datestamp toe in de titel).
    .replace(/\s+-\s+\d+\s+\w+\s+\d{1,2}:\d{2}\s*$/, '')
    // 11) Common entity-fix.
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
