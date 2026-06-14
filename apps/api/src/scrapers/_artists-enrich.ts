/**
 * Verrijk de `artists`-tabel met data van MusicBrainz, en link
 * `occurrences.lineup`-items naar de juiste artist-record via een
 * `artistId`-pointer in de JSON-blob.
 *
 * Flow per run (twee stappen):
 *
 *   STAP A — ensure-rows (snel, geen MB):
 *     Elke unieke lineup-naam zonder artist-record krijgt direct
 *     een minimale row (alleen `name`, `enrichedAt: null`). App kan
 *     altijd naar een artist linken, ook voor long-tail-acts die
 *     nog niet bij MB ge-enriched zijn.
 *
 *   STAP B — MB-enrich (langzaam, rate-limited):
 *     Artists met enrichedAt:null (= nooit MB-search gedaan) eerst,
 *     daarna stale rechecks. Sorteert binnen elke groep op aantal
 *     callsites zodat festival-headliners voorrang krijgen.
 *
 *   Patch: alle lineup-items krijgen `artistId`-pointer (ook voor
 *   artists die niet in deze run bij MB zijn opgezocht).
 *
 * Throttle: 3500ms per MB-call (~1029/uur, ruim onder MB's 1200/uur
 * anonymous rate-limit op gedeeld Fly-IP). 503 = stop met logging
 * van x-ratelimit-* headers.
 *
 * Retry-window: artists met enrichedAt jonger dan 7 dagen worden
 * niet opnieuw bij MB gezocht.
 */

import { and, eq, gte, sql } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { isLineupPlaceholderName } from './enrich.js';

const UA = 'Andreas/1.0 ( diederik@wend.nl )';
// MB's anonymous rate-limit is 1200 requests per uur per IP (zie
// x-ratelimit-limit response-header). Per request gemiddeld 3000ms.
// Wij draaien op een shared Fly-IP dus krijgen mogelijk maar een
// deel van dat venster — daarom 3500ms (= 1029/uur, ruim onder cap).
// Eerder stond hier 2500ms (1440/uur) wat structureel boven de cap
// zat → na ~20 calls al 503.
const MB_THROTTLE_MS = 3500;
const RETRY_AFTER_DAYS = 7;

interface MBSearchArtist {
  id: string;
  name: string;
  score: number;
}

interface MBUrlRel {
  type: string;
  url: { resource: string };
}

interface MBArtistDetail {
  id: string;
  name: string;
  disambiguation?: string;
  relations?: MBUrlRel[];
  tags?: Array<{ name: string; count: number }>;
}

type FetchOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; fatal: boolean };

async function mbFetch<T>(url: string): Promise<FetchOutcome<T>> {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (r.status === 503) {
      // Log MB's rate-limit-headers zodat we bij een onverwachte 503
      // weten of we boven de cap zaten of dat MB iets anders deed.
      const limit = r.headers.get('x-ratelimit-limit');
      const remaining = r.headers.get('x-ratelimit-remaining');
      const reset = r.headers.get('x-ratelimit-reset');
      const retryAfter = r.headers.get('retry-after');
      console.warn(
        '[mb] 503 fatal — rate-limit=%s remaining=%s reset=%s retry-after=%s',
        limit ?? '?', remaining ?? '?', reset ?? '?', retryAfter ?? '?',
      );
      return { ok: false, fatal: true };
    }
    if (!r.ok) return { ok: false, fatal: false };
    return { ok: true, data: (await r.json()) as T };
  } catch {
    return { ok: false, fatal: false };
  }
}

/** Slug uit een artist-name: lowercase, diacritics weg, niet-alphanum
    naar '-'. Voor de PK van `artists`. Korte hash-suffix voorkomt
    collisions tussen twee artists met dezelfde slug (zeldzaam). */
function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return base || 'artist';
}

function findUrl(
  rels: MBUrlRel[] | undefined,
  predicate: (url: string, type: string) => boolean
): string | null {
  if (!rels) return null;
  for (const rel of rels) {
    const u = rel.url?.resource;
    if (u && predicate(u, rel.type ?? '')) return u;
  }
  return null;
}

