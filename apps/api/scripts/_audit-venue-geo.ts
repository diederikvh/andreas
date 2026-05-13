/**
 * Geo-audit voor alle venues:
 *   - Hergeocodeert via Nominatim (naam + adres).
 *   - Vergelijkt met DB-waarden.
 *   - Flagt problemen: lege adres, fallback coord, afwijking > 200m,
 *     onbekend adres, of geocode-resultaat buiten Groot-Amsterdam.
 *
 * Read-only. Schrijft rapport naar /tmp/venue-geo-audit.json.
 *
 * Gebruik:
 *   pnpm tsx --env-file=.env scripts/_audit-venue-geo.ts
 *   pnpm tsx --env-file=.env scripts/_audit-venue-geo.ts --only paradiso,melkweg
 */

import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { db, schema } from '../src/db/index.js';

const args = process.argv.slice(2);
const ONLY_FLAG = args.indexOf('--only');
const ONLY = ONLY_FLAG !== -1 ? args[ONLY_FLAG + 1]?.split(',') ?? [] : [];

const UA = 'Andreas (https://andreas.amsterdam)';
const FALLBACK_LAT = 52.3676;
const FALLBACK_LNG = 4.9041;

type NomHit = {
  lat: number;
  lng: number;
  display: string;
  // OSM type+class kan helpen onderscheid maken (node/way/building).
  osm_type?: string;
  class?: string;
  type?: string;
};

async function nominatim(q: string): Promise<NomHit | null> {
  const url =
    'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' +
    encodeURIComponent(q);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    const d = (await r.json()) as Array<{
      lat: string;
      lon: string;
      display_name: string;
      osm_type?: string;
      class?: string;
      type?: string;
    }>;
    if (!d[0]) return null;
    return {
      lat: Number(d[0].lat),
      lng: Number(d[0].lon),
      display: d[0].display_name,
      osm_type: d[0].osm_type,
      class: d[0].class,
      type: d[0].type,
    };
  } catch {
    return null;
  }
}

function distMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function isInAmsterdamRegion(p: { lat: number; lng: number }): boolean {
  // Ruim Groot-Amsterdam (incl. Amstelveen / Zaandam / Diemen / Duivendrecht).
  return p.lat > 52.25 && p.lat < 52.5 && p.lng > 4.7 && p.lng < 5.1;
}

async function main() {
  const all = await db.select().from(schema.venues);
  const venues = ONLY.length
    ? all.filter((v) => ONLY.includes(v.slug) || ONLY.includes(v.id))
    : all;
  venues.sort((a, b) => a.name.localeCompare(b.name));

  console.log(`Auditing ${venues.length} venues…`);
  const report: any[] = [];

  for (let i = 0; i < venues.length; i++) {
    const v = venues[i];
    const onFallback =
      Math.abs((v.lat ?? 0) - FALLBACK_LAT) < 0.0005 &&
      Math.abs((v.lng ?? 0) - FALLBACK_LNG) < 0.0005;
    const emptyAddr = !v.address || v.address.trim().length < 5;

    // Geocode 1: probeer adres als die er is.
    let byAddr: NomHit | null = null;
    if (!emptyAddr) {
      const addrQ = /amsterdam/i.test(v.address)
        ? v.address
        : `${v.address}, Amsterdam`;
      byAddr = await nominatim(addrQ);
      await sleep(1100);
    }

    // Geocode 2: probeer naam + Amsterdam.
    const byName = await nominatim(`${v.name} Amsterdam`);
    await sleep(1100);

    // Beste hit kiezen: byName als het in regio ligt en class iets met
    // "amenity"/"leisure"/"tourism" is (echte plekken). Anders byAddr.
    const nameOk =
      byName &&
      isInAmsterdamRegion(byName) &&
      ['amenity', 'leisure', 'tourism', 'shop', 'building'].includes(
        byName.class ?? ''
      );
    const addrOk = byAddr && isInAmsterdamRegion(byAddr);
    const best = nameOk ? byName! : addrOk ? byAddr! : byName ?? byAddr;

    const current = { lat: v.lat ?? 0, lng: v.lng ?? 0 };
    const distFromCurrent =
      best && current.lat && current.lng ? distMeters(current, best) : null;
    // Adres-vs-naam mismatch: als beide hits er zijn maar > 300m uit
    // elkaar liggen, klopt het DB-adres niet bij de naam (zoals
    // Skatecafe: adres = Schaafstraat, maar venue staat op Gedempt
    // Hamerkanaal).
    const addrNameMismatch =
      byAddr && byName && isInAmsterdamRegion(byAddr) && isInAmsterdamRegion(byName)
        ? distMeters(byAddr, byName)
        : null;

    const flags: string[] = [];
    if (emptyAddr) flags.push('empty-address');
    if (onFallback) flags.push('fallback-coord');
    if (distFromCurrent != null && distFromCurrent > 200) flags.push('coord-drift');
    if (addrNameMismatch != null && addrNameMismatch > 300)
      flags.push('address-name-mismatch');
    if (best && !isInAmsterdamRegion(best)) flags.push('geocode-out-of-region');
    if (!best) flags.push('geocode-failed');
    // Adres bevat datum-achtige string.
    if (
      v.address &&
      /\b(jan|feb|mrt|apr|may|jun|jul|aug|sep|okt|oct|nov|dec)\s+20\d{2}\b/i.test(
        v.address
      )
    )
      flags.push('address-garbage');
    // Adres lijkt op zin / bevat raar woord ("Saturday from", "Franchise
    // Kunstverein", "Onrust- Home contact"…). Heuristiek: meer dan 1 woord
    // niet-cijfer / niet-postcode / niet-straatnaam-suffix.
    if (
      v.address &&
      /\b(saturday|sunday|monday|friday|from|home|contact|franchise|opening|hours)\b/i.test(
        v.address
      )
    )
      flags.push('address-garbage');

    const row = {
      id: v.id,
      slug: v.slug,
      name: v.name,
      current: {
        address: v.address,
        lat: v.lat,
        lng: v.lng,
      },
      byAddr: byAddr
        ? { lat: byAddr.lat, lng: byAddr.lng, display: byAddr.display }
        : null,
      byName: byName
        ? {
            lat: byName.lat,
            lng: byName.lng,
            display: byName.display,
            class: byName.class,
          }
        : null,
      bestGuess: best
        ? { lat: best.lat, lng: best.lng, display: best.display }
        : null,
      distFromCurrent_m:
        distFromCurrent != null ? Math.round(distFromCurrent) : null,
      addrVsName_m:
        addrNameMismatch != null ? Math.round(addrNameMismatch) : null,
      flags,
    };
    report.push(row);

    if (flags.length) {
      console.log(
        `[${i + 1}/${venues.length}] ⚠ ${v.name}  flags=${flags.join(',')}` +
          (distFromCurrent != null ? `  drift=${Math.round(distFromCurrent)}m` : '')
      );
    } else {
      console.log(`[${i + 1}/${venues.length}] ✓ ${v.name}`);
    }
  }

  writeFileSync('/tmp/venue-geo-audit.json', JSON.stringify(report, null, 2));
  const issues = report.filter((r) => r.flags.length);
  console.log(`\nTotaal venues: ${report.length}`);
  console.log(`Met flags:     ${issues.length}`);
  console.log('Rapport: /tmp/venue-geo-audit.json');
}

main().then(() => process.exit(0));
