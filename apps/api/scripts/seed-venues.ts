/**
 * Eenmalige import van /venues.json (alle 125 venues) naar de DB.
 * Per venue:
 *   1. Geocode adres via OpenStreetMap Nominatim (gratis, 1 req/s).
 *   2. Fetch homepage → parse <meta property="og:image"> en upload via
 *      onze admin-uploads-route → CDN-URL.
 *   3. Upsert via /admin/api/venues (POST nieuw, PATCH bestaand).
 *
 * Idempotent: re-runnen overschrijft alleen velden die nu zijn ingevuld;
 * bestaande lat/lng en imageUrl blijven staan tenzij --force.
 *
 * Gebruik:
 *   pnpm tsx --env-file=.env scripts/seed-venues.ts
 *   pnpm tsx --env-file=.env scripts/seed-venues.ts --force
 *   pnpm tsx --env-file=.env scripts/seed-venues.ts --only paradiso,melkweg
 *
 * Vereist env: ADMIN_API_KEY (voor /admin/api/* calls). Pakt lokale API
 * (localhost:8787) tenzij ADMIN_BASE_URL anders zegt.
 */

import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import { eq } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

type RawVenue = {
  naam: string;
  slug: string;
  type: string;
  subtype: string[];
  day_night: 'day' | 'night' | 'both';
  wijk: string;
  adres: string;
  website: string | null;
  korte_omschrijving: string;
  lange_omschrijving: string;
  lijst: 'A' | 'B' | 'C';
};

type VenuesJson = {
  venues: RawVenue[];
};

// Bestaande venue-id's behouden zodat events FK's intact blijven.
// Match op slug uit venues.json → bestaand id in DB.
const ID_OVERRIDE: Record<string, string> = {
  'eye-filmmuseum': 'eye',
};

// CLI flags
const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const ONLY_FLAG = args.indexOf('--only');
const ONLY = ONLY_FLAG !== -1 ? args[ONLY_FLAG + 1]?.split(',') ?? [] : [];

const BASE = process.env.ADMIN_BASE_URL ?? 'http://localhost:8787';
const KEY = process.env.ADMIN_API_KEY;
if (!KEY) {
  console.error('✗ ADMIN_API_KEY env var ontbreekt');
  process.exit(1);
}

const NOMINATIM_UA = 'Andreas (https://andreas.amsterdam)';

async function geocode(
  address: string
): Promise<{ lat: number; lng: number } | null> {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(
    address
  )}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': NOMINATIM_UA },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{ lat: string; lon: string }>;
    if (data.length === 0) return null;
    return { lat: Number(data[0].lat), lng: Number(data[0].lon) };
  } catch {
    return null;
  }
}

async function fetchOgImage(website: string | null): Promise<string | null> {
  if (!website) return null;
  try {
    const res = await fetch(website, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
      },
    });
    if (!res.ok) return null;
    const html = await res.text();
    // Eerst og:image, anders twitter:image, anders apple-touch-icon
    const og = html.match(
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
    );
    if (og) return absoluteUrl(og[1], website);
    const tw = html.match(
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i
    );
    if (tw) return absoluteUrl(tw[1], website);
    const apple = html.match(
      /<link[^>]+rel=["']apple-touch-icon[^"']*["'][^>]+href=["']([^"']+)["']/i
    );
    if (apple) return absoluteUrl(apple[1], website);
    return null;
  } catch {
    return null;
  }
}

function absoluteUrl(maybeRelative: string, base: string): string {
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return maybeRelative;
  }
}

async function uploadToCdn(sourceUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${BASE}/admin/api/uploads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${KEY}`,
      },
      body: JSON.stringify({ sourceUrl, kind: 'venues' }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { url?: string };
    return data.url ?? null;
  } catch {
    return null;
  }
}

async function existingVenue(id: string) {
  const [row] = await db
    .select()
    .from(schema.venues)
    .where(eq(schema.venues.id, id))
    .limit(1);
  return row ?? null;
}

async function postVenue(payload: Record<string, unknown>) {
  const res = await fetch(`${BASE}/admin/api/venues`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify(payload),
  });
  return res;
}

async function patchVenue(id: string, payload: Record<string, unknown>) {
  const res = await fetch(`${BASE}/admin/api/venues/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify(payload),
  });
  return res;
}

const json = JSON.parse(
  await readFile(new URL('../../../venues.json', import.meta.url), 'utf-8')
) as VenuesJson;

const all = json.venues.filter((v) =>
  ONLY.length === 0 ? true : ONLY.includes(v.slug)
);

console.log(
  `Importing ${all.length} venues into ${BASE} ${FORCE ? '(force)' : ''}…\n`
);

let created = 0;
let updated = 0;
let skipped = 0;
let geocoded = 0;
let imaged = 0;

for (let i = 0; i < all.length; i++) {
  const v = all[i];
  const id = ID_OVERRIDE[v.slug] ?? v.slug;
  const existing = await existingVenue(id);

  // Lat/lng: ophalen als ontbrekend of --force.
  let lat = existing?.lat ?? null;
  let lng = existing?.lng ?? null;
  if ((lat == null || lng == null || FORCE) && v.adres) {
    const geo = await geocode(v.adres);
    if (geo) {
      lat = geo.lat;
      lng = geo.lng;
      geocoded++;
    }
    await sleep(1100); // Nominatim: 1 req/s
  }

  // Image: alleen ophalen als ontbrekend of --force.
  let imageUrl = existing?.imageUrl ?? null;
  if ((!imageUrl || FORCE) && v.website) {
    const og = await fetchOgImage(v.website);
    if (og) {
      const cdn = await uploadToCdn(og);
      if (cdn) {
        imageUrl = cdn;
        imaged++;
      }
    }
  }

  // Velden die uit venues.json komen — common voor create + update.
  const commonPayload = {
    slug: v.slug,
    name: v.naam,
    address: v.adres ?? '',
    lat: lat ?? 52.3676,
    lng: lng ?? 4.9041,
    description: v.korte_omschrijving || v.lange_omschrijving || null,
    imageUrl,
    type: v.type,
    dayNight: v.day_night,
    wijk: v.wijk,
    subtype: v.subtype,
    published: v.lijst === 'A', // A = launch, B = nog niet
  };

  if (existing) {
    // Op PATCH: geen `categories` meesturen — die heeft de venue
    // mogelijk al bewust ingesteld (bv. Paradiso = ['Muziek','Film']).
    const res = await patchVenue(id, commonPayload);
    if (res.ok) {
      updated++;
      console.log(`✓ updated ${id} (${v.naam})`);
    } else {
      skipped++;
      console.warn(`✗ patch failed ${id}: ${res.status} ${await res.text()}`);
    }
  } else {
    // Nieuwe venue: explicit id + lege categories als default.
    const res = await postVenue({ id, ...commonPayload, categories: [] });
    if (res.ok) {
      created++;
      console.log(`+ created ${id} (${v.naam})`);
    } else {
      skipped++;
      console.warn(`✗ create failed ${id}: ${res.status} ${await res.text()}`);
    }
  }

  // Progress every 10 records
  if ((i + 1) % 10 === 0) {
    console.log(`  — ${i + 1}/${all.length}`);
  }
}

console.log(
  `\nDone: ${created} created, ${updated} updated, ${skipped} skipped.`
);
console.log(`Geocoded ${geocoded}, fetched/uploaded image for ${imaged}.`);
process.exit(0);
