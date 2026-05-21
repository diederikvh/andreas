/**
 * 2-staps genre-verrijking voor events zonder labels.
 *
 *   Stap 1 — keyword-heuristiek (gratis, ~85% accuracy)
 *     Scan title + description voor duidelijke signal-keywords per
 *     categorie. Voor Theater werkt dit goed (kinderprogramma's hebben
 *     "+6", comedy events zeggen "stand-up", etc.). Idempotent —
 *     bij her-runs alleen events met lege genres geraakt.
 *
 *   Stap 2 — AI-fallback (Claude Haiku 4.5, ~€0.005/event)
 *     Voor de events die na stap 1 nog leeg zijn. Hergebruikt de
 *     bestaande `enrichEvent` uit enrich.ts — die geeft o.a. genres
 *     terug op basis van titel + description + venue. Skipt events
 *     zonder bruikbare description (anders kost 't tokens voor niets).
 *
 * Beide functions geven een rapport terug zodat we ze identiek kunnen
 * exposen via admin-endpoints (vergelijkbaar met OMDb-enrich).
 */

import { and, eq, isNull, or, sql } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { enrichEvent } from './enrich.js';

export interface GenreEnrichResult {
  scanned: number;
  updated: number;
  unchanged: number;
}

/** Categorie-specifieke keyword-mappings. Eerste hit wint per event.
    Genres-arrays komen overeen met de discipline-chips op /theater. */
type KeywordRule = {
  pattern: RegExp;
  genres: string[];
};

const THEATER_RULES: KeywordRule[] = [
  { pattern: /\b(kind|familie|family|peuters?|kleuters?|\d+\s*\+)\b/i, genres: ['kindertheater'] },
  { pattern: /\b(opera|operette)\b/i, genres: ['opera'] },
  { pattern: /\b(musical|muziektheater)\b/i, genres: ['musical'] },
  { pattern: /\b(stand[- ]?up|comedy|comédie|cabaret|grappig|humor|improv|improvisatie)\b/i, genres: ['comedy'] },
  { pattern: /\b(dans|dance|ballet|choreografie|choreography|choreograaf|choreographer)\b/i, genres: ['dans'] },
  { pattern: /\b(drama|toneel|theatervoorstelling|play|playwright|toneelstuk)\b/i, genres: ['theater'] },
  { pattern: /\b(performance|performans)\b/i, genres: ['performance'] },
];

const MUZIEK_RULES: KeywordRule[] = [
  { pattern: /\b(techno|techno[- ]house)\b/i, genres: ['techno'] },
  { pattern: /\b(house|deep[- ]?house|tech[- ]?house)\b/i, genres: ['house'] },
  { pattern: /\b(hip[- ]?hop|rap|trap)\b/i, genres: ['hip-hop'] },
  { pattern: /\b(jazz|bebop|swing|big[- ]?band)\b/i, genres: ['jazz'] },
  { pattern: /\b(klassiek|classical|symfonie|symphony|kamermuziek|chamber)\b/i, genres: ['klassiek'] },
  { pattern: /\b(metal|hardcore|punk|grindcore)\b/i, genres: ['metal'] },
  { pattern: /\b(indie|alternative|alt[- ]?rock)\b/i, genres: ['indie'] },
  { pattern: /\b(elektronisch|electronic|ambient|drone)\b/i, genres: ['elektronisch'] },
  { pattern: /\b(disco|funk|soul)\b/i, genres: ['disco'] },
  { pattern: /\b(reggae|dub|ska)\b/i, genres: ['reggae'] },
];

const LEZING_RULES: KeywordRule[] = [
  { pattern: /\b(debat|debate|in gesprek|panel)\b/i, genres: ['debat'] },
  { pattern: /\b(college|hoorcollege|lecture|keynote)\b/i, genres: ['college'] },
  { pattern: /\b(talkshow|talk show|interview)\b/i, genres: ['talkshow'] },
  { pattern: /\b(filosofie|philosophie|filosoof|philosopher)\b/i, genres: ['filosofie'] },
  { pattern: /\b(politiek|politics|geopolitiek)\b/i, genres: ['politiek'] },
];

