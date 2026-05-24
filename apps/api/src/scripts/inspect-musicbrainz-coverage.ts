/**
 * Read-only test: hoeveel van onze concerten matched MusicBrainz aan
 * een artist, en hoeveel van die hits hebben een Spotify- en/of
 * Apple Music-URL als external relationship?
 *
 * Waarom MusicBrainz over Spotify/iTunes:
 *   - CC0 license — opslaan van URLs in onze DB is expliciet OK
 *   - Geen API-key, geen quota; alleen 1 req/sec per IP rate-limit
 *   - Eén bron levert links naar Spotify, Apple Music, Bandcamp,
 *     YouTube, Wikipedia, official website — alles in de
 *     "url-rels"-relationships op een artist-record
 *
 * Voorzichtigheid:
 *   - Verplichte User-Agent met contact-string (anders direct 503)
 *   - 1500ms throttle (50% boven de docs-rate)
 *   - Stop bij eerste 503 — MB flagged misbruikers handmatig
 *   - --limit=N voor sanity-check
 *
 * Gebruik:
 *   pnpm tsx --env-file=.env src/scripts/inspect-musicbrainz-coverage.ts --limit=20
 *   pnpm tsx --env-file=.env src/scripts/inspect-musicbrainz-coverage.ts
 */

import { and, eq, gte, sql } from 'drizzle-orm';

import { db, schema } from '../db/index.js';

const UA = 'Andreas/1.0 ( diederik@wend.nl )';
const LIMIT_ARG = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.slice('--limit='.length), 10) : null;

interface MBSearchArtist {
  id: string;
  name: string;
  score: number;
  disambiguation?: string;
  country?: string;
}

interface MBSearchResponse {
  artists: MBSearchArtist[];
}

interface MBUrlRel {
  type: string;
  url: { resource: string };
}

interface MBArtistDetail {
  id: string;
  name: string;
  relations?: MBUrlRel[];
}

function cleanTitle(title: string): string {
  return title
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+\+\s+support.*$/i, '')
    .replace(/\s+supp(ort|orting)\s+.*$/i, '')
    .replace(/\s+(?:—|-)?\s*live\s+(?:at|in|op|@)\s+.*$/i, '')
    .replace(/\s+(?:—|-)\s+live\s*$/i, '')
    .replace(/^.+\bpresents?\b\s*:\s*/i, '')
    .replace(/\s+(?:—|-)\s+.+\b(?:tour|tournee|concert)\b.*$/i, '')
    .replace(/\s+(?:\||—|-)\s+(?:paradiso|melkweg|bimhuis|q-factory|patronaat|tolhuistuin|concertgebouw|afas|olympic|ziggo|ahoy).*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 'fatal' = stop het hele script (503 of network-storm). */
type FetchOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; status?: number; fatal: boolean };

async function mbFetch<T>(url: string): Promise<FetchOutcome<T>> {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (r.status === 503) return { ok: false, status: 503, fatal: true };
    if (!r.ok) return { ok: false, status: r.status, fatal: false };
    return { ok: true, data: (await r.json()) as T };
  } catch {
    return { ok: false, fatal: false };
  }
}

async function searchArtist(title: string): Promise<MBSearchArtist | null | 'fatal'> {
  const q = encodeURIComponent(`artist:"${title}"`);
  const res = await mbFetch<MBSearchResponse>(
    `https://musicbrainz.org/ws/2/artist?query=${q}&limit=5&fmt=json`
  );
  if (!res.ok) return res.fatal ? 'fatal' : null;
  if (!res.data.artists || res.data.artists.length === 0) return null;
  // MB returns a `score` (0-100) per match. Pak de hoogste, en eis
  // tenminste 80 — anders is 't fuzzy en waarschijnlijk fout.
  const sorted = [...res.data.artists].sort((a, b) => b.score - a.score);
  if (sorted[0].score < 80) return null;
  return sorted[0];
}

async function lookupRelations(mbid: string): Promise<MBArtistDetail | null | 'fatal'> {
  const res = await mbFetch<MBArtistDetail>(
    `https://musicbrainz.org/ws/2/artist/${mbid}?inc=url-rels&fmt=json`
  );
  if (!res.ok) return res.fatal ? 'fatal' : null;
  return res.data;
}

