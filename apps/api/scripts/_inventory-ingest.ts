/**
 * Inventariseer per venue welke event-data-bronnen beschikbaar zijn.
 *
 * Voor elke venue met een `website`:
 *  1. Fetch de homepage.
 *  2. Probeer common agenda-paden (/agenda, /programma, /events, /whats-on).
 *  3. Detecteer:
 *     - iCal feed (<link rel="alternate" type="text/calendar">)
 *     - JSON-LD Event-schema
 *     - RSS feed (<link rel="alternate" type="application/rss+xml">)
 *     - Ticketing-platform links (eventix, paylogic, shotgun, ra.co, ticketmaster, hello-ticket)
 *     - Embedded agenda providers (squarespace, wordpress-events, etc — best effort)
 *
 * Output: CSV op stdout + bestand `inventory.csv` naast dit script.
 *
 *   pnpm tsx --env-file=.env scripts/_inventory-ingest.ts
 */

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { eq } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const TIMEOUT_MS = 12_000;
const CONCURRENCY = 6;
const COMMON_AGENDA_PATHS = [
  '/agenda',
  '/programma',
  '/events',
  '/whats-on',
  '/programme',
  '/kalender',
];
const UA_BROWSER =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const UA_FALLBACK =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0; rv:121.0) Gecko/20100101 Firefox/121.0';
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent': UA_BROWSER,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

type Finding = {
  slug: string;
  name: string;
  website: string | null;
  reachable: boolean;
  status: number | null;
  ical: string | null;
  jsonld_events: number;
  rss: string | null;
  ticketing: string[]; // detected platforms
  agenda_path: string | null; // first working path with event content
  notes: string;
};

function normalizeUrl(u: string): string {
  return u.startsWith('http') ? u : `https://${u}`;
}

type FetchOutcome =
  | { ok: true; res: Response }
  | { ok: false; status: number | null; reason: string };

