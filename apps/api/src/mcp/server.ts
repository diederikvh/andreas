/**
 * MCP-server voor Andreas — biedt het event-aanbod (Amsterdam en de rest van
 * het land) aan als tool,
 * zodat externe AI-clients (Claude, ChatGPT, eigen agents) er met hún eigen
 * model doorheen kunnen zoeken. Wij leveren de verse, gestructureerde data;
 * de client doet het gesprek.
 *
 * `search_events`: zoeken op vaste velden (geen LLM aan onze kant), met
 * beschrijving en line-up, deeplinks terug naar Andreas. Voor ingelogde
 * gebruikers daarnaast de meldingstools uit `alerts.ts`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { registerAlertTools } from './alerts.js';
import { registerArtistTools } from './artists.js';
import { registerHelpTool } from './help.js';
import { registerMeTools } from './me.js';
import { schema } from '../db/index.js';
import { buildEventsUiResource } from './card.js';
import { GENRES, GENRE_KEYS } from '../alerts/genres.js';
import { CATEGORY_VALUES, logSearch, searchEvents, type McpEvent } from './events.js';

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

const EVENT_SHAPE = {
  id: z.string(),
  title: z.string(),
  category: z.string(),
  genres: z.array(z.string()),
  venue: z.string(),
  city: z.string(),
  wijk: z.string().nullable(),
  start: z.string(),
  end: z.string().nullable(),
  priceCents: z.number().nullable(),
  ticketUrl: z.string().nullable(),
  imageUrl: z.string().nullable(),
  url: z.string(),
  description: z.string().nullable(),
  lineup: z.array(z.object({ name: z.string(), genres: z.array(z.string()) })),
  why: z.string(),
};

const INSTRUCTIONS =
  'Andreas is een uitgaansgids: concerten, film, theater, kunst, lezingen en ' +
  'literatuur in Amsterdam en steden als Utrecht, Rotterdam, Den Haag, Haarlem, ' +
  'Eindhoven, Tilburg, Nijmegen, Groningen en Antwerpen. Beperk je niet tot ' +
  'Amsterdam tenzij de gebruiker dat vraagt. Vraagt de gebruiker wat hij met ' +
  'Andreas kan, gebruik dan `andreas_help`. Gebruik `search_events` om het ' +
  'écht beschikbare aanbod op te halen voor een periode en (optioneel) een ' +
  'type/genre. Toon alleen events die de tool teruggeeft — verzin nooit zelf ' +
  'titels, venues, tijden of prijzen. ' +
  'BELANGRIJK: presenteer elk event als een klikbare Markdown-link op de titel ' +
  '— [titel](url) — met de `url` uit het resultaat. Laat die links nooit weg, ' +
  'ook niet in een korte samenvatting of bij de eerste reactie: elke genoemde ' +
  'event moet doorklikbaar zijn naar zijn Andreas-pagina. ' +
  'Wil de gebruiker een seintje als er iets bijkomt ("laat me weten als…"), ' +
  'gebruik dan `create_alert` en volg de bevestigingsstap in die tool. ' +
  'Artiesten volgen, ontvolgen en voorstellen gaat met `list_followed_artists`, ' +
  '`follow_artists`, `unfollow_artists` en `artists_playing`. ' +
  'De eigen agenda (waar ga ik heen, wat heb ik gered, wie gaat er mee) staat in `my_plans`; ' +
  'wat vrienden gered hebben en waar ze heen gaan in `friends_plans`. ' +
  'Hartje, "ik ga", zalen volgen/blokkeren en genres leuk/niet leuk gaan met `save_event`, ' +
  '`set_going`, `set_venue` en `set_genre_taste`; `my_taste` toont wat er is ingesteld. ' +
  'Aanbevelingen met reden ("wat zou ik nog meer leuk vinden?") gaan via `recommend_events`; ' +
  'iets ervoor of erna in de buurt van een avond via `around_evening`.';

const TOOL_DESCRIPTION =
  'Zoek concrete events in Amsterdam en de rest van het land. Vertaal de vraag zelf naar de velden: ' +
  'periode (`from`/`to`, absolute datums; een dag loopt tot 06:00 de volgende ochtend), `cities`, ' +
  '`categories`, `genres` (vaste lijst), `venues` (zaalnamen), `artists`, en `query` alleen voor een ' +
  'woord uit de titel. Zonder periode: de komende 7 dagen, of een jaar als je op artiest of query zoekt. ' +
  'Geblokkeerde zalen en genres die de gebruiker niet leuk vindt vallen al weg. Elk event komt met ' +
  'beschrijving en line-up (met de genres van de artiesten): beoordeel daarmee zelf wat bij de vraag en ' +
  'de smaak past, en zoek breder (minder velden) als er weinig terugkomt. Verzin zelf nooit events.';

/** @param userId Ingelogde OAuth-gebruiker (of null bij service-key). Wordt
    gebruikt om zoekgedrag te loggen voor personalisatie. */
