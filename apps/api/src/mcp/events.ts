/**
 * Zoeklaag voor de MCP-server: vertaalt de tool-velden naar
 * `searchStructured` (`alerts/search.ts`). Geen model aan onze kant; de AI
 * van de gebruiker voert het gesprek en beoordeelt de smaak aan de hand van
 * beschrijving en line-up die we meesturen.
 */
import type { FoundEvent } from '../alerts/search.js';

export { PUBLIC_BASE_URL, logSearch, searchEvents } from '../alerts/search.js';

export const CATEGORY_VALUES = [
  'Muziek',
  'Film',
  'Theater',
  'Kunst',
  'Lezing',
  'Literatuur',
  'Activiteit',
] as const;

export type McpEvent = FoundEvent;