async function tryFetch(url: string, ua: string): Promise<FetchOutcome> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { ...BROWSER_HEADERS, 'User-Agent': ua },
      redirect: 'follow',
    });
    if (res.ok) return { ok: true, res };
    return { ok: false, status: res.status, reason: `status ${res.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: null, reason: msg.slice(0, 80) };
  } finally {
    clearTimeout(t);
  }
}

function toggleWww(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.startsWith('www.')) {
      u.hostname = u.hostname.replace(/^www\./, '');
      return u.toString();
    }
    u.hostname = `www.${u.hostname}`;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Smart fetch met:
 *  - browser-UA + Firefox-fallback (lost veel 403's op)
 *  - www-toggle bij DNS/TLS-failure (lost veel "fetch failed" op)
 *  - retry op 429 met korte pauze
 */
async function fetchSmart(url: string): Promise<FetchOutcome> {
  let last = await tryFetch(url, UA_BROWSER);
  if (last.ok) return last;

  // 403/406/451 → probeer Firefox-UA
  if (last.status === 403 || last.status === 406 || last.status === 451) {
    const r = await tryFetch(url, UA_FALLBACK);
    if (r.ok) return r;
    last = r;
  }

  // 429 → korte wait + retry
  if (last.status === 429) {
    await new Promise((r) => setTimeout(r, 1500));
    const r = await tryFetch(url, UA_FALLBACK);
    if (r.ok) return r;
    last = r;
  }

  // DNS/TLS/timeout → www-toggle
  if (last.status === null) {
    const flipped = toggleWww(url);
    if (flipped) {
      const r = await tryFetch(flipped, UA_BROWSER);
      if (r.ok) return r;
      last = r;
    }
  }

  return last;
}

const TICKETING_PATTERNS: Array<[string, RegExp]> = [
  ['eventix', /eventix\.(io|nl|shop)/i],
  ['paylogic', /paylogic\.com/i],
  ['shotgun', /shotgun\.(live|app)/i],
  ['ra', /ra\.co\/events/i],
  ['ticketmaster', /ticketmaster\.(nl|com)/i],
  ['hello-ticket', /hello-ticket\.com|helloticket/i],
  ['eventbrite', /eventbrite\.(com|nl)/i],
  ['ticketkantoor', /ticketkantoor\.nl/i],
  ['weemss', /weemss\.com/i],
  ['eventgenius', /eventgenius\.co/i],
  ['stager', /stager\.(co|nl)/i], // venue-management platform met agenda-feeds
  ['active-tickets', /active\.com|activetickets/i],
  ['yesplan', /yesplan\.(be|com)/i],
];

function detectTicketing(html: string): string[] {
  const found = new Set<string>();
  for (const [name, re] of TICKETING_PATTERNS) {
    if (re.test(html)) found.add(name);
  }
  return [...found];
}

function extractIcal(html: string, baseUrl: string): string | null {
  // <link rel="alternate" type="text/calendar" href="...">
  const re =
    /<link[^>]+type=["']text\/calendar["'][^>]+href=["']([^"']+)["']/i;
  const m = html.match(re);
  if (!m) {
    // probeer ook andere volgorde
    const re2 =
      /<link[^>]+href=["']([^"']+)["'][^>]+type=["']text\/calendar["']/i;
    const m2 = html.match(re2);
    if (!m2) return null;
    return absolutize(m2[1], baseUrl);
  }
  return absolutize(m[1], baseUrl);
}

function extractRss(html: string, baseUrl: string): string | null {
  const re =
    /<link[^>]+type=["']application\/rss\+xml["'][^>]+href=["']([^"']+)["']/i;
  const m = html.match(re);
  if (!m) {
    const re2 =
      /<link[^>]+href=["']([^"']+)["'][^>]+type=["']application\/rss\+xml["']/i;
    const m2 = html.match(re2);
    if (!m2) return null;
    return absolutize(m2[1], baseUrl);
  }
  return absolutize(m[1], baseUrl);
}

function countJsonLdEvents(html: string): number {
  // Vind alle <script type="application/ld+json">...</script> blokken
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let count = 0;
  for (const m of html.matchAll(re)) {
    const body = m[1].trim();
    try {
      const parsed = JSON.parse(body);
      count += countEventsInJsonLd(parsed);
    } catch {
      // soms bevat het malformed JSON of multiple objects — best effort
      const matches = body.match(/"@type"\s*:\s*"Event"/gi);
      if (matches) count += matches.length;
    }
  }
  return count;
}

function countEventsInJsonLd(node: unknown): number {
  if (!node) return 0;
  if (Array.isArray(node)) return node.reduce((acc: number, x) => acc + countEventsInJsonLd(x), 0);
  if (typeof node !== 'object') return 0;
  const obj = node as Record<string, unknown>;
  let total = 0;
  const t = obj['@type'];
  if (typeof t === 'string' && /event$/i.test(t)) total += 1;
  if (Array.isArray(t) && t.some((x) => typeof x === 'string' && /event$/i.test(x))) total += 1;
  // Walk @graph en itemListElement
  const graph = obj['@graph'];
  if (Array.isArray(graph)) total += countEventsInJsonLd(graph);
  const itemList = obj['itemListElement'];
  if (Array.isArray(itemList)) total += countEventsInJsonLd(itemList);
  return total;
}

function absolutize(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

async function inventoryVenue(
  slug: string,
  name: string,
  website: string | null
): Promise<Finding> {
  const f: Finding = {
    slug,
    name,
    website,
    reachable: false,
    status: null,
    ical: null,
    jsonld_events: 0,
    rss: null,
    ticketing: [],
    agenda_path: null,
    notes: '',
  };

  if (!website) {
    f.notes = 'no website';
    return f;
  }

  const url = normalizeUrl(website);
  const out = await fetchSmart(url);
  if (!out.ok) {
    f.status = out.status;
    f.reachable = false;
    f.notes = out.reason;
    return f;
  }
  f.status = out.res.status;
  f.reachable = true;

  const html = await out.res.text().catch(() => '');
  if (!html) {
    f.notes = 'empty body';
    return f;
  }

  const finalUrl = out.res.url || url;
  f.ical = extractIcal(html, finalUrl);
  f.rss = extractRss(html, finalUrl);
  f.jsonld_events = countJsonLdEvents(html);
  f.ticketing = detectTicketing(html);

  // Probeer common agenda-paden alleen als er nog niets gevonden is
  if (!f.ical && f.jsonld_events === 0) {
    for (const path of COMMON_AGENDA_PATHS) {
      const tryUrl = absolutize(path, finalUrl);
      const r = await fetchSmart(tryUrl);
      if (!r.ok) continue;
      const body = await r.res.text().catch(() => '');
      if (!body) continue;
      const ical = extractIcal(body, r.res.url || tryUrl);
      const events = countJsonLdEvents(body);
      const tickets = detectTicketing(body);
      if (ical || events > 0 || tickets.length > f.ticketing.length) {
        f.agenda_path = path;
        if (ical && !f.ical) f.ical = ical;
        if (events > f.jsonld_events) f.jsonld_events = events;
        for (const t of tickets) if (!f.ticketing.includes(t)) f.ticketing.push(t);
        break;
      }
    }
  }

  return f;
}

function suggestSource(f: Finding): { source: string; confidence: 'high' | 'medium' | 'low' } {
  if (f.ical) return { source: 'ical', confidence: 'high' };
  if (f.jsonld_events >= 3) return { source: 'jsonld', confidence: 'high' };
  if (f.jsonld_events > 0) return { source: 'jsonld', confidence: 'medium' };
  if (f.ticketing.includes('stager')) return { source: 'stager', confidence: 'medium' };
  if (f.ticketing.includes('ra')) return { source: 'ra', confidence: 'medium' };
  if (f.ticketing.includes('shotgun')) return { source: 'shotgun', confidence: 'medium' };
  if (f.ticketing.includes('eventix')) return { source: 'eventix', confidence: 'low' };
  if (f.ticketing.includes('paylogic')) return { source: 'paylogic', confidence: 'low' };
  if (f.ticketing.length > 0) return { source: `ticketing:${f.ticketing[0]}`, confidence: 'low' };
  if (f.rss) return { source: 'rss', confidence: 'low' };
  if (!f.reachable) return { source: 'unreachable', confidence: 'low' };
  return { source: 'scrape-html-or-newsletter', confidence: 'low' };
}

function csvEscape(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function pool<T, R>(items: T[], n: number, worker: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

async function main() {
  const venues = await db
    .select({
      slug: schema.venues.slug,
      name: schema.venues.name,
      website: schema.venues.website,
      type: schema.venues.type,
      scene: schema.venues.scene,
    })
    .from(schema.venues)
    .where(eq(schema.venues.published, true));

  // eslint-disable-next-line no-console
  console.log(`Inventarising ${venues.length} venues (concurrency=${CONCURRENCY})…`);

  let done = 0;
  const findings = await pool(venues, CONCURRENCY, async (v) => {
    const f = await inventoryVenue(v.slug, v.name, v.website);
    done++;
    if (done % 10 === 0 || done === venues.length) {
      // eslint-disable-next-line no-console
      console.log(`  [${done}/${venues.length}] ${v.slug}`);
    }
    return { v, f };
  });

  const rows: string[] = [];
  rows.push(
    [
      'slug',
      'name',
      'type',
      'scene',
      'website',
      'reachable',
      'status',
      'ical',
      'jsonld_events',
      'rss',
      'ticketing',
      'agenda_path',
      'suggested_source',
      'confidence',
      'notes',
    ].join(',')
  );

  // Sorteer: hoge confidence eerst zodat de mooie cluster bovenaan staat
  const order = { high: 0, medium: 1, low: 2 } as const;
  findings.sort((a, b) => {
    const sa = suggestSource(a.f);
    const sb = suggestSource(b.f);
    if (sa.confidence !== sb.confidence) return order[sa.confidence] - order[sb.confidence];
    return a.v.slug.localeCompare(b.v.slug);
  });

  for (const { v, f } of findings) {
    const s = suggestSource(f);
    rows.push(
      [
        csvEscape(f.slug),
        csvEscape(f.name),
        csvEscape(v.type ?? ''),
        csvEscape(v.scene ?? ''),
        csvEscape(f.website ?? ''),
        csvEscape(f.reachable ? 'yes' : 'no'),
        csvEscape(f.status ?? ''),
        csvEscape(f.ical ?? ''),
        csvEscape(f.jsonld_events),
        csvEscape(f.rss ?? ''),
        csvEscape(f.ticketing.join('|')),
        csvEscape(f.agenda_path ?? ''),
        csvEscape(s.source),
        csvEscape(s.confidence),
        csvEscape(f.notes),
      ].join(',')
    );
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const out = resolve(here, 'inventory.csv');
  await writeFile(out, rows.join('\n') + '\n', 'utf-8');

  // Tellingen voor snel overzicht
  const counts: Record<string, number> = {};
  for (const { f } of findings) {
    const s = suggestSource(f);
    const k = `${s.source} (${s.confidence})`;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  // eslint-disable-next-line no-console
  console.log('\nClusters:');
  for (const [k, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    // eslint-disable-next-line no-console
    console.log(`  ${n.toString().padStart(3)}  ${k}`);
  }
  // eslint-disable-next-line no-console
  console.log(`\nWritten ${out}`);
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