export function buildMcpServer(userId: string | null = null): McpServer {
  const server = new McpServer(
    { name: 'andreas-events', version: '1.0.0' },
    { instructions: INSTRUCTIONS }
  );

  server.registerTool(
    'search_events',
    {
      title: 'Zoek events',
      description: TOOL_DESCRIPTION,
      inputSchema: {
        from: DATE.optional().describe('Eerste dag (YYYY-MM-DD).'),
        to: DATE.optional().describe('Laatste dag (YYYY-MM-DD), tot en met.'),
        cities: z.array(z.enum(schema.city.enumValues)).optional().describe('Weglaten = overal.'),
        categories: z.array(z.enum(CATEGORY_VALUES)).optional().describe('Weglaten = alle soorten.'),
        genres: z
          .array(z.enum(GENRE_KEYS))
          .optional()
          .describe(`Vaste genres (OF): ${GENRE_KEYS.map((k) => `${k} (${GENRES[k].label})`).join(', ')}.`),
        venues: z.array(z.string()).optional().describe('Zaalnamen, bv. "Paradiso".'),
        artists: z.array(z.string()).optional().describe('Artiestnamen (in line-up of titel).'),
        query: z.string().optional().describe('Woord uit de titel of een naam in de line-up, bv. "Hamlet".'),
        limit: z.number().int().min(1).max(50).optional().describe('Aantal events (default 15, max 50).'),
      },
      outputSchema: {
        events: z.array(z.object(EVENT_SHAPE)),
        count: z.number(),
        total: z.number(),
        window: z.object({ from: z.string(), to: z.string() }),
      },
    },
    async (args) => {
      const { events, total, window, unknownVenues } = await searchEvents(userId, args);
      if (userId) await logSearch(userId, `(mcp) ${JSON.stringify(args)}`.slice(0, 500), args, events);
      const label = periodLabel(window.from, window.to);
      const structuredContent = { events, count: events.length, total, window };
      const unknown = unknownVenues.length ? `Onbekende zaal: ${unknownVenues.join(', ')}.\n` : '';
      // Drie lagen, progressive enhancement:
      //  - text: markdown met klikbare links, beschrijving en line-up (alle hosts)
      //  - resource (ui://): interactieve card-widget voor MCP-UI-hosts
      //  - structuredContent: machine-leesbaar voor programmatic clients
      return {
        content: [
          { type: 'text' as const, text: unknown + summarize(events, total, label) },
          buildEventsUiResource(events, label),
        ],
        structuredContent,
      };
    }
  );

  registerHelpTool(server, Boolean(userId));

  // Meldingen horen bij een persoon; via de service-key is er niemand.
  if (userId) {
    registerAlertTools(server, userId);
    registerArtistTools(server, userId);
    registerMeTools(server, userId);
  }

  return server;
}

const dayFmt = new Intl.DateTimeFormat('nl-NL', {
  timeZone: 'Europe/Amsterdam',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

/** "za 26 sep – vr 2 okt". `to` is exclusief (06:00 de dag erna). */
function periodLabel(from: string, to: string): string {
  const last = new Date(Date.parse(to) - 6 * 3_600_000 - 1);
  const a = dayFmt.format(new Date(from));
  const b = dayFmt.format(last);
  return a === b ? a : `${a} – ${b}`;
}

function summarize(events: McpEvent[], total: number, label: string): string {
  if (events.length === 0) return `Geen events gevonden voor ${label}. Zoek breder: minder velden of een langere periode.`;
  const lines = events.map((e) => {
    const day = new Date(e.start).toLocaleString('nl-NL', {
      timeZone: 'Europe/Amsterdam',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
    // Titel als Markdown-link → klikbaar in de client. `]` uit het label
    // strippen zodat een rare titel de link-syntax niet breekt.
    const title = e.title.replace(/[[\]]/g, '');
    const city =
      e.city !== 'amsterdam'
        ? ` (${e.city.split('-').map((p) => p[0].toUpperCase() + p.slice(1)).join(' ')})`
        : '';
    const lineup = e.lineup.length
      ? `\n  Line-up: ${e.lineup.map((l) => (l.genres.length ? `${l.name} (${l.genres.slice(0, 4).join(', ')})` : l.name)).join('; ')}`
      : '';
    const about = e.description ? `\n  ${e.description}` : '';
    const genres = e.genres.length ? ` · ${e.genres.slice(0, 3).join(', ')}` : '';
    return `- [${title}](${e.url}) — ${e.venue}${city}, ${day}${genres}${lineup}${about}`;
  });
  const more = total > events.length ? ` (van ${total}; verfijn of verhoog limit voor meer)` : '';
  return (
    `${events.length} events voor ${label}${more}:\n${lines.join('\n')}\n\n` +
    'Kies zelf wat past; presenteer elk event als [titel](url).'
  );
}
