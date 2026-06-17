/**
 * Stap [2] DB-laag van de conversationele zoek: de harde tijd-window-query
 * + end-to-end orchestratie. De pure filter/rank-logica staat in
 * retrieval-core.ts (los unit-getest, zonder DB-afhankelijkheid).
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type { PreferenceProfile, ZoekCandidate, ZoekWhen } from './types.js';

import { db, schema } from '../db/index.js';
import {
  candidateMatchesKeywords,
  entityKeywordsOf,
  extractKeywords,
  inferCategories,
  rankCandidates,
  resolveWhenWindow,
  type CandidateRow,
  type RankResult,
  type TimeWindow,
} from './retrieval-core.js';

export * from './retrieval-core.js';

/** Veiligheidslimiet op het aantal events dat we naar JS halen om te ranken.
    Eén rij per event (niet per occurrence), dus dit dekt een week/maand ruim;
    alleen een heel druk jaar-venster raakt 'm. Rijen zijn klein en de
    LLM-input blijft sowieso op MAX_CANDIDATES (25) gecapt. */
const MAX_EVENT_ROWS = 1500;

// ─── DB-query ────────────────────────────────────────────────────────────────

/**
 * Harde tijd-window-query. Cruciaal: **één rij per event** — de vroegste
 * niet-cancelled occurrence binnen [from, to) — via DISTINCT ON. Eerder
 * haalden we de eerste 200 *occurrences* op gesorteerd op tijd; bij een druk
 * venster (films hebben veel voorstellingen) waren dat allemaal de eerste 1–2
 * dagen, waardoor events later in de week (concerten in 't weekend) volledig
 * buiten beeld vielen — "alsof de gids alleen vandaag had". Nu telt de cap
 * events, niet voorstellingen, dus het hele venster komt mee.
 */
export async function fetchCandidateRows(
  profile: PreferenceProfile,
  now: Date
): Promise<CandidateRow[]> {
  const { from, to } = resolveWhenWindow(profile, now);

  const rows = await db
    .selectDistinctOn([schema.occurrences.eventId], {
      eventId: schema.events.id,
      title: schema.events.title,
      category: schema.events.category,
      genres: schema.events.genres,
      startsAt: schema.occurrences.startsAt,
      endsAt: schema.occurrences.endsAt,
      priceCents: schema.occurrences.priceCents,
      lineup: schema.occurrences.lineup,
      venueId: schema.venues.id,
      venueName: schema.venues.name,
      lat: schema.venues.lat,
      lng: schema.venues.lng,
      scene: schema.venues.scene,
      subtype: schema.venues.subtype,
    })
    .from(schema.occurrences)
    .innerJoin(schema.events, eq(schema.occurrences.eventId, schema.events.id))
    .innerJoin(
      schema.venues,
      eq(
        sql`COALESCE(${schema.occurrences.venueId}, ${schema.events.venueId})`,
        schema.venues.id
      )
    )
    .where(
      and(
        eq(schema.events.published, true),
        eq(schema.venues.published, true),
        sql`${schema.occurrences.status} <> 'cancelled'`,
        sql`${schema.occurrences.startsAt} >= ${from.toISOString()}`,
        sql`${schema.occurrences.startsAt} < ${to.toISOString()}`
      )
    )
    // DISTINCT ON vereist dat de ORDER BY met de distinct-kolom begint; de
    // tweede sleutel (startsAt asc) bepaalt dat we de vróégste occurrence per
    // event houden.
    .orderBy(asc(schema.occurrences.eventId), asc(schema.occurrences.startsAt))
    .limit(MAX_EVENT_ROWS);

  return rows.map(mapRow);
}

/** Map een DB-rij (zelfde select-vorm in beide queries) → CandidateRow. */
function mapRow(r: {
  eventId: string;
  title: string;
  category: string;
  genres: string[] | null;
  startsAt: Date;
  endsAt: Date | null;
  priceCents: number | null;
  lineup: Array<{ name: string; artistId?: string }> | null;
  venueId: string;
  venueName: string;
  lat: number;
  lng: number;
  scene: string | null;
  subtype: string[] | null;
}): CandidateRow {
  const lineup = r.lineup ?? [];
  return {
    id: r.eventId,
    title: r.title,
    venueId: r.venueId,
    venueName: r.venueName,
    start: r.startsAt,
    end: r.endsAt,
    category: r.category,
    genres: r.genres ?? [],
    priceCents: r.priceCents,
    lat: r.lat,
    lng: r.lng,
    scene: r.scene,
    subtype: r.subtype ?? [],
    lineup: lineup.map((l) => l.name).filter(Boolean),
    artistIds: lineup.map((l) => l.artistId).filter((id): id is string => Boolean(id)),
    artistGenres: [], // gevuld door enrichArtistGenres()
  };
}

/**
 * Vul `artistGenres` per rij: haal de genre-labels op van alle gelinkte
 * line-up-artiesten (één batch-query) en druppel ze naar het event als
 * sfeer-hint. Zo matcht een clubavond met techno-DJ's ook op "techno", ook
 * zonder eigen genre-tag. Mutatie in-place; no-op als er geen artistId's zijn.
 */
