/**
 * Verrijk de `artists`-tabel met data van MusicBrainz, en link
 * `occurrences.lineup`-items naar de juiste artist-record via een
 * `artistId`-pointer in de JSON-blob.
 *
 * Flow per run:
 *   1. Verzamel alle unieke `lineup[i].name`-waarden uit Muziek-
 *      occurrences die nog een toekomstige startsAt hebben.
 *   2. Per unieke naam (case-insensitive):
 *        a. Bestaat al een artist-row? → hergebruik die id.
 *        b. Anders: MB-search → artist-record maken met URL-rels.
 *        c. Bij geen MB-match: maak alsnog een record (alleen naam),
 *           zet enrichedAt zodat we 'm niet morgen opnieuw zoeken.
 *   3. Update alle lineup-items met de gevonden artistId.
 *
 * Throttle: 1500ms per MB-call (rate-limit = 1/sec, we doen 1/1.5s
 * voor jitter). 503 = stop immediately (MB flagged ons).
 *
 * Retry-window: artists met enrichedAt jonger dan 7 dagen worden
 * niet opnieuw bij MB gezocht — alleen lineup-links worden
 * bijgewerkt voor nieuwe events.
 */

import { and, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';

import { db, schema } from '../db/index.js';

const UA = 'Andreas/1.0 ( diederik@wend.nl )';
const MB_THROTTLE_MS = 1500;
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
    if (r.status === 503) return { ok: false, fatal: true };
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

  // Worklist: per unieke naam → existing record OR need MB-lookup.
  const entries = [...nameToCallsites.values()];
  const todo = limit ? entries.slice(0, limit) : entries;

  // Resolved namen → artistId (voor de lineup-patch-stap).
  const resolved = new Map<string, string>(); // lower → artistId

  for (let i = 0; i < todo.length; i += 1) {
    const entry = todo[i];
    const existing = existingByLower.get(entry.lower);

    if (existing) {
      // Hergebruik. Eventueel re-enrich als 'ie ouder dan retry-window
      // is, voor het geval MB-community ondertussen meer links toevoegde.
      const enrichedAt = existing.enrichedAt;
      const stale =
        !enrichedAt ||
        enrichedAt.getTime() < Date.now() - RETRY_AFTER_DAYS * 86_400_000;
      if (!stale) {
        result.alreadyEnriched += 1;
        resolved.set(entry.lower, existing.id);
        continue;
      }
      // Stale: opnieuw bij MB zoeken om eventuele nieuwe links.
      result.searched += 1;
      const data = await searchAndFetchMb(entry.original);
      if (data === 'fatal') {
        result.fatalEarlyStop = true;
        break;
      }
      if (data.mbid) result.mbHit += 1;
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
      result.artistsUpdated += 1;
      resolved.set(entry.lower, existing.id);
    } else {
      // Nieuw — eerst MB-zoeken, dan record maken.
      result.searched += 1;
      const data = await searchAndFetchMb(entry.original);
      if (data === 'fatal') {
        result.fatalEarlyStop = true;
        break;
      }
      if (data.mbid) result.mbHit += 1;
      const id = `${slugify(entry.original)}-${Math.random().toString(36).slice(2, 6)}`;
      try {
        await db.insert(schema.artists).values({
          id,
          name: entry.original,
          mbid: data.mbid,
          description: data.description ?? null,
          spotifyUrl: data.spotifyUrl,
          appleMusicUrl: data.appleMusicUrl,
          bandcampUrl: data.bandcampUrl,
          youtubeUrl: data.youtubeUrl,
          officialUrl: data.officialUrl,
          genres: data.genres,
          enrichedAt: new Date(),
        });
        result.artistsInserted += 1;
        resolved.set(entry.lower, id);
      } catch (e) {
        // MBID-uniqueness race: een andere parallelle insert ving 'm
        // al op. Re-select. Niet fataal.
        const [existingNow] = await db
          .select({ id: schema.artists.id })
          .from(schema.artists)
          .where(
            data.mbid
              ? eq(schema.artists.mbid, data.mbid)
              : sql`LOWER(${schema.artists.name}) = ${entry.lower}`
          )
          .limit(1);
        if (existingNow) resolved.set(entry.lower, existingNow.id);
      }
    }

    if ((i + 1) % 25 === 0) {
      console.log(
        `  …${i + 1}/${todo.length}  searched=${result.searched} mb-hit=${result.mbHit} inserted=${result.artistsInserted}`
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