const KUNST_RULES: KeywordRule[] = [
  { pattern: /\b(fotografie|photography|foto)\b/i, genres: ['fotografie'] },
  { pattern: /\b(schilderkunst|schilderij|painting|paintings)\b/i, genres: ['schilderkunst'] },
  { pattern: /\b(beeldhouwkunst|sculptuur|sculpture)\b/i, genres: ['sculpture'] },
  { pattern: /\b(installatie|installation)\b/i, genres: ['installatie'] },
  { pattern: /\b(video[- ]?art|moving image)\b/i, genres: ['video-art'] },
  { pattern: /\b(performance|performans)\b/i, genres: ['performance'] },
];

const LITERATUUR_RULES: KeywordRule[] = [
  { pattern: /\b(poezie|poëzie|poetry|gedicht)\b/i, genres: ['poëzie'] },
  { pattern: /\b(spoken word|voordracht)\b/i, genres: ['spoken-word'] },
  { pattern: /\b(boekpresentatie|book launch|book presentation)\b/i, genres: ['boekpresentatie'] },
];

const CATEGORY_RULES: Record<string, KeywordRule[]> = {
  Theater: THEATER_RULES,
  Muziek: MUZIEK_RULES,
  Lezing: LEZING_RULES,
  Kunst: KUNST_RULES,
  Literatuur: LITERATUUR_RULES,
};

/** Stap 1: pas keyword-regels toe op alle events zonder genres. */
export async function enrichGenresFromKeywords(): Promise<GenreEnrichResult> {
  const rows = await db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      description: schema.events.description,
      category: schema.events.category,
    })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.published, true),
        or(
          isNull(schema.events.genres),
          sql`COALESCE(array_length(${schema.events.genres}, 1), 0) = 0`
        )
      )
    );

  const result: GenreEnrichResult = {
    scanned: rows.length,
    updated: 0,
    unchanged: 0,
  };

  for (const e of rows) {
    const rules = CATEGORY_RULES[e.category];
    if (!rules) {
      result.unchanged += 1;
      continue;
    }
    const haystack = `${e.title} ${e.description ?? ''}`.toLowerCase();
    const matched = new Set<string>();
    for (const rule of rules) {
      if (rule.pattern.test(haystack)) {
        for (const g of rule.genres) matched.add(g);
      }
    }
    if (matched.size === 0) {
      result.unchanged += 1;
      continue;
    }
    await db
      .update(schema.events)
      .set({ genres: [...matched] })
      .where(eq(schema.events.id, e.id));
    result.updated += 1;
  }
  return result;
}

/** Stap 2: AI-fallback voor events die NA stap 1 nog leeg zijn. Skipt
    events zonder description (te weinig context, kost tokens voor
    niets). Hergebruikt enrichEvent uit enrich.ts. */
export async function enrichGenresFromAI(): Promise<GenreEnrichResult> {
  const rows = await db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      description: schema.events.description,
      category: schema.events.category,
      venueName: sql<string>`(SELECT name FROM venues WHERE id = ${schema.events.venueId})`,
    })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.published, true),
        or(
          isNull(schema.events.genres),
          sql`COALESCE(array_length(${schema.events.genres}, 1), 0) = 0`
        )
      )
    );

  const result: GenreEnrichResult = {
    scanned: rows.length,
    updated: 0,
    unchanged: 0,
  };

  for (const e of rows) {
    if (!e.description || e.description.length < 40) {
      // Te weinig signaal voor AI — skip om tokens te besparen.
      result.unchanged += 1;
      continue;
    }
    try {
      const out = await enrichEvent({
        title: e.title,
        description: e.description,
        venueName: e.venueName ?? '',
        venueCategory: e.category,
      });
      if (out.genres.length === 0) {
        result.unchanged += 1;
        continue;
      }
      await db
        .update(schema.events)
        .set({ genres: out.genres })
        .where(eq(schema.events.id, e.id));
      result.updated += 1;
    } catch {
      result.unchanged += 1;
    }
  }
  return result;
}
