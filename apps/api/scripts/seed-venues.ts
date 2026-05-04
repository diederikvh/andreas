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
  instagram: string | null;
  korte_omschrijving: string;
  lange_omschrijving: string;
  lijst: 'A' | 'B' | 'C';
};

function normalizeInstagram(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value
    .trim()
    .replace(/^@+/, '')
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
    .replace(/\/.*$/, '')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

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
const IMAGES_ONLY = args.includes('--images-only');
const ADDRESSES_ONLY = args.includes('--addresses-only');
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

// Minimum afmetingen die we als "venue-foto" accepteren. Logos/favicons
// vallen daar buiten. 1.2 ratio sluit vierkante logos uit.
const MIN_WIDTH = 600;
const MIN_RATIO = 1.2;

/**
 * Lees breedte/hoogte uit de eerste paar KB van een PNG of JPEG zonder
 * de volledige image te downloaden. Returnt null als formaat niet
 * herkend of bytes niet voldoende.
 */
function imageDimensions(
  buf: Uint8Array
): { w: number; h: number } | null {
  // PNG: 8-byte signature + IHDR met width/height in bytes 16-23
  if (
    buf.length >= 24 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    const w =
      (buf[16] << 24) | (buf[17] << 16) | (buf[18] << 8) | buf[19];
    const h =
      (buf[20] << 24) | (buf[21] << 16) | (buf[22] << 8) | buf[23];
    return { w, h };
  }
  // JPEG: zoek SOF0 / SOF2 marker (0xFFC0 / 0xFFC2)
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] === 0xff && (buf[i + 1] === 0xc0 || buf[i + 1] === 0xc2)) {
        const h = (buf[i + 5] << 8) | buf[i + 6];
        const w = (buf[i + 7] << 8) | buf[i + 8];
        return { w, h };
      }
      i++;
    }
  }
  // WEBP: 'RIFF' + 'WEBP' + VP8X chunk
  if (
    buf.length >= 30 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    // VP8X has dimensions at offset 24 (3 bytes width, 3 bytes height, both -1)
    if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x58) {
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { w, h };
    }
  }
  return null;
}

/**
 * Probeer een image-URL: fetch eerste 32 KB, parse dimensies, accept
 * alleen als breedte ≥ MIN_WIDTH en aspect ≥ MIN_RATIO. Returnt de
 * URL als hij voldoet, anders null.
 */
async function tryImage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { Range: 'bytes=0-32767' },
    });
    if (!res.ok && res.status !== 206) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.startsWith('image/') && ct !== '') return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    const dim = imageDimensions(buf);
    if (!dim) return url; // unknown format; gok dat het OK is
    if (dim.w < MIN_WIDTH) return null;
    if (dim.w / Math.max(1, dim.h) < MIN_RATIO) return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Verzamel kandidaat-image-URLs uit de homepage HTML. Volgorde =
 * prioriteit. Skip apple-touch-icon en favicons want dat zijn altijd
 * logos. Probeer elke kandidaat tot één voldoet aan de afmetings-
 * filter.
 */
