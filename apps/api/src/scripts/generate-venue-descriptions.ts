/**
 * LLM-gegenereerde venue-beschrijvingen voor venues met een te korte
 * (of ontbrekende) `description`. Bedoeld als one-off batch om de SEO/
 * GEO-content op andreas.amsterdam op te krikken.
 *
 * Bronnen per venue (best-effort, faalt soft):
 *   1. Eigen website (HTTP-fetch van homepage + /about / /over)
 *   2. Wikipedia NL (opensearch → page summary)
 *   3. Recente events uit de DB (titels + genres)
 *
 * Claude Sonnet 4.6 met tool-use → één paragraaf van 400–700 tekens,
 * Nederlands, feitelijk maar met karakter. Tool-use garandeert valide
 * structured output.
 *
 * Defaults: dry-run, target = venues met `length(description) <= 100`.
 *
 * Gebruik:
 *   pnpm tsx --env-file=.env src/scripts/generate-venue-descriptions.ts
 *   pnpm tsx --env-file=.env src/scripts/generate-venue-descriptions.ts --limit=5
 *   pnpm tsx --env-file=.env src/scripts/generate-venue-descriptions.ts --slug=paradiso
 *   pnpm tsx --env-file=.env src/scripts/generate-venue-descriptions.ts --apply
 */

import { sql } from 'drizzle-orm';

import { db } from '../db/index.js';
import { venues, events } from '../db/schema.js';

const MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_VERSION = '2023-06-01';
const MIN_LEN = 400;
const MAX_LEN = 700;
const HTTP_TIMEOUT_MS = 12000;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36';

const SYSTEM_PROMPT = `Je schrijft korte venue-beschrijvingen voor Andreas, een Amsterdamse uitgaans-app die zich positioneert tegenover algoritmische platforms.

Je krijgt per venue: de naam, type, eventueel een Wikipedia-fragment, eventueel tekst van de eigen website, en een lijst recente events met genres. Schrijf één alinea in NEDERLANDS, tussen ${MIN_LEN} en ${MAX_LEN} tekens.

STIJL:
- Feitelijk maar met karakter. Geen marketing-taal ("een unieke beleving", "iconisch"). Geen superlatieven.
- Eerste zin: wat het ís (type, ligging in Amsterdam, eventueel oprichtingsjaar of geschiedenis).
- Daarna: wat voor programmering, voor wie, wat de plek onderscheidt.
- Geen tweede persoon ("jij/je"). Geen call-to-action.
- Geen verzonnen feiten. Als bronnen elkaar tegenspreken: kies de meest specifieke bron (website > wikipedia > events).
- Bij gebrek aan informatie: kort houden, blijf binnen wat de bronnen melden. Geef liever ${MIN_LEN} tekens dan een gok.

VERMIJD:
- Adres-regels (komen al uit het address-veld)
- Ticketprijzen of openingstijden (te volatiel)
- "Het ligt op een steenworp afstand van...", "in het hart van..."
- Lijstjes van losse artiesten
- HTML/markdown — alleen plain text

Roep de tool \`write_description\` aan met je tekst.`;

const TOOL_DEF = {
  name: 'write_description',
  description: 'Sla de gegenereerde venue-beschrijving op.',
  input_schema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: `Eén alinea, Nederlands, ${MIN_LEN}–${MAX_LEN} tekens, plain text.`,
      },
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description:
          'Inschatting hoe goed de bronnen het venue dekten. Low = vooral op naam/type gebaseerd.',
      },
    },
    required: ['description', 'confidence'],
  },
} as const;

type Args = {
  apply: boolean;
  limit: number | null;
  slug: string | null;
  threshold: number;
};

