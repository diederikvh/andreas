import { sql, eq } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

/**
 * Probe per unscraped venue welk scraper-patroon waarschijnlijk werkt.
 * Detecteert: sitemap, framework (Phoenix/Vue/Next/WP), JSON-LD,
 * iCal feed, FareHarbor/Eventix/Weeztix/Stager-tickets.
 */

const UA = 'Mozilla/5.0 (Andreas-Probe/1.0)';

type Probe = {
  name: string;
  website: string;
  sitemap?: { ok: boolean; size?: number };
  homepage?: {
    framework?: string;
    jsonLdEvent?: boolean;
    icalLink?: string;
    ticketing?: string;
    showsUrl?: string;
  };
  recommendation?: string;
};

async function head(url: string, opts?: { ua?: string; timeout?: number }): Promise<Response | null> {
  try {
    const r = await fetch(url, {
      method: 'HEAD',
      headers: { 'user-agent': opts?.ua ?? UA },
      signal: AbortSignal.timeout(opts?.timeout ?? 8000),
    });
    return r;
  } catch {
    return null;
  }
}

async function fetchText(url: string, opts?: { ua?: string; timeout?: number }): Promise<{ status: number; text: string } | null> {
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': opts?.ua ?? UA },
      signal: AbortSignal.timeout(opts?.timeout ?? 12000),
    });
    if (r.status >= 400) return { status: r.status, text: '' };
    const text = await r.text();
    return { status: r.status, text };
  } catch {
    return null;
  }
}

function detectFramework(html: string): string | undefined {
  if (/phx-(?:click|hook|debounce|update|track)/.test(html)) return 'Phoenix LiveView';
  if (/__NEXT_DATA__/.test(html)) return 'Next.js';
  if (/__NUXT__|id="__nuxt"/.test(html)) return 'Nuxt';
  if (/data-v-[a-f0-9]{8}|<div id="?app"?>/.test(html) && html.length < 30000) return 'Vue SPA';
  if (/wp-content|wp-includes|wp-json/.test(html)) return 'WordPress';
  if (/data-reactroot|react-root/.test(html)) return 'React';
  return undefined;
}

function detectTicketing(html: string): string | undefined {
  if (/fareharbor\.com/.test(html)) return 'FareHarbor';
  if (/eventix\.io|tickets\.eventix\./.test(html)) return 'Eventix';
  if (/weeztix\.|api\.weeztix\./.test(html)) return 'Weeztix';
  if (/\.stager\.co|stager\.nl/.test(html)) return 'Stager';
  if (/ticketmaster\.nl|ticketmaster\.com/.test(html)) return 'Ticketmaster';
  if (/tixly\.com|updates\.tixly/.test(html)) return 'Tixly';
  if (/wix\.com|wixstatic|wix-events/.test(html)) return 'Wix';
  if (/spektrix\.com|sk-spektrix/.test(html)) return 'Spektrix';
  if (/peppered\.com/.test(html)) return 'Peppered';
  if (/itix\.nl/.test(html)) return 'iTix';
  return undefined;
}

