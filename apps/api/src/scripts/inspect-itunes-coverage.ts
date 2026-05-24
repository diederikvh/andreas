/**
 * Read-only test: hoeveel van onze concerten matched iTunes Search
 * API aan een Apple Music artist? Geen API-key, geen quota (zo open
 * als 't kan). Schrijft NIETS naar de DB.
 *
 * Doel: zien of dit een werkbaar alternatief is voor Spotify (waar we
 * tegen de default-quota aanliepen). Bonus: Apple Music heeft per
 * song een 30s preview-MP3 die we via expo-av/expo-audio kunnen
 * afspelen — geen WebView nodig.
 */

import { and, eq, gte, sql } from 'drizzle-orm';

import { db, schema } from '../db/index.js';

const UA = 'AndreasBot/1.0 (+https://andreas.amsterdam)';

interface ItunesArtistResult {
  wrapperType: 'artist';
  artistType?: string;
  artistName: string;
  artistId: number;
  artistLinkUrl?: string;
  primaryGenreName?: string;
  primaryGenreId?: number;
}

interface ItunesSearchResponse {
  resultCount: number;
  results: ItunesArtistResult[];
}

/** Zelfde aanpak als Spotify-cleaning. */
function cleanTitleForItunes(title: string): string {
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

async function searchArtist(title: string): Promise<ItunesArtistResult | null> {
  try {
    const params = new URLSearchParams({
      term: title,
      entity: 'musicArtist',
      limit: '5',
      country: 'NL',
    });
    const r = await fetch(
      `https://itunes.apple.com/search?${params}`,
      {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(10000),
      }
    );
    if (!r.ok) return null;
    const data = (await r.json()) as ItunesSearchResponse;
    if (!data.results || data.results.length === 0) return null;
    const needle = title.toLowerCase().trim();
    const exact = data.results.filter(
      (a) => a.artistName?.toLowerCase().trim() === needle
    );
    const pool = exact.length > 0 ? exact : data.results;
    // iTunes heeft geen "popularity" — neem de eerste (=meest
    // relevante volgens hun ranking).
    return pool[0];
  } catch {
    return null;
  }
}

async function main() {
  const events = await db
    .selectDistinct({
      id: schema.events.id,
      title: schema.events.title,
      venueId: schema.events.venueId,
      venueType: schema.venues.type,
    })
    .from(schema.events)
    .innerJoin(schema.venues, eq(schema.events.venueId, schema.venues.id))
    .innerJoin(schema.occurrences, eq(schema.occurrences.eventId, schema.events.id))
    .where(
      and(
        eq(schema.events.category, 'Muziek'),
        eq(schema.events.kind, 'show'),
        gte(schema.occurrences.startsAt, sql`NOW()`),
        sql`${schema.occurrences.startsAt} < NOW() + INTERVAL '14 days'`
      )
    );

  console.log(`Scanning ${events.length} Muziek-events tegen iTunes...\n`);

  const stats = {
    total: events.length,
    podium: 0,
    club: 0,
    other: 0,
    searched: 0,
    hit: 0,
    hitExactMatch: 0,
    miss: 0,
  };
  const hits: Array<{
    title: string;
    clean: string;
    matched: string;
    genre: string;
    url: string;
    venueType: string | null;
    exact: boolean;
  }> = [];
  const misses: Array<{ title: string; clean: string; venueType: string | null }> = [];

  let i = 0;
  for (const e of events) {
    i += 1;
    if (e.venueType === 'podium') stats.podium += 1;
    else if (e.venueType === 'club') stats.club += 1;
    else stats.other += 1;

    const clean = cleanTitleForItunes(e.title);
    if (!clean) {
      stats.miss += 1;
      misses.push({ title: e.title, clean, venueType: e.venueType });
      continue;
    }
    stats.searched += 1;

    const artist = await searchArtist(clean);
    if (!artist) {
      stats.miss += 1;
      misses.push({ title: e.title, clean, venueType: e.venueType });
    } else {
      stats.hit += 1;
      const exact = artist.artistName?.toLowerCase().trim() === clean.toLowerCase().trim();
      if (exact) stats.hitExactMatch += 1;
      hits.push({
        title: e.title,
        clean,
        matched: artist.artistName,
        genre: artist.primaryGenreName ?? '',
        url: artist.artistLinkUrl ?? `https://music.apple.com/artist/${artist.artistId}`,
        venueType: e.venueType,
        exact,
      });
    }
    if (i % 25 === 0) {
      process.stdout.write(`  …${i}/${events.length}  hits=${stats.hit}\n`);
    }
    // iTunes heeft geen publieke rate-limit-info maar Apple's docs
    // suggereren ~20 calls per minuut per IP voor de search-API in
    // unauthenticated mode. 300ms throttle = 200/min — ruim onder.
    // In praktijk werkt veel meer ook (geen 429 ervaring).
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log('\n=== iTunes dekkings-rapport ===');
  console.log(`Totaal Muziek-events:    ${stats.total}`);
  console.log(`  ↳ podium:              ${stats.podium}`);
  console.log(`  ↳ club:                ${stats.club}`);
  console.log(`  ↳ overig:              ${stats.other}`);
  console.log(`Hits:                    ${stats.hit} (${pct(stats.hit, stats.total)})`);
  console.log(`  ↳ exact name match:    ${stats.hitExactMatch} (${pct(stats.hitExactMatch, stats.total)})`);
  console.log(`Misses:                  ${stats.miss} (${pct(stats.miss, stats.total)})`);

  console.log('\n=== Sample 15 exact-match hits ===');
  const exactHits = hits.filter((h) => h.exact).slice(0, 15);
  for (const h of exactHits) {
    console.log(`  "${h.title}" → "${h.matched}" [${h.genre}] (${h.venueType})`);
    console.log(`    ${h.url}`);
  }

  console.log('\n=== Sample 10 fuzzy-match hits (mogelijk false positives) ===');
  const fuzzyHits = hits.filter((h) => !h.exact).slice(0, 10);
  for (const h of fuzzyHits) {
    console.log(`  "${h.title}" → "${h.matched}" [${h.genre}]`);
  }

  console.log('\n=== Sample 15 misses ===');
  for (const m of misses.slice(0, 15)) {
    const cleaned = m.clean !== m.title ? ` → "${m.clean}"` : '';
    console.log(`  [${m.venueType}] "${m.title}"${cleaned}`);
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