async function enrichArtistGenres(rows: CandidateRow[]): Promise<void> {
  const ids = new Set<string>();
  for (const r of rows) for (const id of r.artistIds) ids.add(id);
  if (ids.size === 0) return;

  const arts = await db
    .select({ id: schema.artists.id, genres: schema.artists.genres })
    .from(schema.artists)
    .where(inArray(schema.artists.id, [...ids]));
  const byId = new Map(arts.map((a) => [a.id, a.genres ?? []]));

  for (const r of rows) {
    if (r.artistIds.length === 0) continue;
    const set = new Set<string>();
    for (const id of r.artistIds) for (const g of byId.get(id) ?? []) set.add(g);
    r.artistGenres = [...set];
  }
}

/** Verrijk de rijen met artiest-genres en rank ze daarna. Gedeeld door alle
    takken van gatherCandidates zodat de doordruppel-stap nooit wordt vergeten. */
async function rankEnriched(
  profile: PreferenceProfile,
  rows: CandidateRow[],
  desiredCategories: string[],
  keywords: string[]
): Promise<RankResult> {
  await enrichArtistGenres(rows);
  return rankCandidates(profile, rows, desiredCategories, keywords);
}

/** Horizon voor een naam/entiteit-lookup: het hele komende jaar. Een vraag
    die een act of zaal bij naam noemt gaat niet over "deze week" maar over
    "het aanbod" — dus zoeken we ver vooruit, los van het browse-venster. */
export const ENTITY_HORIZON_DAYS = 365;
/** Cap op entiteit-matches: ruim genoeg voor alle voorstellingen van één act
    of zaal in een jaar, klein genoeg om de rank-set niet op te blazen. */
const MAX_ENTITY_ROWS = 150;

/**
 * Entiteit-lookup: events waarvan de **titel of venue** één van de
 * trefwoorden bevat, over de komende ~12 maanden — onafhankelijk van het
 * browse-tijdvenster. Dit is wat "treedt Bruno Mars op?" of "wat speelt er in
 * Paradiso?" écht bedoelt: kijk in het hele aanbod, niet alleen vanavond.
 *
 * Bewust GEEN genre-match hier: anders zou "techno" een jaar aan clubavonden
 * naar voren trekken terwijl de gebruiker waarschijnlijk "binnenkort" bedoelt.
 * Genre/sfeer blijft het browse-venster volgen; alleen eigennamen (titel/zaal)
 * reiken ver vooruit.
 */
export async function fetchEntityMatches(
  now: Date,
  keywords: string[]
): Promise<CandidateRow[]> {
  const terms = keywords.filter((k) => k.length >= 4).slice(0, 6);
  if (terms.length === 0) return [];

  const wideTo = new Date(now.getTime() + ENTITY_HORIZON_DAYS * 24 * 3600 * 1000);
  // Match op titel, venue ÉN line-up-namen (DJ's/support/cast). Een headliner
  // zit vaak alleen in de line-up van een clubavond/festival, niet in de titel.
  const likeClauses = terms.map((k) => {
    const pat = '%' + k + '%';
    return sql`(${schema.events.title} ILIKE ${pat} OR ${schema.venues.name} ILIKE ${pat} OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(${schema.occurrences.lineup}, '[]'::jsonb)) le WHERE le->>'name' ILIKE ${pat}))`;
  });
  const orClause = sql.join(likeClauses, sql` OR `);

  const rows = await db
    .selectDistinctOn([schema.occurrences.eventId], {
      eventId: schema.events.id,
      title: schema.events.title,
      category: schema.events.category,
      genres: schema.events.genres,
      startsAt: schema.occurrences.startsAt,
      endsAt: schema.occurrences.endsAt,
      priceCents: schema.occurrences.priceCents,
      lineup: schema.occurrences.lineup,
      venueId: schema.venues.id,
      venueName: schema.venues.name,
      lat: schema.venues.lat,
      lng: schema.venues.lng,
      scene: schema.venues.scene,
      subtype: schema.venues.subtype,
    })
    .from(schema.occurrences)
    .innerJoin(schema.events, eq(schema.occurrences.eventId, schema.events.id))
    .innerJoin(
      schema.venues,
      eq(
        sql`COALESCE(${schema.occurrences.venueId}, ${schema.events.venueId})`,
        schema.venues.id
      )
    )
    .where(
      and(
        eq(schema.events.published, true),
        eq(schema.venues.published, true),
        sql`${schema.occurrences.status} <> 'cancelled'`,
        sql`${schema.occurrences.startsAt} >= ${now.toISOString()}`,
        sql`${schema.occurrences.startsAt} < ${wideTo.toISOString()}`,
        sql`(${orClause})`
      )
    )
    .orderBy(asc(schema.occurrences.eventId), asc(schema.occurrences.startsAt))
    .limit(MAX_ENTITY_ROWS);

  return rows.map(mapRow);
}

