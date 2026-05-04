/**
 * Scrape amsterdamalternative.nl/network/venues:
 *   1. Fetch index → lijst van alle venue-detail-URLs
 *   2. Per detail-pagina: parse naam, adres, image, beschrijving, website
 *   3. Match op naam met onze DB:
 *      - Match → PATCH alleen velden die nu leeg zijn (geen overwrite)
 *      - Geen match → nieuwe venue aanmaken (type='ruimte', dayNight='night',
 *        wijk='centrum', published=false zodat je 'm eerst kan reviewen
 *        in admin voor 'em live komt)
 *
 *   pnpm tsx --env-file=.env scripts/seed-aa-network.ts
 *   pnpm tsx --env-file=.env scripts/seed-aa-network.ts --dry-run
 *   pnpm tsx --env-file=.env scripts/seed-aa-network.ts --only matches
 *   pnpm tsx --env-file=.env scripts/seed-aa-network.ts --only new
 */

import { setTimeout as sleep } from 'node:timers/promises';

import { db, schema } from '../src/db/index.js';

const BASE = process.env.ADMIN_BASE_URL ?? 'http://localhost:8787';
const KEY = process.env.ADMIN_API_KEY;
if (!KEY) {
  console.error('✗ ADMIN_API_KEY env var ontbreekt');
  process.exit(1);
}

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const ONLY_FLAG = args.indexOf('--only');
const ONLY = ONLY_FLAG !== -1 ? args[ONLY_FLAG + 1] : 'all'; // 'all' | 'matches' | 'new'

const AA_HOST = 'https://www.amsterdamalternative.nl';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

type AAVenue = {
  detailUrl: string;
  name: string;
  address: string | null;
  description: string | null;
  imageUrl: string | null;
  website: string | null;
};

async function fetchAAIndex(): Promise<string[]> {
  const html = await fetchHtml(`${AA_HOST}/network/venues`);
  if (!html) return [];
  const set = new Set<string>();
  const re = /\/network\/\d+\/[a-z0-9-]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    set.add(m[0]);
  }
  return Array.from(set);
}

async function parseDetail(url: string): Promise<AAVenue | null> {
  const html = await fetchHtml(`${AA_HOST}${url}`);
  if (!html) return null;

  const title = /<h1\s+class="title">([^<]+)<\/h1>/i.exec(html)?.[1].trim();
  if (!title) return null;

  const rawAddr =
    /<div\s+class="address">([^<]+)<\/div>/i.exec(html)?.[1].trim() ?? null;
  const address =
    rawAddr && rawAddr.length > 2
      ? /amsterdam/i.test(rawAddr)
        ? rawAddr
        : `${rawAddr}, Amsterdam`
      : null;

  // Image: probeer eerst data-medium id, anders direct /media/content path.
  let imageUrl: string | null = null;
  const mediumId = /data-medium="(\d+)"/i.exec(html)?.[1];
  if (mediumId) {
    imageUrl = `${AA_HOST}/media/content/${mediumId}_large.jpg`;
  } else {
    const direct = /\/media\/content\/[^"'\s]+\.(?:jpg|jpeg|png|webp)/i.exec(
      html
    )?.[0];
    if (direct) imageUrl = `${AA_HOST}${direct}`;
  }

  // Description: <p class="intro"> of eerste <p> in de body-div.
  const intro = /<p\s+class="intro">([\s\S]*?)<\/p>/i.exec(html)?.[1];
  const description = intro
    ? intro.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    : null;

  // Website: link met text "WEBSITE" of class website.
  const websiteRe =
    /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>\s*(?:<[^>]+>\s*)*(?:WEBSITE|Website|website)\s*(?:<[^>]+>\s*)*<\/a>/i;
  const website = websiteRe.exec(html)?.[1] ?? null;

  return {
    detailUrl: url,
    name: title,
    address,
    description,
    imageUrl,
    website,
  };
}

async function uploadToCdn(sourceUrl: string): Promise<string | null> {
  if (DRY) return sourceUrl;
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

async function geocodeAddress(
  address: string
): Promise<{ lat: number; lng: number } | null> {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{ lat: string; lon: string }>;
    if (data.length === 0) return null;
    return { lat: Number(data[0].lat), lng: Number(data[0].lon) };
  } catch {
    return null;
  }
}

async function postVenue(payload: Record<string, unknown>) {
  return fetch(`${BASE}/admin/api/venues`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify(payload),
  });
}