function parseArgs(): Args {
  const args: Args = { apply: false, limit: null, slug: null, threshold: 100 };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--apply') args.apply = true;
    else if (arg.startsWith('--limit=')) args.limit = Number(arg.slice(8));
    else if (arg.startsWith('--slug=')) args.slug = arg.slice(7);
    else if (arg.startsWith('--threshold=')) args.threshold = Number(arg.slice(12));
    else console.warn(`[args] unknown flag ignored: ${arg}`);
  }
  return args;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/g, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<head[\s\S]*?<\/head>/g, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/g, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchWithTimeout(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,*/*' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fetchWebsiteText(website: string | null): Promise<string | null> {
  if (!website) return null;
  let base: URL;
  try {
    base = new URL(website);
  } catch {
    return null;
  }
  const candidates = [
    new URL('/over-ons', base).toString(),
    new URL('/over', base).toString(),
    new URL('/about', base).toString(),
    base.toString(),
  ];
  const texts: string[] = [];
  for (const url of candidates) {
    const html = await fetchWithTimeout(url);
    if (!html) continue;
    const text = stripHtml(html);
    if (text.length > 400) {
      texts.push(text.slice(0, 6000));
      if (texts.length >= 2) break;
    }
  }
  if (texts.length === 0) return null;
  return texts.join('\n\n---\n\n').slice(0, 10000);
}

async function wikiSearchTitles(query: string): Promise<string[]> {
  const url = `https://nl.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=5&namespace=0&format=json`;
  const body = await fetchWithTimeout(url);
  if (!body) return [];
  try {
    const parsed = JSON.parse(body) as [string, string[], string[], string[]];
    return parsed[1] ?? [];
  } catch {
    return [];
  }
}

async function fetchWikipediaSummary(name: string): Promise<string | null> {
  // Try plain name first, then suffixed met Amsterdam voor disambiguation.
  const hasAmsterdam = /amsterdam/i.test(name);
  const queries = hasAmsterdam ? [name] : [name, `${name} Amsterdam`];

  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const q of queries) {
    const titles = await wikiSearchTitles(q);
    for (const t of titles) {
      if (!seen.has(t)) {
        seen.add(t);
        candidates.push(t);
      }
    }
  }
  if (candidates.length === 0) return null;

  // Prioriteer titels die (Amsterdam) of "Amsterdam" bevatten — die zijn
  // bijna altijd de juiste disambiguation.
  candidates.sort((a, b) => {
    const aScore = /\(amsterdam\)|amsterdam/i.test(a) ? 1 : 0;
    const bScore = /\(amsterdam\)|amsterdam/i.test(b) ? 1 : 0;
    return bScore - aScore;
  });

  for (const title of candidates.slice(0, 3)) {
    const summaryUrl = `https://nl.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const body = await fetchWithTimeout(summaryUrl);
    if (!body) continue;
    try {
      const parsed = JSON.parse(body) as { extract?: string; type?: string };
      if (parsed.type === 'disambiguation') continue;
      const extract = parsed.extract?.trim();
      if (!extract || extract.length < 80) continue;
      // Filter on relevantie: moet Amsterdam noemen of een woord uit de naam.
      const looksRelevant =
        /amsterdam/i.test(extract) ||
        name
          .split(/\s+/)
          .filter((w) => w.length >= 4)
          .some((w) => extract.toLowerCase().includes(w.toLowerCase()));
      if (!looksRelevant) continue;
      return `Wikipedia (${title}): ${extract}`;
    } catch {
      continue;
    }
  }
  return null;
}

type EventContext = {
  count: number;
  recentTitles: string[];
  topGenres: string[];
};

async function fetchEventContext(venueId: string): Promise<EventContext> {
  const rows = await db
    .select({
      title: events.title,
      genres: events.genres,
      category: events.category,
    })
    .from(events)
    .where(sql`${events.venueId} = ${venueId} AND ${events.published} = true`)
    .orderBy(sql`${events.createdAt} DESC`)
    .limit(40);

  const genreFreq = new Map<string, number>();
  for (const row of rows) {
    for (const g of row.genres ?? []) {
      const key = g.toLowerCase().trim();
      if (key) genreFreq.set(key, (genreFreq.get(key) ?? 0) + 1);
    }
  }
  const topGenres = [...genreFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([g]) => g);

  return {
    count: rows.length,
    recentTitles: rows.slice(0, 12).map((r) => r.title),
    topGenres,
  };
}

type VenueRow = {
  id: string;
  slug: string;
  name: string;
  type: string | null;
  scene: string | null;
  capacity: string | null;
  wijk: string | null;
  website: string | null;
  description: string | null;
};

async function selectTargetVenues(args: Args): Promise<VenueRow[]> {
  const allRows = await db
    .select({
      id: venues.id,
      slug: venues.slug,
      name: venues.name,
      type: venues.type,
      scene: venues.scene,
      capacity: venues.capacity,
      wijk: venues.wijk,
      website: venues.website,
      description: venues.description,
    })
    .from(venues)
    .orderBy(venues.name);

  let filtered = allRows.filter((v) => {
    const len = (v.description ?? '').trim().length;
    return len <= args.threshold;
  });

  if (args.slug) {
    filtered = allRows.filter((v) => v.slug === args.slug);
  }
  if (args.limit !== null) filtered = filtered.slice(0, args.limit);
  return filtered;
}

async function callClaude(
  venue: VenueRow,
  sources: { website: string | null; wiki: string | null; events: EventContext },
): Promise<{ description: string; confidence: string; usage: { in: number; out: number } }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const blocks: string[] = [];
  blocks.push(`Venue: ${venue.name}`);
  if (venue.type) blocks.push(`Type: ${venue.type}`);
  if (venue.scene) blocks.push(`Scene: ${venue.scene}`);
  if (venue.capacity) blocks.push(`Capaciteit: ${venue.capacity}`);
  if (venue.wijk) blocks.push(`Wijk: ${venue.wijk}`);
  if (venue.website) blocks.push(`Website: ${venue.website}`);
  if (venue.description) blocks.push(`Huidige (te korte) beschrijving: ${venue.description}`);

  if (sources.wiki) {
    blocks.push(`\n--- WIKIPEDIA ---\n${sources.wiki}`);
  }
  if (sources.website) {
    blocks.push(`\n--- WEBSITE-TEKST (gestript) ---\n${sources.website.slice(0, 8000)}`);
  }
  if (sources.events.count > 0) {
    blocks.push(
      `\n--- RECENTE EVENTS (${sources.events.count} totaal) ---\n` +
        `Top genres: ${sources.events.topGenres.join(', ') || '(geen)'}\n` +
        `Recente titels:\n- ${sources.events.recentTitles.join('\n- ')}`,
    );
  }

  const userMessage = blocks.join('\n');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: [TOOL_DEF],
      tool_choice: { type: 'tool', name: TOOL_DEF.name },
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic ${response.status}: ${body.slice(0, 400)}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; name?: string; input?: unknown }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const toolUse = data.content.find(
    (c) => c.type === 'tool_use' && c.name === TOOL_DEF.name,
  );
  if (!toolUse?.input || typeof toolUse.input !== 'object') {
    throw new Error('Claude returned no tool_use');
  }
  const out = toolUse.input as { description?: string; confidence?: string };
  if (!out.description || typeof out.description !== 'string') {
    throw new Error('Claude returned no description');
  }
  return {
    description: out.description.trim(),
    confidence: out.confidence ?? 'medium',
    usage: {
      in: data.usage?.input_tokens ?? 0,
      out: data.usage?.output_tokens ?? 0,
    },
  };
}

function fmtBefore(s: string | null): string {
  const t = (s ?? '').trim();
  if (!t) return '(leeg)';
  return t;
}

async function main() {
  const args = parseArgs();
  console.log(
    `[gen-desc] mode=${args.apply ? 'APPLY (writes DB)' : 'dry-run'} threshold<=${args.threshold} limit=${args.limit ?? '∞'} slug=${args.slug ?? '*'}`,
  );

  const targets = await selectTargetVenues(args);
  console.log(`[gen-desc] ${targets.length} venues geselecteerd\n`);

  let tokensIn = 0;
  let tokensOut = 0;
  let ok = 0;
  let fail = 0;
  let lowConf = 0;

  for (const [i, venue] of targets.entries()) {
    const head = `[${i + 1}/${targets.length}] ${venue.name} (${venue.slug})`;
    console.log(`\n${head}`);
    console.log(`  type=${venue.type ?? '?'} website=${venue.website ?? '(geen)'}`);
    console.log(`  before (${(venue.description ?? '').length}): ${fmtBefore(venue.description)}`);

    try {
      const [website, wiki, eventCtx] = await Promise.all([
        fetchWebsiteText(venue.website),
        fetchWikipediaSummary(venue.name),
        fetchEventContext(venue.id),
      ]);
      console.log(
        `  sources: website=${website ? `${website.length}ch` : '✗'} wiki=${wiki ? '✓' : '✗'} events=${eventCtx.count}`,
      );

      const result = await callClaude(venue, { website, wiki, events: eventCtx });
      tokensIn += result.usage.in;
      tokensOut += result.usage.out;
      const len = result.description.length;
      const lenOk = len >= MIN_LEN - 50 && len <= MAX_LEN + 100;
      console.log(
        `  after (${len}, ${result.confidence}${lenOk ? '' : ' ⚠ outside range'}): ${result.description}`,
      );
      if (result.confidence === 'low') lowConf += 1;

      if (args.apply) {
        await db
          .update(venues)
          .set({ description: result.description })
          .where(sql`${venues.id} = ${venue.id}`);
        console.log(`  → written to DB`);
      }
      ok += 1;
    } catch (e) {
      console.error(`  ✗ failed: ${(e as Error).message}`);
      fail += 1;
    }
  }

  console.log(
    `\n[gen-desc] done. ok=${ok} fail=${fail} low-confidence=${lowConf} tokens=${tokensIn}in/${tokensOut}out`,
  );
  if (!args.apply && ok > 0) {
    console.log(`[gen-desc] dry-run — voeg --apply toe om naar DB te schrijven.`);
  }
  process.exit(fail > 0 ? 1 : 0);
}

main();
