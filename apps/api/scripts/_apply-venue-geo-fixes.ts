/**
 * Past handmatig samengestelde venue-fixes toe op de DB.
 *
 * Verwacht een JSON-bestand met shape:
 *   [
 *     { "id": "muziekgebouw-aan-t-ij", "address": "...", "lat": 52.3, "lng": 4.9 },
 *     ...
 *   ]
 *
 * Velden zijn optioneel — alleen wat in de fix-entry staat wordt
 * overschreven. Dry-run by default.
 *
 * Gebruik:
 *   pnpm tsx --env-file=.env scripts/_apply-venue-geo-fixes.ts /tmp/venue-fixes.json
 *   pnpm tsx --env-file=.env scripts/_apply-venue-geo-fixes.ts /tmp/venue-fixes.json --apply
 */

import { readFileSync } from 'node:fs';

import { eq } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

type Fix = {
  id: string;
  address?: string;
  lat?: number;
  lng?: number;
};

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const APPLY = args.includes('--apply');

if (!file) {
  console.error('Usage: _apply-venue-geo-fixes.ts <fixes.json> [--apply]');
  process.exit(1);
}

const fixes = JSON.parse(readFileSync(file, 'utf-8')) as Fix[];

async function main() {
  const all = await db.select().from(schema.venues);
  const byId = new Map(all.map((v) => [v.id, v]));

  console.log(`${fixes.length} fixes — ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  let updated = 0;
  for (const fix of fixes) {
    const v = byId.get(fix.id);
    if (!v) {
      console.log(`  ✗ ${fix.id} — niet gevonden`);
      continue;
    }
    const patch: Partial<typeof schema.venues.$inferInsert> = {};
    const log: string[] = [];
    if (fix.address != null && fix.address !== v.address) {
      patch.address = fix.address;
      log.push(`address: "${v.address}" → "${fix.address}"`);
    }
    if (fix.lat != null && fix.lat !== v.lat) {
      patch.lat = fix.lat;
      log.push(`lat: ${v.lat} → ${fix.lat}`);
    }
    if (fix.lng != null && fix.lng !== v.lng) {
      patch.lng = fix.lng;
      log.push(`lng: ${v.lng} → ${fix.lng}`);
    }
    if (log.length === 0) continue;
    console.log(`  • ${v.name}`);
    log.forEach((l) => console.log(`      ${l}`));
    if (APPLY) {
      await db.update(schema.venues).set(patch).where(eq(schema.venues.id, v.id));
    }
    updated++;
  }
  console.log(`\n${APPLY ? 'Updated' : 'Would update'}: ${updated} venues`);
}

main().then(() => process.exit(0));