function detectJsonLdEvent(html: string): boolean {
  const blocks = html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]+?)<\/script>/g);
  for (const m of blocks) {
    try {
      const d = JSON.parse(m[1].trim());
      const items: unknown[] = Array.isArray(d) ? d : d?.['@graph'] ?? [d];
      for (const x of items) {
        const type = String((x as { '@type'?: string })?.['@type'] ?? '');
        if (/Event/i.test(type)) return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

function detectIcalLink(html: string): string | undefined {
  const m = html.match(/href="([^"]+\.ics[^"]*)"/);
  return m?.[1];
}

function detectShowsUrl(html: string, base: string): string | undefined {
  const candidates = ['/agenda', '/programma', '/voorstellingen', '/shows', '/events', '/kalender', '/wat-te-doen'];
  for (const path of candidates) {
    const re = new RegExp(`href="(${path}[^"]*?)"`, 'i');
    const m = html.match(re);
    if (m) return new URL(m[1], base).toString();
  }
  return undefined;
}

async function probe(name: string, website: string): Promise<Probe> {
  const result: Probe = { name, website };

  const homeUrl = website.startsWith('http') ? website : `https://${website}`;
  const baseHost = new URL(homeUrl).origin;

  // Parallel: sitemap + homepage
  const [smRes, homeRes] = await Promise.all([
    head(`${baseHost}/sitemap.xml`),
    fetchText(homeUrl),
  ]);

  if (smRes && smRes.ok) {
    const cl = smRes.headers.get('content-length');
    result.sitemap = { ok: true, size: cl ? parseInt(cl, 10) : undefined };
  } else {
    result.sitemap = { ok: false };
  }

  if (homeRes && homeRes.text) {
    const fw = detectFramework(homeRes.text);
    const tk = detectTicketing(homeRes.text);
    const il = detectIcalLink(homeRes.text);
    const showsUrl = detectShowsUrl(homeRes.text, homeUrl);
    result.homepage = {
      framework: fw,
      jsonLdEvent: detectJsonLdEvent(homeRes.text),
      icalLink: il,
      ticketing: tk,
      showsUrl,
    };
  }

  // Build recommendation
  const hp = result.homepage ?? {};
  const recs: string[] = [];
  if (hp.icalLink) recs.push(`iCal feed: ${hp.icalLink}`);
  if (hp.ticketing === 'FareHarbor') recs.push('FareHarbor → boomchicago.ts pattern');
  if (hp.ticketing === 'Stager') recs.push('Stager → stager.ts pattern');
  if (hp.ticketing === 'Wix') recs.push('Wix → concertgemaal.ts pattern');
  if (hp.framework === 'WordPress') recs.push('WP REST API → p60.ts pattern (check `wp/v2/types`)');
  if (hp.jsonLdEvent || (result.sitemap?.ok && hp.framework)) {
    recs.push(`theater.ts pattern (sitemap=${result.sitemap?.ok}, framework=${hp.framework ?? 'static'})`);
  }
  if (hp.ticketing === 'Eventix' || hp.ticketing === 'Weeztix') recs.push(`${hp.ticketing} → ontheroof.ts pattern of API`);
  if (hp.ticketing === 'Tixly') recs.push('Tixly → eigen scraper (geen publieke API)');
  result.recommendation = recs.join('; ') || '?';

  return result;
}

// Main
const venues = await db
  .select({
    id: schema.venues.id,
    name: schema.venues.name,
    capacity: schema.venues.capacity,
    website: schema.venues.website,
  })
  .from(schema.venues)
  .where(sql`${schema.venues.type} = 'podium' AND ${schema.venues.published} = true`);

const eventRows = await db
  .select({ venueId: schema.events.venueId, n: sql<number>`count(*)::int` })
  .from(schema.events)
  .groupBy(schema.events.venueId);
const eventCounts = new Map<string, number>();
for (const r of eventRows) eventCounts.set(r.venueId, r.n);

const noEvents = venues.filter((v) => (eventCounts.get(v.id) ?? 0) === 0 && v.website);

console.log(`Probing ${noEvents.length} venues...\n`);

// Parallel batches van 5
const BATCH = 5;
const results: Probe[] = [];
for (let i = 0; i < noEvents.length; i += BATCH) {
  const batch = noEvents.slice(i, i + BATCH);
  const probes = await Promise.all(batch.map((v) => probe(v.name, v.website!)));
  results.push(...probes);
}

// Sort by capacity (xl first)
const order = ['xl', 'groot', 'middel', 'klein'];
results.sort((a, b) => {
  const va = noEvents.find((v) => v.name === a.name)?.capacity ?? 'klein';
  const vb = noEvents.find((v) => v.name === b.name)?.capacity ?? 'klein';
  return order.indexOf(va) - order.indexOf(vb);
});

for (const r of results) {
  const venue = noEvents.find((v) => v.name === r.name);
  console.log(`[${venue?.capacity ?? '?'}] ${r.name}`);
  console.log(`  ${r.website}`);
  console.log(`  sitemap=${r.sitemap?.ok ? 'YES' : 'no'}${r.sitemap?.size ? ` (${(r.sitemap.size / 1024).toFixed(0)}KB)` : ''} | framework=${r.homepage?.framework ?? '-'} | jsonld-Event=${r.homepage?.jsonLdEvent ? 'YES' : 'no'} | ticket=${r.homepage?.ticketing ?? '-'} | ical=${r.homepage?.icalLink ? 'YES' : 'no'}`);
  console.log(`  → ${r.recommendation}`);
  console.log();
}
process.exit(0);
