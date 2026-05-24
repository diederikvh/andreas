/**
 * Read-only test: hoeveel van onze Muziek-events vindt Spotify als
 * artist? Schrijft NIETS naar de DB. Bedoeld om de keuze-tussen
 * deeplink-only vs. embed-aanpak op data te baseren.
 *
 * Vereist: SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET in env.
 * Client Credentials flow — geen user-login, alleen server-side
 * artist-search.
 */

import { and, eq, gte, sql } from 'drizzle-orm';

import { db, schema } from '../db/index.js';

const UA = 'AndreasBot/1.0 (+https://andreas.amsterdam)';

interface SpotifyArtist {
  id: string;
  name: string;
  popularity: number;
  followers?: { total: number };
  external_urls?: { spotify?: string };
  images?: Array<{ url: string; width: number; height: number }>;
}

interface SpotifyTokenResponse {
  access_token: string;
  expires_in: number;
}

async function getToken(clientId: string, clientSecret: string): Promise<string | null> {
  try {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as SpotifyTokenResponse;
    return data.access_token;
  } catch {
    return null;
  }
}

/** Strip concert-context die de search verziekt: "live", "tour",
 *  "in concert", "presents", venue-naam-suffix, datum-haakjes,
 *  "support van X"-postfixes. */
function cleanTitleForSpotify(title: string): string {
  return title
    // Strip "(2024)" jaar-haakjes en andere paren-content
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    // Strip "support van X" / "support: X" postfix — niet onze hoofdact
    .replace(/\s+\+\s+support.*$/i, '')
    .replace(/\s+supp(ort|orting)\s+.*$/i, '')
    // Strip "live at X" / "live in X" / " — live" suffix
    .replace(/\s+(?:—|-)?\s*live\s+(?:at|in|op|@)\s+.*$/i, '')
    .replace(/\s+(?:—|-)\s+live\s*$/i, '')
    // Strip "presents X" / "X presents Y" prefix → houd "Y"
    .replace(/^.+\bpresents?\b\s*:\s*/i, '')
    // Strip ": tour-naam" suffix
    .replace(/\s+(?:—|-)\s+.+\b(?:tour|tournee|tournament|concert)\b.*$/i, '')
    // Strip festival/venue suffix: " | Paradiso", " - Melkweg"
    .replace(/\s+(?:\||—|-)\s+(?:paradiso|melkweg|bimhuis|q-factory|patronaat|tolhuistuin|concertgebouw|afas|olympic|ziggo|ahoy).*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function searchArtist(
  title: string,
  token: string
): Promise<SpotifyArtist | null | '429'> {
  try {
    const params = new URLSearchParams({ q: title, type: 'artist', limit: '5' });
    const r = await fetch(
      `https://api.spotify.com/v1/search?${params}`,
      {
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': UA },
        signal: AbortSignal.timeout(10000),
      }
    );
    if (r.status === 429) return '429';
    if (!r.ok) return null;
    const data = (await r.json()) as { artists: { items: SpotifyArtist[] } };
    if (data.artists.items.length === 0) return null;
    const needle = title.toLowerCase().trim();
    const exact = data.artists.items.filter(
      (a) => a.name.toLowerCase().trim() === needle
    );
    const pool = exact.length > 0 ? exact : data.artists.items;
    return pool.sort((a, b) => b.popularity - a.popularity)[0];
  } catch {
    return null;
  }
}

async function main() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error('SPOTIFY_CLIENT_ID en/of SPOTIFY_CLIENT_SECRET ontbreken');
    process.exit(1);
  }

  const token = await getToken(clientId, clientSecret);
  if (!token) {
    console.error('Kon geen access token ophalen — check credentials');
    process.exit(1);
  }

  // Scope: Muziek-events met een occurrence in de komende 14 dagen.
  // Voor de coverage-test hoeven we niet ALLE 2000+ events te
  // bevragen — een tijdsslice van 2 weken (~300-500 events) geeft
  // een representatief sample met respect voor de rate-limit.
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

  console.log(`Scanning ${events.length} Muziek-events tegen Spotify...\n`);

  const stats = {
    total: events.length,
    podium: 0,
    club: 0,
    other: 0,
    searched: 0,
    hit: 0,
    hitExactMatch: 0,
    hitPopular: 0, // popularity > 20
    miss: 0,
  };
  const hits: Array<{
    title: string;
    clean: string;
    matched: string;
    popularity: number;
    followers: number;
    url: string;
    venueType: string | null;
  }> = [];
  const misses: Array<{ title: string; clean: string; venueType: string | null }> = [];

  let i = 0;
  for (const e of events) {
    i += 1;
    if (e.venueType === 'podium') stats.podium += 1;
    else if (e.venueType === 'club') stats.club += 1;
    else stats.other += 1;

    const clean = cleanTitleForSpotify(e.title);
    if (!clean) {
      stats.miss += 1;
      misses.push({ title: e.title, clean, venueType: e.venueType });
      continue;
    }
    stats.searched += 1;

    let artist = await searchArtist(clean, token);
    if (artist === '429') {
      console.log(`  ⚠ 429 — wachten 30s…`);
      await new Promise((r) => setTimeout(r, 30_000));
      artist = await searchArtist(clean, token);
    }
    if (!artist || artist === '429') {
      stats.miss += 1;
      misses.push({ title: e.title, clean, venueType: e.venueType });
    } else {
      stats.hit += 1;
      const exact = artist.name.toLowerCase().trim() === clean.toLowerCase().trim();
      if (exact) stats.hitExactMatch += 1;
      if (artist.popularity > 20) stats.hitPopular += 1;
      hits.push({
        title: e.title,
        clean,
        matched: artist.name,
        popularity: artist.popularity,
        followers: artist.followers?.total ?? 0,
        url: artist.external_urls?.spotify ?? `https://open.spotify.com/artist/${artist.id}`,
        venueType: e.venueType,
      });
    }
    if (i % 25 === 0) console.log(`  …${i}/${events.length}`);
    // 600ms throttle — Spotify's Client-Credentials rate-limit is
    // strenger dan de docs suggereren. 50ms gaf 429's; 600ms (≈100
    // req/min) blijft daar ruim onder.
    await new Promise((r) => setTimeout(r, 600));
  }

  console.log('\n=== Spotify dekkings-rapport ===');
  console.log(`Totaal Muziek-events:    ${stats.total}`);
  console.log(`  ↳ podium:              ${stats.podium}`);
  console.log(`  ↳ club:                ${stats.club}`);
  console.log(`  ↳ overig:              ${stats.other}`);
  console.log(`Hits:                    ${stats.hit} (${pct(stats.hit, stats.total)})`);
  console.log(`  ↳ exact name match:    ${stats.hitExactMatch} (${pct(stats.hitExactMatch, stats.total)})`);
  console.log(`  ↳ popularity > 20:     ${stats.hitPopular} (${pct(stats.hitPopular, stats.total)})`);
  console.log(`Misses:                  ${stats.miss} (${pct(stats.miss, stats.total)})`);

  console.log('\n=== Sample 15 hits (popularity-desc) ===');
  const topHits = [...hits].sort((a, b) => b.popularity - a.popularity).slice(0, 15);
  for (const h of topHits) {
    const exactMark = h.matched.toLowerCase().trim() === h.clean.toLowerCase().trim() ? '✓' : '~';
    console.log(`  ${exactMark} "${h.title}" → "${h.matched}" pop=${h.popularity} (${h.followers.toLocaleString()} followers) [${h.venueType}]`);
  }

  console.log('\n=== Sample 10 low-popularity hits (mogelijk false positives) ===');
  const lowHits = [...hits].filter((h) => h.popularity < 15).slice(0, 10);
  for (const h of lowHits) {
    console.log(`  ~ "${h.title}" → "${h.matched}" pop=${h.popularity}`);
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