async function fetchOgImage(website: string | null): Promise<string | null> {
  if (!website) return null;
  let html: string;
  try {
    const res = await fetch(website, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
      },
    });
    if (!res.ok) return null;
    html = await res.text();
  } catch {
    return null;
  }

  const candidates: string[] = [];
  const push = (s: string | null | undefined) => {
    if (!s) return;
    const abs = absoluteUrl(s, website);
    // Skip bekende logo-paden om snel door te kunnen.
    if (/favicon|apple-touch|logo[._-]|sprite/i.test(abs)) return;
    if (!candidates.includes(abs)) candidates.push(abs);
  };

  // Open Graph + Twitter — preferred bron, in volgorde van betrouwbaarheid.
  for (const re of [
    /<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/gi,
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/gi,
    /<meta[^>]+name=["']twitter:image:src["'][^>]+content=["']([^"']+)["']/gi,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/gi,
  ]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) push(m[1]);
  }

  // Hero/banner/cover <img> — vaak de mooiste foto op de homepage.
  const heroRe =
    /<img[^>]+(?:class|alt)=["'][^"']*(hero|banner|cover|venue|featured|teaser|header)[^"']*["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = heroRe.exec(html))) {
    const src = /src=["']([^"']+)["']/i.exec(m[0])?.[1];
    push(src);
  }

  // Vallende-stop: scan ALLE <img> tags en bouw de eerste 8 die er
  // groot genoeg uitzien (width-attr >= 600 of geen width = onzeker
  // → meedoen). Veel WordPress-sites hebben gewoon `<img>` zonder
  // hero-class met goede content-foto's (zie OT301).
  const allImgRe = /<img[^>]+>/gi;
  let imgM: RegExpExecArray | null;
  let extraCount = 0;
  while ((imgM = allImgRe.exec(html)) && extraCount < 12) {
    const tag = imgM[0];
    const src =
      /(?:data-src|src)=["']([^"']+)["']/i.exec(tag)?.[1];
    if (!src) continue;
    // Skip data:URIs en SVGs (vaak iconen).
    if (src.startsWith('data:')) continue;
    if (src.toLowerCase().endsWith('.svg')) continue;
    const wAttr = /\bwidth=["']?(\d+)/i.exec(tag)?.[1];
    if (wAttr && Number(wAttr) < 400) continue;
    push(src);
    extraCount++;
  }

  // Probeer alle kandidaten (max 14) tot één voldoet aan de filter.
  for (const url of candidates.slice(0, 14)) {
    const ok = await tryImage(url);
    if (ok) return ok;
  }
  return null;
}

/**
 * Wikipedia/Commons fallback — voor venues die in Wikipedia staan
 * geeft de REST API een `originalimage` veld terug, meestal een vrije
 * Commons-foto. Volledig CC-gelicenseerd.
 */
async function fetchWikipediaImage(name: string): Promise<string | null> {
  const tries = [
    `https://nl.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name)}`,
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name)}`,
  ];
  for (const url of tries) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': NOMINATIM_UA },
      });
      if (!res.ok) continue;
      const data = (await res.json()) as {
        originalimage?: { source?: string };
        thumbnail?: { source?: string };
      };
      const src = data.originalimage?.source ?? data.thumbnail?.source;
      if (!src) continue;
      const ok = await tryImage(src);
      if (ok) return ok;
    } catch {
      // try next
    }
  }
  return null;
}

const POSTCODE_RE = /\b(\d{4})\s?([A-Z]{2})\s+([A-Z][a-zA-ZÀ-ſ]+)/;
const STREET_NUMBER_RE =
  /\b([A-Z][a-zA-Z'À-ſ\.\- ]{2,40}?)\s+(\d+[a-zA-Z\-]?)/;

/**
 * Probeer een adres uit de homepage te vissen. Werkt op heuristiek:
 * eerst zoeken naar een NL-postcode-pattern in combinatie met een
 * straatnaam erboven; anders pakken we de eerste straatnaam + nummer
 * die we zien in een footer/contact-sectie.
 */
async function fetchAddressFromSite(
  website: string | null
): Promise<string | null> {
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
    // Strip tags voor schonere regex-matches op de tekstinhoud.
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const pcMatch = POSTCODE_RE.exec(text);
    if (pcMatch) {
      // Zoek de straatnaam in de paar tekens vóór de postcode.
      const before = text.slice(Math.max(0, pcMatch.index - 80), pcMatch.index);
      const street = STREET_NUMBER_RE.exec(before);
      if (street) {
        return `${street[1].trim()} ${street[2]}, ${pcMatch[1]} ${pcMatch[2]} ${pcMatch[3]}`;
      }
      return `${pcMatch[1]} ${pcMatch[2]} ${pcMatch[3]}`;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Geocode op naam ipv adres — voor venues waar het adres ontbreekt.
 * Nominatim's algemene q-search met "<naam> Amsterdam" geeft vaak
 * een hit voor erkende venues. Returnt zowel adres als lat/lng.
 */
async function geocodeByName(name: string): Promise<
  | { address: string; lat: number; lng: number }
  | null
> {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(
    `${name}, Amsterdam`
  )}&addressdetails=1`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': NOMINATIM_UA },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{
      lat: string;
      lon: string;
      display_name: string;
      address?: {
        road?: string;
        house_number?: string;
        postcode?: string;
        city?: string;
        suburb?: string;
      };
    }>;
    if (data.length === 0) return null;
    const r = data[0];
    const a = r.address ?? {};
    const street = [a.road, a.house_number].filter(Boolean).join(' ');
    const city = a.city ?? a.suburb ?? 'Amsterdam';
    const address =
      street && a.postcode
        ? `${street}, ${a.postcode} ${city}`
        : street
          ? `${street}, ${city}`
          : r.display_name.split(',').slice(0, 3).join(',').trim();
    return { address, lat: Number(r.lat), lng: Number(r.lon) };
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

  // Lat/lng: ophalen als ontbrekend of --force. In --images-only mode
  // overslaan we geocoding volledig.
  let lat = existing?.lat ?? null;
  let lng = existing?.lng ?? null;
  if (!IMAGES_ONLY && (lat == null || lng == null || FORCE) && v.adres) {
    const geo = await geocode(v.adres);
    if (geo) {
      lat = geo.lat;
      lng = geo.lng;
      geocoded++;
    }
    await sleep(1100); // Nominatim: 1 req/s
  }

  // Image: ophalen als ontbrekend of --force. Drie pogingen op
  // volgorde: 1) homepage-scrape (og + img-tags), 2) Wikipedia/Commons.
  let imageUrl = existing?.imageUrl ?? null;
  if ((!imageUrl || FORCE) && (v.website || v.naam)) {
    let src: string | null = null;
    if (v.website) src = await fetchOgImage(v.website);
    if (!src) src = await fetchWikipediaImage(v.naam);
    if (src) {
      const cdn = await uploadToCdn(src);
      if (cdn) {
        imageUrl = cdn;
        imaged++;
      }
    }
  }

  // In --addresses-only mode: alleen adres + lat/lng zoeken voor venues
  // waar dat ontbreekt. Adres-bron-volgorde: 1) Nominatim by-name,
  // 2) website-scrape op postcode-pattern.
  if (ADDRESSES_ONLY) {
    if (!existing) {
      console.warn(`✗ ${id}: bestaat niet in DB, skip`);
      skipped++;
      continue;
    }
    const onFallback =
      Math.abs((existing.lat ?? 0) - 52.3676) < 0.001 &&
      Math.abs((existing.lng ?? 0) - 4.9041) < 0.001;
    const needsAddress = !existing.address || existing.address.length < 5;
    const needsCoords = onFallback || existing.lat == null;

    if (!needsAddress && !needsCoords && !FORCE) {
      skipped++;
      continue;
    }

    let address = existing.address ?? null;
    let foundLat: number | null = existing.lat ?? null;
    let foundLng: number | null = existing.lng ?? null;

    // Pass 1: Nominatim op naam.
    const byName = await geocodeByName(v.naam);
    await sleep(1100);
    if (byName) {
      address = byName.address;
      foundLat = byName.lat;
      foundLng = byName.lng;
      geocoded++;
    } else if (v.website) {
      // Pass 2: scrape website voor postcode-regex.
      const fromSite = await fetchAddressFromSite(v.website);
      if (fromSite) {
        address = fromSite;
        // Geocode het gevonden adres naar lat/lng.
        const geo = await geocode(fromSite);
        await sleep(1100);
        if (geo) {
          foundLat = geo.lat;
          foundLng = geo.lng;
          geocoded++;
        }
      }
    }

    if (
      address &&
      address !== existing.address &&
      foundLat != null &&
      foundLng != null
    ) {
      const res = await patchVenue(id, {
        address,
        lat: foundLat,
        lng: foundLng,
      });
      if (res.ok) {
        updated++;
        console.log(`✓ address ${id}: ${address}`);
      } else {
        skipped++;
        console.warn(`✗ patch ${id}: ${res.status}`);
      }
    } else {
      console.log(`— ${id}: geen adres gevonden (${v.naam})`);
      skipped++;
    }
    if ((i + 1) % 10 === 0) console.log(`  — ${i + 1}/${all.length}`);
    continue;
  }

  // In --images-only mode: alleen imageUrl updaten als hij gevonden is,
  // niets anders aanraken (geen published-flag, geen subtype-overwrite).
  if (IMAGES_ONLY) {
    if (!existing) {
      console.warn(`✗ ${id}: bestaat niet in DB, skip`);
      skipped++;
      continue;
    }
    // Met --force: als geen geschikte image gevonden, wis de bestaande
    // ook (zodat een te-kleine logo wordt vervangen door "geen image"
    // ipv blijven staan). Zonder --force laten we 'em met rust.
    if (!imageUrl && FORCE && existing.imageUrl) {
      const res = await patchVenue(id, { imageUrl: null });
      if (res.ok) {
        updated++;
        console.log(`✗ wiped ${id} (${v.naam}) — geen geschikte image`);
      }
      if ((i + 1) % 10 === 0) console.log(`  — ${i + 1}/${all.length}`);
      continue;
    }
    if (imageUrl && imageUrl !== existing.imageUrl) {
      const res = await patchVenue(id, { imageUrl });
      if (res.ok) {
        updated++;
        console.log(`✓ image ${id} (${v.naam})`);
      } else {
        skipped++;
        console.warn(`✗ ${id}: ${res.status}`);
      }
    } else if (imageUrl) {
      skipped++;
    } else {
      console.log(`— ${id}: geen geschikte image gevonden (${v.naam})`);
      skipped++;
    }
    if ((i + 1) % 10 === 0) console.log(`  — ${i + 1}/${all.length}`);
    continue;
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
    website: v.website ?? null,
    instagram: normalizeInstagram(v.instagram),
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
