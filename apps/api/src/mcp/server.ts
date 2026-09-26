/**
 * MCP-server voor Andreas — biedt het event-aanbod (Amsterdam en de rest van
 * het land) aan als tool,
 * zodat externe AI-clients (Claude, ChatGPT, eigen agents) er met hún eigen
 * model doorheen kunnen zoeken. Wij leveren de verse, gestructureerde data;
 * de client doet het gesprek.
 *
 * `search_events`: deterministische retrieval (geen LLM aan onze kant),
 * categorie als harde filter, deeplinks terug naar Andreas. Voor ingelogde
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
import {
  CATEGORY_VALUES,
  WHEN_VALUES,
  logMcpSearch,
  searchEvents,
  type McpEvent,
} from './events.js';

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
  'Aanbevelingen met reden ("wat zou ik nog meer leuk vinden?") gaan via `recommend_events`.';

const TOOL_DESCRIPTION =
  'Zoek concrete events voor een gegeven periode, in Amsterdam en de rest van het ' +
  'land (filter met `cities`). Geef `category` ' +
  'op (Muziek/Film/Theater/Kunst/Lezing/Literatuur) om strikt op één type te ' +
  'filteren; gebruik `query` voor een genre, sfeer, artiest of venue (bv. ' +
  '"techno", "singer-songwriter", "Guns N Roses", "Paradiso"). Retourneert ' +
  'volledige event-data met deeplinks; verzin zelf nooit events.';

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
        query: z
          .string()
          .optional()
          .describe('Genre, sfeer, artiest of venue, bv. "techno" of "Paradiso".'),
        when: z
          .enum(WHEN_VALUES)
          .optional()
          .describe('Periode. Default this_week. "next_*" = de periode ná deze.'),
        category: z
          .enum(CATEGORY_VALUES)
          .optional()
          .describe('Hard filter op één type. Weglaten = alle types (of afgeleid uit query).'),
        priceMax: z
          .number()
          .int()
          .min(0)
          .max(3)
          .optional()
          .describe('Max prijs-tier: 0 gratis · 1 ≤€15 · 2 ≤€35 · 3 duurder.'),
        cities: z
          .array(z.enum(schema.city.enumValues))
          .optional()
          .describe('Alleen deze steden. Weglaten = overal.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe('Aantal events (default 8, max 25).'),
      },
      outputSchema: {
        events: z.array(z.object(EVENT_SHAPE)),
        count: z.number(),
        window: z.object({ from: z.string(), to: z.string(), when: z.string() }),
      },
    },
    async (args) => {
      const { events, window } = await searchEvents(args);
      if (userId) await logMcpSearch(userId, args, events);
      const structuredContent = { events, count: events.length, window };
      // Drie lagen, progressive enhancement:
      //  - text: markdown-fallback met klikbare links (alle hosts)
      //  - resource (ui://): interactieve card-widget voor MCP-UI-hosts
      //  - structuredContent: machine-leesbaar voor programmatic clients
      return {
        content: [
          { type: 'text' as const, text: summarize(events, window.when) },
          buildEventsUiResource(events, window.when),
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

function summarize(events: McpEvent[], when: string): string {
  if (events.length === 0) {
    return `Geen events gevonden voor ${when} in deze zoekopdracht.`;
  }
  const lines = events.map((e) => {
    const d = new Date(e.start);
    const day = d.toLocaleString('nl-NL', {
      timeZone: 'Europe/Amsterdam',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
    const genre = e.genres[0] ? ` · ${e.genres[0]}` : '';
    // Titel als Markdown-link → klikbaar in de client, doorklikken naar de
    // Andreas-pagina (die deeplinkt naar de app). `]` uit het label strippen
    // zodat een rare titel de link-syntax niet breekt.
    const label = e.title.replace(/[[\]]/g, '');
    const city =
      e.city !== 'amsterdam'
        ? ` (${e.city.split('-').map((p) => p[0].toUpperCase() + p.slice(1)).join(' ')})`
        : '';
    return `- [${label}](${e.url}) — ${e.venue}${city}, ${day}${genre}`;
  });
  return (
    `${events.length} events voor ${when}:\n${lines.join('\n')}\n\n` +
    'Tik op een titel om de event-pagina op Andreas te openen.'
  );
}