function findUrl(rels: MBUrlRel[] | undefined, predicate: (url: string) => boolean): string | null {
  if (!rels) return null;
  for (const rel of rels) {
    const u = rel.url?.resource;
    if (u && predicate(u)) return u;
  }
  return null;
}

interface LineupItem {
  name: string;
  role?: 'dj' | 'support' | 'headliner' | 'act';
}

/** Kies de "primaire" artist uit een lineup: eerst expliciete
 *  headliner, anders eerste 'act'/'dj', anders eerste in de array. */
function pickPrimaryArtist(lineup: LineupItem[] | null | undefined): string | null {
  if (!lineup || lineup.length === 0) return null;
  const headliner = lineup.find((l) => l.role === 'headliner');
  if (headliner?.name) return headliner.name.trim();
  const act = lineup.find((l) => l.role === 'act' || l.role === 'dj');
  if (act?.name) return act.name.trim();
  return lineup[0]?.name?.trim() ?? null;
}

async function main() {
  // We willen events MET een lineup. Trek per event de meest-vroege
  // occurrence (binnen het 14-dagen-venster) en haal de lineup
  // daarvandaan. Filteren we event.id distinct zodat een multi-day
  // residency niet vaker wordt bevraagd dan nodig.
  let q = db
    .selectDistinct({
      id: schema.events.id,
      title: schema.events.title,
      venueId: schema.events.venueId,
      venueType: schema.venues.type,
      lineup: schema.occurrences.lineup,
    })
    .from(schema.events)
    .innerJoin(schema.venues, eq(schema.events.venueId, schema.venues.id))
    .innerJoin(schema.occurrences, eq(schema.occurrences.eventId, schema.events.id))
    .where(
      and(
        eq(schema.events.category, 'Muziek'),
        eq(schema.events.kind, 'show'),
        gte(schema.occurrences.startsAt, sql`NOW()`),
        sql`${schema.occurrences.startsAt} < NOW() + INTERVAL '14 days'`,
        sql`${schema.occurrences.lineup} IS NOT NULL`,
        sql`jsonb_array_length(${schema.occurrences.lineup}) > 0`
      )
    )
    .$dynamic();
  if (LIMIT) q = q.limit(LIMIT);
  const events = await q;

  console.log(`Scanning ${events.length} Muziek-events MET lineup tegen MusicBrainz...\n`);
  console.log('(throttle: 1500ms / call, ~2 calls per event, lineup-primary-artist als search-term)\n');

  const stats = {
    total: events.length,
    searched: 0,
    artistHit: 0,
    relationsFetched: 0,
    hasSpotify: 0,
    hasAppleMusic: 0,
    hasBandcamp: 0,
    hasYoutube: 0,
    hasOfficial: 0,
    hasAny: 0,
    miss: 0,
    fatalAt: -1,
  };
  const hits: Array<{
    title: string;
    clean: string;
    matched: string;
    score: number;
    spotify: string | null;
    appleMusic: string | null;
    bandcamp: string | null;
    youtube: string | null;
  }> = [];
  const misses: Array<{ title: string; clean: string }> = [];

  for (let i = 0; i < events.length; i += 1) {
    const e = events[i];
    const artistName = pickPrimaryArtist(e.lineup as LineupItem[] | null);
    if (!artistName) {
      stats.miss += 1;
      misses.push({ title: e.title, clean: '(geen lineup)' });
      continue;
    }
    const clean = cleanTitle(artistName);
    if (!clean) {
      stats.miss += 1;
      misses.push({ title: e.title, clean });
      continue;
    }
    stats.searched += 1;

    const searchRes = await searchArtist(clean);
    if (searchRes === 'fatal') {
      console.log(`\n⚠ 503 — MusicBrainz flagged ons. Stoppen op event ${i + 1}.`);
      stats.fatalAt = i + 1;
      break;
    }
    await new Promise((r) => setTimeout(r, 1500));

    if (!searchRes) {
      stats.miss += 1;
      misses.push({ title: e.title, clean });
      if ((i + 1) % 20 === 0) {
        console.log(`  …${i + 1}/${events.length}  hits=${stats.artistHit}/${stats.searched}  spotify=${stats.hasSpotify}`);
      }
      continue;
    }

    stats.artistHit += 1;

    const detail = await lookupRelations(searchRes.id);
    if (detail === 'fatal') {
      console.log(`\n⚠ 503 — MusicBrainz flagged ons. Stoppen op event ${i + 1}.`);
      stats.fatalAt = i + 1;
      break;
    }
    await new Promise((r) => setTimeout(r, 1500));

    if (!detail) {
      hits.push({
        title: e.title,
        clean,
        matched: searchRes.name,
        score: searchRes.score,
        spotify: null,
        appleMusic: null,
        bandcamp: null,
        youtube: null,
      });
      continue;
    }

    stats.relationsFetched += 1;
    const rels = detail.relations;
    const spotify = findUrl(rels, (u) => /open\.spotify\.com\/artist\//.test(u));
    const appleMusic = findUrl(rels, (u) => /music\.apple\.com\/[a-z]{2}\/artist\//.test(u));
    const bandcamp = findUrl(rels, (u) => /\.bandcamp\.com/.test(u));
    const youtube = findUrl(rels, (u) => /youtube\.com\/(channel|@|user)\//.test(u));
    const official = findUrl(rels, (u) => /^https?:\/\/(?!.*\b(spotify|apple|bandcamp|youtube|wikipedia|wikidata|discogs|musicbrainz|last\.fm|allmusic)\b)/.test(u));

    if (spotify) stats.hasSpotify += 1;
    if (appleMusic) stats.hasAppleMusic += 1;
    if (bandcamp) stats.hasBandcamp += 1;
    if (youtube) stats.hasYoutube += 1;
    if (official) stats.hasOfficial += 1;
    if (spotify || appleMusic) stats.hasAny += 1;

    hits.push({
      title: e.title,
      clean,
      matched: searchRes.name,
      score: searchRes.score,
      spotify,
      appleMusic,
      bandcamp,
      youtube,
    });

    if ((i + 1) % 20 === 0) {
      console.log(`  …${i + 1}/${events.length}  hits=${stats.artistHit}/${stats.searched}  spotify=${stats.hasSpotify}  apple=${stats.hasAppleMusic}`);
    }
  }

  console.log('\n=== MusicBrainz dekkings-rapport ===');
  console.log(`Totaal events:           ${stats.total}`);
  console.log(`Gezocht:                 ${stats.searched}`);
  console.log(`Artist-hit (score≥80):   ${stats.artistHit} (${pct(stats.artistHit, stats.searched)})`);
  console.log(`Met Spotify-URL:         ${stats.hasSpotify} (${pct(stats.hasSpotify, stats.total)})`);
  console.log(`Met Apple Music-URL:     ${stats.hasAppleMusic} (${pct(stats.hasAppleMusic, stats.total)})`);
  console.log(`Met Bandcamp-URL:        ${stats.hasBandcamp}`);
  console.log(`Met YouTube-channel:     ${stats.hasYoutube}`);
  console.log(`Met official website:    ${stats.hasOfficial}`);
  console.log(`Spotify of Apple:        ${stats.hasAny} (${pct(stats.hasAny, stats.total)})`);
  if (stats.fatalAt >= 0) {
    console.log(`\n⚠ Vroegtijdig gestopt op event ${stats.fatalAt} door 503.`);
  }

  console.log('\n=== Sample 15 hits met Spotify+Apple Music ===');
  const richHits = hits.filter((h) => h.spotify && h.appleMusic).slice(0, 15);
  for (const h of richHits) {
    console.log(`  "${h.title}" → "${h.matched}" (score=${h.score})`);
    console.log(`    Spotify: ${h.spotify}`);
    console.log(`    Apple:   ${h.appleMusic}`);
  }

  console.log('\n=== Sample 10 artist-hits zonder Spotify-URL ===');
  const onlyMatched = hits.filter((h) => !h.spotify).slice(0, 10);
  for (const h of onlyMatched) {
    console.log(`  "${h.title}" → "${h.matched}" — geen Spotify, wel Apple=${!!h.appleMusic} Bandcamp=${!!h.bandcamp}`);
  }

  console.log('\n=== Sample 15 misses ===');
  for (const m of misses.slice(0, 15)) {
    const cleaned = m.clean !== m.title ? ` → "${m.clean}"` : '';
    console.log(`  "${m.title}"${cleaned}`);
  }

  process.exit(0);
}

function pct(part: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.round((part / total) * 1000) / 10}%`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
