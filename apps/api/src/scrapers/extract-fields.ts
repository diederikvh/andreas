/**
 * Eén URL → een ingevuld admin-formulier.
 *
 * Zusje van [extract-from-url.ts](./extract-from-url.ts), dat hetzelfde
 * doet voor een héle agenda vol tentoonstellingen. Hier gaat het om één
 * ding: je hebt de pagina van een venue of van één event, en je wil niet
 * tien velden overtypen.
 *
 * Twee dingen zijn anders dan bij de agenda-extractor:
 *
 *  1. **JSON-LD blijft staan.** De agenda-extractor gooit alle `<script>`
 *     weg, maar juist daar zet vrijwel elke site z'n `PostalAddress`,
 *     `geo` en `openingHours` neer. Voor een adres met coördinaten is dat
 *     het verschil tussen raden en weten.
 *  2. **Niets invullen mag.** Elk veld mag null zijn. Een verzonnen
 *     adres of een gegokte coördinaat is erger dan een leeg veld: het
 *     eerste merk je pas als iemand voor een dichte deur staat.
 */
import { extractPage } from './extract-from-url.js';

const MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_VERSION = '2023-06-01';

export type ParsedVenue = {
  name: string | null;
  address: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  description: string | null;
  imageUrl: string | null;
  website: string | null;
};

export type ParsedEvent = {
  title: string | null;
  description: string | null;
  /** `YYYY-MM-DDTHH:MM` in lokale tijd — zo gaat het ook het formulier in. */
  startsAt: string | null;
  endsAt: string | null;
  venueName: string | null;
  priceCents: number | null;
  ticketUrl: string | null;
  imageUrl: string | null;
};

const VENUE_TOOL = {
  name: 'fill_venue',
  description: 'Vul de velden van één venue in op basis van de pagina.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: ['string', 'null'] },
      address: { type: ['string', 'null'] },
      city: { type: ['string', 'null'] },
      lat: { type: ['number', 'null'] },
      lng: { type: ['number', 'null'] },
      description: { type: ['string', 'null'] },
      imageUrl: { type: ['string', 'null'] },
      website: { type: ['string', 'null'] },
    },
    required: ['name'],
  },
} as const;

const EVENT_TOOL = {
  name: 'fill_event',
  description: 'Vul de velden van één event in op basis van de pagina.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: ['string', 'null'] },
      description: { type: ['string', 'null'] },
      startsAt: { type: ['string', 'null'] },
      endsAt: { type: ['string', 'null'] },
      venueName: { type: ['string', 'null'] },
      priceCents: { type: ['number', 'null'] },
      ticketUrl: { type: ['string', 'null'] },
      imageUrl: { type: ['string', 'null'] },
    },
    required: ['title'],
  },
} as const;

const VENUE_SYSTEM =
  'Je vult het venue-formulier van een Amsterdamse cultuur-app in op basis van één webpagina.\n' +
  '\n' +
  '- name: de naam zoals de plek zichzelf noemt, zonder plaatsnaam-suffix.\n' +
  '- address: straat + huisnummer. Zonder stad en zonder postcode.\n' +
  '- city: de stad.\n' +
  '- lat/lng: alleen uit een expliciete bron op de pagina (JSON-LD `geo`, een\n' +
  '  Google-Maps-link met coördinaten, een data-attribuut). NOOIT schatten op\n' +
  '  basis van het adres — liever null.\n' +
  '- description: 1-3 zinnen over wat voor plek dit is, in het Nederlands.\n' +
  '- imageUrl: absolute URL van een representatieve foto (og:image mag).\n' +
  '- website: de officiële site van de venue.\n' +
  '\n' +
  'Wat je niet zeker weet laat je null. Een verzonnen adres is erger dan een leeg veld.';

const EVENT_SYSTEM =
  'Je vult het event-formulier van een Amsterdamse cultuur-app in op basis van één webpagina.\n' +
  '\n' +
  '- title: de naam van het event, zonder venue-suffix en zonder datum.\n' +
  '- startsAt/endsAt: `YYYY-MM-DDTHH:MM` in lokale tijd. Alleen deur/aanvang die\n' +
  '  op de pagina staat; geen tijd genoemd? Dan alleen de datum met 20:00 als je\n' +
  '  dat kan verantwoorden, anders null.\n' +
  '- venueName: waar het plaatsvindt, zoals de pagina het noemt.\n' +
  '- priceCents: prijs in centen (€12,50 → 1250). Gratis → 0. Onbekend → null.\n' +
  '- ticketUrl: absolute URL waar je kaartjes koopt.\n' +
  '- imageUrl: absolute URL van de hoofdafbeelding.\n' +
  '\n' +
  'Wat je niet zeker weet laat je null. Liever een leeg veld dan een gok.';

async function askClaude<T>(
  system: string,
  tool: typeof VENUE_TOOL | typeof EVENT_TOOL,
  userMessage: string
): Promise<T> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      system,
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic ${response.status}: ${body.slice(0, 300)}`);
  }
  const data = (await response.json()) as {
    content: Array<{ type: string; name?: string; input?: unknown }>;
  };
  const toolUse = data.content.find(
    (c) => c.type === 'tool_use' && c.name === tool.name
  );
  if (!toolUse?.input || typeof toolUse.input !== 'object') {
    throw new Error('Claude gaf geen tool_use terug');
  }
  return toolUse.input as T;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function absolute(href: string | null, base: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

/** Venue-velden uit één pagina. */
export async function venueFromUrl(url: string): Promise<ParsedVenue> {
  const { text, jsonLd } = await extractPage(url);
  const raw = await askClaude<Record<string, unknown>>(
    VENUE_SYSTEM,
    VENUE_TOOL,
    `URL: ${url}\n\nJSON-LD van de pagina:\n${jsonLd}\n\nPaginatekst:\n${text}`
  );
  return {
    name: str(raw.name),
    address: str(raw.address),
    city: str(raw.city),
    lat: num(raw.lat),
    lng: num(raw.lng),
    description: str(raw.description),
    imageUrl: absolute(str(raw.imageUrl), url),
    website: absolute(str(raw.website), url) ?? url,
  };
}

/** Event-velden uit één pagina. */
export async function eventFromUrl(url: string): Promise<ParsedEvent> {
  const { text, jsonLd } = await extractPage(url);
  const raw = await askClaude<Record<string, unknown>>(
    EVENT_SYSTEM,
    EVENT_TOOL,
    `URL: ${url}\n\nJSON-LD van de pagina:\n${jsonLd}\n\nPaginatekst:\n${text}`
  );
  return {
    title: str(raw.title),
    description: str(raw.description),
    startsAt: str(raw.startsAt),
    endsAt: str(raw.endsAt),
    venueName: str(raw.venueName),
    priceCents: num(raw.priceCents),
    ticketUrl: absolute(str(raw.ticketUrl), url),
    imageUrl: absolute(str(raw.imageUrl), url),
  };
}
