/**
 * LLM-assisted multi-exhibition extraction. Voor traag-veranderende
 * content (musea, galleries) waar per-venue scrapers onhandig zijn:
 * één endpoint pakt elke URL, plukt de tekst, en laat Claude een
 * lijst tentoonstellingen extraheren met titel/datums/beschrijving.
 *
 * Workflow:
 *   1. Fetch HTML (HTTP eerst, Playwright fallback voor SPA's)
 *   2. Strip tot relevante body-text (head + scripts weg)
 *   3. Claude Sonnet 4.6 met tool-use voor structured output
 *   4. Return ParsedExhibition[] voor admin-review
 *
 * Admin reviewt + accepteert, daarna pas DB-insert.
 */

const MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_VERSION = '2023-06-01';

const SYSTEM_PROMPT =
  'Je bent een tentoonstelling-extractor voor een Amsterdamse cultuur-app.\n' +
  '\n' +
  'Je krijgt de HTML-tekst van een museum- of galerie-pagina. Roep `extract_exhibitions` aan met een lijst van ALLE tentoonstellingen die je vindt — huidige, aankomende, en doorlopende.\n' +
  '\n' +
  'Per tentoonstelling:\n' +
  '- title: officiële naam (geen "Tentoonstelling: " of "Now showing: " prefixes)\n' +
  '- startDate: YYYY-MM-DD. Niet beschikbaar? null.\n' +
  '- endDate: YYYY-MM-DD. Niet beschikbaar? null.\n' +
  '- description: 1-3 zinnen, plain text, in originele taal.\n' +
  '- imageUrl: absolute URL naar tile-image, of null.\n' +
  '- sourceUrl: absolute URL naar detail-page indien anders dan de listing-page, of null.\n' +
  '- category: één van "Kunst" | "Theater" | "Literatuur" | "Film" | "Muziek". Default voor musea/galleries: "Kunst".\n' +
  '\n' +
  'STRIKTE REGELS:\n' +
  '- Liever niets dan een gok. Een vermelding als "permanente collectie" zonder titel/datum: skippen.\n' +
  '- Datum-range "20 jan – 17 mei 2026" → startDate=2026-01-20, endDate=2026-05-17.\n' +
  '- "Vanaf 20 januari 2026" → startDate gevuld, endDate null.\n' +
  '- "Doorlopend" / "vast" → beide null.\n' +
  '- Skip items zonder titel.\n' +
  '- Skip "binnenkort" / "save the date" zonder concrete datums (als niet in een tentoonstelling-context).';

const TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    exhibitions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          startDate: { type: ['string', 'null'] },
          endDate: { type: ['string', 'null'] },
          description: { type: ['string', 'null'] },
          imageUrl: { type: ['string', 'null'] },
          sourceUrl: { type: ['string', 'null'] },
          category: {
            type: 'string',
            enum: ['Kunst', 'Theater', 'Literatuur', 'Film', 'Muziek'],
          },
        },
        required: ['title', 'startDate', 'endDate', 'category'],
      },
    },
  },
  required: ['exhibitions'],
} as const;

const TOOL_DEF = {
  name: 'extract_exhibitions',
  description:
    'Sla de lijst tentoonstellingen op die uit de HTML zijn geëxtraheerd.',
  input_schema: TOOL_INPUT_SCHEMA,
};

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36';

export type ParsedExhibition = {
  title: string;
  startDate: string | null;
  endDate: string | null;
  description: string | null;
  imageUrl: string | null;
  sourceUrl: string | null;
  category: 'Kunst' | 'Theater' | 'Literatuur' | 'Film' | 'Muziek';
};

export type ExtractResult = {
  url: string;
  exhibitions: ParsedExhibition[];
  fetchMethod: 'http' | 'playwright';
  htmlBytes: number;
  promptTokens: number | null;
  completionTokens: number | null;
};

/** Strip <script>/<style>/<svg>/<noscript> + commentaar; return body-text. */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/g, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<head[\s\S]*?<\/head>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Fetch met fallback naar Playwright voor SPA-sites. */
async function fetchPage(
  url: string,
): Promise<{ html: string; method: 'http' | 'playwright' }> {
  // HTTP eerst — snel + goedkoop.
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA } });
    if (r.ok) {
      const html = await r.text();
      // Heuristiek: te kleine body + Next.js/SPA-tekens → Playwright.
      const isSpa =
        html.length < 4000 ||
        /__NEXT_DATA__|<div id="root">\s*<\/div>|<div id="app">\s*<\/div>/.test(
          html,
        );
      if (!isSpa) return { html, method: 'http' };
    }
  } catch {
    // Skipping — fall through to Playwright.
  }

  // Playwright fallback.
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ userAgent: UA });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(1500);
    const html = await page.content();
    return { html, method: 'playwright' };
  } finally {
    await browser.close();
  }
}

/** Resolve relative URLs to absolute against the page URL. */
function makeAbsolute(href: string | null, base: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

export async function extractFromUrl(url: string): Promise<ExtractResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const { html, method } = await fetchPage(url);
  // Behoud links + image-src zodat Claude die kan oppikken; strip de rest.
  // We sturen ~tot 40K chars (= ~10K tokens) door — past in Claude's context.
  const text = stripHtml(html).slice(0, 40000);

  const userMessage =
    `URL: ${url}\n\n` +
    `HTML body-text (van site, gestript van scripts/style):\n\n${text}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8192,
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

  const raw = (toolUse.input as { exhibitions?: unknown[] }).exhibitions ?? [];
  const exhibitions: ParsedExhibition[] = (raw as Array<Record<string, unknown>>)
    .filter((e) => typeof e.title === 'string' && (e.title as string).trim().length > 1)
    .map((e) => ({
      title: String(e.title).trim(),
      startDate: typeof e.startDate === 'string' ? e.startDate : null,
      endDate: typeof e.endDate === 'string' ? e.endDate : null,
      description:
        typeof e.description === 'string' ? e.description.trim() : null,
      imageUrl: makeAbsolute(
        typeof e.imageUrl === 'string' ? e.imageUrl : null,
        url,
      ),
      sourceUrl: makeAbsolute(
        typeof e.sourceUrl === 'string' ? e.sourceUrl : null,
        url,
      ),
      category:
        typeof e.category === 'string' &&
        ['Kunst', 'Theater', 'Literatuur', 'Film', 'Muziek'].includes(
          e.category,
        )
          ? (e.category as ParsedExhibition['category'])
          : 'Kunst',
    }));

  return {
    url,
    exhibitions,
    fetchMethod: method,
    htmlBytes: html.length,
    promptTokens: data.usage?.input_tokens ?? null,
    completionTokens: data.usage?.output_tokens ?? null,
  };
}