interface MbEnrichmentData {
  mbid: string | null;
  spotifyUrl: string | null;
  appleMusicUrl: string | null;
  bandcampUrl: string | null;
  youtubeUrl: string | null;
  officialUrl: string | null;
  description: string | null;
  genres: string[];
}

const EMPTY_ENRICH: MbEnrichmentData = {
  mbid: null, spotifyUrl: null, appleMusicUrl: null, bandcampUrl: null,
  youtubeUrl: null, officialUrl: null, description: null, genres: [],
};

async function searchAndFetchMb(name: string): Promise<MbEnrichmentData | 'fatal'> {
  // Stap 1: search → MBID
  const q = encodeURIComponent(`artist:"${name}"`);
  const searchRes = await mbFetch<{ artists: MBSearchArtist[] }>(
    `https://musicbrainz.org/ws/2/artist?query=${q}&limit=5&fmt=json`
  );
  if (!searchRes.ok) return searchRes.fatal ? 'fatal' : EMPTY_ENRICH;
  const sorted = (searchRes.data.artists ?? [])
    .filter((a) => a.score >= 80)
    .sort((a, b) => b.score - a.score);
  if (sorted.length === 0) return EMPTY_ENRICH;
  await new Promise((r) => setTimeout(r, MB_THROTTLE_MS));

  // Stap 2: lookup met url-rels + tags
  const lookup = await mbFetch<MBArtistDetail>(
    `https://musicbrainz.org/ws/2/artist/${sorted[0].id}?inc=url-rels+tags&fmt=json`
  );
  if (!lookup.ok) {
    if (lookup.fatal) return 'fatal';
    return { ...EMPTY_ENRICH, mbid: sorted[0].id };
  }
  await new Promise((r) => setTimeout(r, MB_THROTTLE_MS));

  const rels = lookup.data.relations;
  return {
    mbid: lookup.data.id,
    spotifyUrl: findUrl(rels, (u) => /open\.spotify\.com\/artist\//.test(u)),
    appleMusicUrl: findUrl(rels, (u) => /music\.apple\.com\/[a-z]{2}\/artist\//.test(u)),
    bandcampUrl: findUrl(rels, (u) => /\.bandcamp\.com/.test(u)),
    youtubeUrl: findUrl(rels, (u) => /youtube\.com\/(channel|@|user)\//.test(u)),
    officialUrl: findUrl(
      rels,
      (u, t) =>
        t === 'official homepage' &&
        !/wikipedia|wikidata|discogs|musicbrainz|last\.fm|allmusic|spotify|apple|bandcamp|youtube/.test(u)
    ),
    description: lookup.data.disambiguation ?? null,
    genres: (lookup.data.tags ?? [])
      .filter((t) => t.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map((t) => t.name),
  };
}

export interface ArtistsEnrichResult {
  uniqueNames: number;
  alreadyEnriched: number;
  searched: number;
  mbHit: number;
  artistsInserted: number;
  artistsUpdated: number;
  lineupItemsLinked: number;
  occurrencesUpdated: number;
  fatalEarlyStop: boolean;
}

type LineupItem = {
  name: string;
  role?: 'dj' | 'support' | 'headliner' | 'act';
  artistId?: string;
};

/**
 * Hoofdfunctie. `limit` voor lokale dry-tests; in productie zonder
 * limit (cron). Tegen prod-data is dit ~10 minuten als alle nieuwe
 * artists nog niet bestaan.
 */
export async function enrichLineupArtists(
  limit?: number
): Promise<ArtistsEnrichResult> {
  const result: ArtistsEnrichResult = {
    uniqueNames: 0,
    alreadyEnriched: 0,
    searched: 0,
    mbHit: 0,
    artistsInserted: 0,
    artistsUpdated: 0,
    lineupItemsLinked: 0,
    occurrencesUpdated: 0,
    fatalEarlyStop: false,
  };

  // Pak alle muziek-occurrences met een lineup en een toekomstige
  // startsAt. We lopen alleen forward-looking events na — historisch
  // werk is niet meer relevant voor de UX.
  const occRows = await db
    .select({
      id: schema.occurrences.id,
      lineup: schema.occurrences.lineup,
    })
    .from(schema.occurrences)
    .innerJoin(schema.events, eq(schema.events.id, schema.occurrences.eventId))
    .where(
      and(
        eq(schema.events.category, 'Muziek'),
        eq(schema.events.kind, 'show'),
        gte(schema.occurrences.startsAt, sql`NOW()`),
        sql`${schema.occurrences.lineup} IS NOT NULL`,
        sql`jsonb_array_length(${schema.occurrences.lineup}) > 0`
      )
    );

  // Unieke namen verzamelen (case-insensitive). Per naam onthouden
  // welke (occId, itemIdx) we straks moeten patchen.
  const nameToCallsites = new Map<
    string,
    { lower: string; original: string; sites: Array<{ occId: string; idx: number }> }
  >();
  for (const occ of occRows) {
    const lineup = (occ.lineup ?? []) as LineupItem[];
    lineup.forEach((item, idx) => {
      const raw = item?.name?.trim();
      if (!raw) return;
      // Defense-in-depth: ook al filtert enrich.ts placeholders al weg,
      // we skippen ze hier ook zodat we geen MB-search doen op "support"
      // en geen artist-record aanmaken voor een woord dat geen naam is.
      if (isLineupPlaceholderName(raw)) return;
      const lower = raw.toLowerCase();
      const entry = nameToCallsites.get(lower);
      if (entry) {
        entry.sites.push({ occId: occ.id, idx });
      } else {
        nameToCallsites.set(lower, {
          lower,
          original: raw,
          sites: [{ occId: occ.id, idx }],
        });
      }
    });
  }
  result.uniqueNames = nameToCallsites.size;

  // Welke namen hebben we al in de artists-tabel (matched op
  // case-insensitive name)? Eén SELECT in plaats van N.
  const allArtists = await db
    .select({
      id: schema.artists.id,
      name: schema.artists.name,
      enrichedAt: schema.artists.enrichedAt,
    })
    .from(schema.artists);
  const existingByLower = new Map(
    allArtists.map((a) => [a.name.toLowerCase(), a])
  );

  // ─── STAP A: ensure-rows ──────────────────────────────────────────
  // Elke unieke lineup-naam zonder artist-record krijgt direct een
  // minimale row (alleen `name`, `enrichedAt: null`). Snel, geen MB-
  // call, geen rate-limit. Doel: app kan altijd naar een artist
  // linken, ook voor long-tail-acts die nog niet bij MB ge-enriched
  // zijn. Stap B (verderop) doet de MB-data daarna binnen.
  const entries = [...nameToCallsites.values()];
  const resolved = new Map<string, string>(); // lower → artistId

  for (const entry of entries) {
    const ex = existingByLower.get(entry.lower);
    if (ex) {
      resolved.set(entry.lower, ex.id);
      continue;
    }
    const id = `${slugify(entry.original)}-${Math.random().toString(36).slice(2, 6)}`;
    try {
      await db.insert(schema.artists).values({
        id,
        name: entry.original,
        enrichedAt: null, // signal: nog niet bij MB gezocht
      });
      existingByLower.set(entry.lower, {
        id,
        name: entry.original,
        enrichedAt: null,
      });
      resolved.set(entry.lower, id);
      result.artistsInserted += 1;
    } catch {
      // Race: parallelle insert won. Re-select case-insensitive.
      const [now] = await db
        .select({
          id: schema.artists.id,
          name: schema.artists.name,
          enrichedAt: schema.artists.enrichedAt,
        })
        .from(schema.artists)
        .where(sql`LOWER(${schema.artists.name}) = ${entry.lower}`)
        .limit(1);
      if (now) {
        existingByLower.set(entry.lower, now);
        resolved.set(entry.lower, now.id);
      }
    }
  }

  // ─── STAP B: MB-enrich ────────────────────────────────────────────
  // Pak artists waar enrichedAt IS NULL (nooit gezocht) OF stale.
  // Sorteer "nog-niet-enriched" eerst, dan stale, binnen op aantal
  // callsites. Limit cap'd door de MB-rate-limit (1029/uur).
  const todo = entries
    .filter((e) => {
      const ex = existingByLower.get(e.lower);
      if (!ex) return false; // safety — stap A heeft deze net gezet
      const stale =
        !ex.enrichedAt ||
        ex.enrichedAt.getTime() < Date.now() - RETRY_AFTER_DAYS * 86_400_000;
      return stale;
    })
    .sort((a, b) => {
      // 1. Nooit-enriched (enrichedAt:null) eerst — daar is MB-data
      //    helemaal nieuw. Stale-rechecks daarna.
      const aFresh = existingByLower.get(a.lower)?.enrichedAt == null;
      const bFresh = existingByLower.get(b.lower)?.enrichedAt == null;
      if (aFresh !== bFresh) return aFresh ? -1 : 1;
      // 2. Binnen elke groep: meeste callsites eerst (festival-
      //    headliners vóór eenmalige supports).
      if (b.sites.length !== a.sites.length) return b.sites.length - a.sites.length;
      // 3. Stabiele tie-break.
      return a.lower.localeCompare(b.lower);
    })
    .slice(0, limit ?? Number.MAX_SAFE_INTEGER);

  // Tel niet-stale artists die geen MB-call meer nodig hebben.
  result.alreadyEnriched = entries.length - todo.length - result.artistsInserted;

  for (let i = 0; i < todo.length; i += 1) {
    const entry = todo[i];
    const existing = existingByLower.get(entry.lower);
    if (!existing) continue; // safety

    result.searched += 1;
    const data = await searchAndFetchMb(entry.original);
    if (data === 'fatal') {
      result.fatalEarlyStop = true;
      break;
    }
    if (data.mbid) result.mbHit += 1;
    try {
      await db
        .update(schema.artists)
        .set({
          mbid: data.mbid,
          description: data.description ?? null,
          spotifyUrl: data.spotifyUrl,
          appleMusicUrl: data.appleMusicUrl,
          bandcampUrl: data.bandcampUrl,
          youtubeUrl: data.youtubeUrl,
          officialUrl: data.officialUrl,
          genres: data.genres,
          enrichedAt: new Date(),
        })
        .where(eq(schema.artists.id, existing.id));
    } catch {
      // Unique-violation op mbid: deze MB-record hangt al aan een
      // andere artist-row (bv. NL/EN-spelling van dezelfde act).
      // Update zonder mbid zodat de overige enrich-data wel landt.
      await db
        .update(schema.artists)
        .set({
          description: data.description ?? null,
          spotifyUrl: data.spotifyUrl,
          appleMusicUrl: data.appleMusicUrl,
          bandcampUrl: data.bandcampUrl,
          youtubeUrl: data.youtubeUrl,
          officialUrl: data.officialUrl,
          genres: data.genres,
          enrichedAt: new Date(),
        })
        .where(eq(schema.artists.id, existing.id));
    }
    result.artistsUpdated += 1;

    if ((i + 1) % 25 === 0) {
      console.log(
        `  …${i + 1}/${todo.length}  searched=${result.searched} mb-hit=${result.mbHit}`
      );
    }
  }

  // Patch lineup-JSON met artistId voor elke resolved naam. Eén
  // UPDATE per occurrence (jsonb_set zou per-element zijn — TS-side
  // rewrite is leesbaarder).
  const touched = new Set<string>();
  for (const occ of occRows) {
    const lineup = (occ.lineup ?? []) as LineupItem[];
    let changed = false;
    const next = lineup.map((item) => {
      const lower = item?.name?.trim()?.toLowerCase();
      if (!lower) return item;
      const artistId = resolved.get(lower);
      if (artistId && item.artistId !== artistId) {
        changed = true;
        return { ...item, artistId };
      }
      return item;
    });
    if (changed) {
      await db
        .update(schema.occurrences)
        .set({ lineup: next })
        .where(eq(schema.occurrences.id, occ.id));
      result.lineupItemsLinked += next.filter((i) => i.artistId).length;
      touched.add(occ.id);
    }
  }
  result.occurrencesUpdated = touched.size;

  return result;
}