/** No-op sinds fetchCandidateRows al één rij per event teruggeeft. Behouden
    voor bestaande call-sites + duidelijkheid. */
export function dedupeByEvent(rows: CandidateRow[]): CandidateRow[] {
  const seen = new Set<string>();
  const out: CandidateRow[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

/** End-to-end retrieval: query → rank (incl. categorie-besef + trefwoorden
    uit het bericht). */
export async function retrieveCandidates(
  profile: PreferenceProfile,
  now: Date,
  message = ''
): Promise<RankResult> {
  const rows = await fetchCandidateRows(profile, now);
  return rankCandidates(
    profile,
    dedupeByEvent(rows),
    inferCategories(message),
    extractKeywords(message)
  );
}

/** Progressieve browse-ladder: begin kort, verbreed alleen als er te weinig
    relevante treffers zijn. */
const BROWSE_LADDER: ZoekWhen[] = ['this_week', 'this_month', 'this_year'];
/** Minimaal aantal ÉCHT relevante treffers voor we stoppen met verbreden. */
const BROWSE_TARGET = 3;

export type GatherResult = {
  candidates: ZoekCandidate[];
  sparse: boolean;
  /** Venster waarbinnen de getoonde events vallen (voor hydrate + UI). */
  window: TimeWindow;
  /** Hoever er uiteindelijk gekeken is (voor de reply / het rapport). */
  when: ZoekWhen;
  /** True als er verder dan het korte startvenster is gekeken. */
  widened: boolean;
};

/**
 * Centrale kandidaat-verzameling voor zowel de in-app gids als de MCP. Drie
 * gedragingen, afhankelijk van de vraag:
 *
 *  1. Expliciete tijd ("dit weekend") → respecteer dat venster, hard.
 *  2. Eigennaam genoemd (act/zaal, "bruno mars", "paradiso") → zoek direct het
 *     hele komende jaar; zo'n vraag gaat over "het aanbod", niet "deze week".
 *  3. Genre/sfeer-browse ("techno", "comedy") → begin kort (deze week) en
 *     verbreed alleen (→ maand → jaar) als er te weinig ÉCHT relevante
 *     treffers zijn. Zo blijft een druk genre dichtbij, maar komt een schaars
 *     genre toch met latere opties terug.
 */
export async function gatherCandidates(
  profile: PreferenceProfile,
  now: Date,
  opts: { message: string; explicitCategories?: string[]; hasExplicitTime: boolean }
): Promise<GatherResult> {
  const desiredCategories =
    opts.explicitCategories && opts.explicitCategories.length > 0
      ? opts.explicitCategories
      : inferCategories(opts.message);
  const keywords = extractKeywords(opts.message);
  const entityKw = entityKeywordsOf(opts.message);

  // 1) Expliciete tijd → honoreer het venster.
  if (opts.hasExplicitTime) {
    const rows = dedupeByEvent(await fetchCandidateRows(profile, now));
    const { candidates, sparse } = await rankEnriched(profile, rows, desiredCategories, keywords);
    return {
      candidates,
      sparse,
      window: resolveWhenWindow(profile, now),
      when: profile.when,
      widened: false,
    };
  }

  // 2) Eigennaam → direct het hele jaar (kort venster + entiteit-treffers).
  // Alléén als de naam érgens als titel/venue voorkomt; matcht 'ie nergens
  // (bv. een onbekend genre-woord dat niet in de vocab staat), dan vallen we
  // terug op de progressieve browse-ladder i.p.v. ruis met een jaar-label.
  if (entityKw.length > 0) {
    const entityRows = await fetchEntityMatches(now, entityKw);
    if (entityRows.length > 0) {
      const nearRows = dedupeByEvent(
        await fetchCandidateRows({ ...profile, when: 'this_week' }, now)
      );
      const merged = dedupeByEvent(nearRows.concat(entityRows));
      const { candidates, sparse } = await rankEnriched(profile, merged, desiredCategories, keywords);
      const to = new Date(now.getTime() + ENTITY_HORIZON_DAYS * 24 * 3600 * 1000);
      return { candidates, sparse, window: { from: now, to }, when: 'this_year', widened: true };
    }
  }

  // 3) Genre/sfeer-browse → progressief verbreden tot genoeg relevants.
  let result: GatherResult | null = null;
  for (const when of BROWSE_LADDER) {
    const p = { ...profile, when };
    const rows = dedupeByEvent(await fetchCandidateRows(p, now));
    const { candidates, sparse } = await rankEnriched(profile, rows, desiredCategories, keywords);
    const relevant = candidates.filter((c) => candidateMatchesKeywords(c, keywords)).length;
    result = {
      candidates,
      sparse,
      window: resolveWhenWindow(p, now),
      when,
      widened: when !== BROWSE_LADDER[0],
    };
    if (relevant >= BROWSE_TARGET) break;
  }
  return result as GatherResult;
}
