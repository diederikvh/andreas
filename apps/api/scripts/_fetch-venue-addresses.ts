/**
 * Fetcht een lijst venue-websites, probeert een NL-adres + postcode
 * uit de HTML te trekken, en geocodeert via Nominatim.
 *
 * Output: /tmp/venue-website-addresses.json
 *
 * Gebruik:
 *   pnpm tsx --env-file=.env scripts/_fetch-venue-addresses.ts
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

import { db, schema } from '../src/db/index.js';
import { sql } from 'drizzle-orm';

const UA = 'Andreas (https://andreas.amsterdam)';

// Postcode regex: "1234 AB" of "1234AB" (NL standaard, niet 0-prefix).
const POSTCODE = /\b([1-9]\d{3})\s?([A-Z]{2})\b/g;
// Adres-regex: probeer "Straatnaam 1-2 [postcode] [Plaats]" patronen te
// vinden. Niet perfect, maar geeft kandidaten.
const ADDRESS_PATTERNS = [
  // Straat + huisnummer + postcode + plaats (volledig)
  /([A-Z][A-Za-zÀ-ÿ' \.\-]{2,60}?\s+\d{1,4}[a-zA-Z\-\/]?)\s*,?\s*([1-9]\d{3}\s?[A-Z]{2})\s+([A-Z][A-Za-zÀ-ÿ\-]{2,40})/g,
  // Straat + huisnummer + plaats zonder postcode
  /([A-Z][A-Za-zÀ-ÿ' \.\-]{2,60}?\s+\d{1,4}[a-zA-Z\-\/]?)\s*,?\s*(Amsterdam|Zaandam|Amstelveen|Diemen|Duivendrecht|Wateringen|Middelburg)/g,
];

function extractAddresses(html: string): string[] {
  // Strip script/style.
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
  const hits = new Set<string>();
  for (const pat of ADDRESS_PATTERNS) {
    for (const m of text.matchAll(pat)) {
      const street = m[1].trim();
      // Filter: street moet niet starten met cijfer of stop-woord
      if (/^\d/.test(street)) continue;
      if (/^(open|tickets|email|tel|info|contact|about|privacy|cookie)/i.test(street))
        continue;
      if (m[2] && /\d{4}\s?[A-Z]{2}/.test(m[2])) {
        hits.add(`${street}, ${m[2]} ${m[3]}`);
      } else {
        hits.add(`${street}, ${m[2]}`);
      }
    }
  }
  return [...hits].slice(0, 5);
}

async function fetchSite(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

// Probeer ook een "contact" of "about" pagina als de hoofdpagina niets
// oplevert.
async function fetchSiteDeep(base: string): Promise<string> {
  const home = await fetchSite(base);
  let html = home ?? '';
  if (!home) return '';

  // Zoek interne links naar contact/about/bezoek/visit pagina's.
  const candidates = new Set<string>();
  const linkRegex = /href=["']([^"']+)["']/g;
  for (const m of html.matchAll(linkRegex)) {
    const href = m[1];
    if (
      /\b(contact|bezoek|visit|info|over|about|hier|directions|locatie|address)\b/i.test(
        href
      )
    ) {
      try {
        const u = new URL(href, base);
        if (u.origin === new URL(base).origin) candidates.add(u.toString());
      } catch {}
    }
  }

  for (const c of [...candidates].slice(0, 3)) {
    const extra = await fetchSite(c);
    if (extra) html += '\n' + extra;
    await sleep(300);
  }
  return html;
}

async function nominatim(q: string): Promise<{ lat: number; lng: number; display: string } | null> {
  const url =
    'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' +
    encodeURIComponent(q);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    const d = (await r.json()) as Array<{ lat: string; lon: string; display_name: string }>;
    if (!d[0]) return null;
    return { lat: +d[0].lat, lng: +d[0].lon, display: d[0].display_name };
  } catch {
    return null;
  }
}

async function main() {
  const venues = await db
    .select()
    .from(schema.venues)
    .where(
      sql`address IS NULL OR length(trim(address)) < 5
          OR (abs(lat - 52.3676) < 0.0005 AND abs(lng - 4.9041) < 0.0005)
          OR address ~* '\\b(jan|feb|mrt|apr|may|jun|jul|aug|sep|okt|oct|nov|dec)\\s+20[0-9]{2}\\b'
          OR address ~* '\\b(saturday|sunday|monday|friday|from|home contact|franchise)\\b'`
    );

  console.log(`Processing ${venues.length} venues with websites…`);
  const results: any[] = [];

  for (let i = 0; i < venues.length; i++) {
    const v = venues[i];
    const row: any = {
      id: v.id,
      name: v.name,
      current_address: v.address,
      current_coords: { lat: v.lat, lng: v.lng },
      website: v.website,
      extracted: [] as string[],
      geocoded: null as any,
    };

    if (v.website) {
      const html = await fetchSiteDeep(v.website);
      if (html) {
        row.extracted = extractAddresses(html);
        if (row.extracted.length > 0) {
          // Probeer eerste candidate.
          await sleep(1100);
          const cand = row.extracted[0];
          row.geocoded = await nominatim(cand);
          if (!row.geocoded && row.extracted.length > 1) {
            await sleep(1100);
            row.geocoded = await nominatim(row.extracted[1]);
          }
        }
      }
    }

    console.log(
      `[${i + 1}/${venues.length}] ${v.name}  ` +
        (row.extracted.length
          ? `→ ${row.extracted[0]}`
          : v.website
            ? '(geen adres in HTML)'
            : '(geen website)')
    );
    results.push(row);
    await sleep(800);
  }

  writeFileSync('/tmp/venue-website-addresses.json', JSON.stringify(results, null, 2));
  console.log('\nKlaar — /tmp/venue-website-addresses.json');
}

main().then(() => process.exit(0));