async function patchVenue(id: string, payload: Record<string, unknown>) {
  return fetch(`${BASE}/admin/api/venues/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify(payload),
  });
}

// ── Main ──────────────────────────────────────────────────────────────

console.log(`Scraping ${AA_HOST}/network/venues …${DRY ? ' (dry-run)' : ''}`);

const index = await fetchAAIndex();
console.log(`Found ${index.length} venues in index.\n`);

const dbRows = await db.select().from(schema.venues);
const dbByName = new Map(
  dbRows.map((v) => [normalizeName(v.name), v] as const)
);

function findDbMatch(aaName: string): (typeof dbRows)[number] | undefined {
  const norm = normalizeName(aaName);
  if (dbByName.has(norm)) return dbByName.get(norm);
  // Substring-match: AA-naam bevat een DB-naam volledig (bv.
  // "filmhuiscavia" bevat "cavia"), of v.v. (zelden). Min length 5
  // om kortere voorvoegsels niet vals positief te laten matchen.
  for (const [dbNorm, dbV] of dbByName) {
    if (dbNorm.length < 5) continue;
    if (norm.includes(dbNorm) || dbNorm.includes(norm)) return dbV;
  }
  return undefined;
}

let enriched = 0;
let created = 0;
let skipped = 0;
const newCandidates: AAVenue[] = [];

for (let i = 0; i < index.length; i++) {
  const url = index[i];
  const detail = await parseDetail(url);
  await sleep(400); // wees lief voor de server
  if (!detail) {
    console.warn(`✗ kon ${url} niet parsen`);
    skipped++;
    continue;
  }

  const existing = findDbMatch(detail.name);
  const isMatch = !!existing;

  if (ONLY === 'matches' && !isMatch) continue;
  if (ONLY === 'new' && isMatch) continue;

  if (existing) {
    // Patch alleen leeg-staande velden — geen overwrites.
    const updates: Record<string, unknown> = {};
    if (!existing.imageUrl && detail.imageUrl) {
      const cdn = await uploadToCdn(detail.imageUrl);
      if (cdn) updates.imageUrl = cdn;
    }
    if (
      (!existing.description || existing.description.length < 30) &&
      detail.description
    ) {
      updates.description = detail.description;
    }
    if (!existing.website && detail.website) updates.website = detail.website;
    if ((!existing.address || existing.address.length < 5) && detail.address) {
      updates.address = detail.address;
      const geo = await geocodeAddress(detail.address);
      await sleep(1100);
      if (geo) {
        updates.lat = geo.lat;
        updates.lng = geo.lng;
      }
    }

    if (Object.keys(updates).length === 0) {
      skipped++;
      continue;
    }

    if (DRY) {
      console.log(`= ${existing.id} (${detail.name}) → ${Object.keys(updates).join(', ')}`);
      enriched++;
    } else {
      const res = await patchVenue(existing.id, updates);
      if (res.ok) {
        enriched++;
        console.log(
          `✓ enriched ${existing.id} (${detail.name}) → ${Object.keys(updates).join(', ')}`
        );
      } else {
        skipped++;
        console.warn(`✗ patch ${existing.id}: ${res.status}`);
      }
    }
  } else {
    // Nieuwe venue — verzamel om in batch te tonen + later in te voegen.
    newCandidates.push(detail);
    if (ONLY === 'new' || ONLY === 'all') {
      const id = `aa-${slugify(detail.name)}`;
      let lat = 52.3676;
      let lng = 4.9041;
      let address = detail.address ?? '';
      if (address) {
        const geo = await geocodeAddress(address);
        await sleep(1100);
        if (geo) {
          lat = geo.lat;
          lng = geo.lng;
        }
      }
      let imageUrl: string | null = null;
      if (detail.imageUrl) {
        const cdn = await uploadToCdn(detail.imageUrl);
        if (cdn) imageUrl = cdn;
      }
      const payload = {
        id,
        slug: slugify(detail.name),
        name: detail.name,
        address,
        lat,
        lng,
        description: detail.description,
        imageUrl,
        website: detail.website,
        type: 'ruimte', // default — review in admin om aan te passen
        dayNight: 'both',
        wijk: 'centrum',
        subtype: ['alternatief'],
        published: false, // niet live — eerst review via admin
      };

      if (DRY) {
        console.log(`+ NEW ${id} (${detail.name}) — ${address}`);
        created++;
      } else {
        const res = await postVenue(payload);
        if (res.ok) {
          created++;
          console.log(`+ created ${id} (${detail.name})`);
        } else {
          skipped++;
          const errBody = await res.text();
          console.warn(`✗ create ${id}: ${res.status} — ${errBody.slice(0, 100)}`);
        }
      }
    }
  }

  if ((i + 1) % 10 === 0) console.log(`  — ${i + 1}/${index.length}`);
}

console.log(
  `\nDone: ${enriched} enriched, ${created} created (published:false), ${skipped} skipped.`
);
console.log(
  `${newCandidates.length} venues niet in onze DB — review als published:false in /admin/venues?filter=...`
);
process.exit(0);
