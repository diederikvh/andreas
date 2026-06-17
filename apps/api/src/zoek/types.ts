/**
 * Types voor de conversationele zoek ("Andreas-gids"), API-lokaal.
 *
 * Bewust NIET uit `@andreas/shared` geïmporteerd: dat pakket wordt door de
 * Docker-build niet geresolved (de API heeft het nooit gebruikt en mobile
 * dupliceert z'n types ook lokaal). Mobile houdt een spiegelkopie in
 * apps/mobile/lib/api.ts — hou die in sync bij wijzigingen.
 */

/** Grove prijs-as voor filtering. Afgeleid uit occurrences.priceCents:
    0 gratis · 1 ≤ €15 · 2 ≤ €35 · 3 duurder. */
export type PriceTier = 0 | 1 | 2 | 3;

/** Wanneer de gebruiker uit wil. `specific` gebruikt `whenDate` (ISO date). */
export type ZoekWhen =
  | 'tonight'
  | 'this_weekend'
  | 'this_week'
  | 'this_month'
  | 'this_year'
  | 'next_weekend'
  | 'next_week'
  | 'next_month'
  | 'specific';

/** Het voorkeursprofiel: leeft binnen één gesprek, groeit per beurt. Exact
    het object dat v2 per gebruiker persisteert. */
export type PreferenceProfile = {
  want: string[];
  avoid: string[];
  excludeVenueIds: string[];
  excludeEventIds: string[];
  maxDistanceKm: number | null;
  priceMax: PriceTier | null;
  when: ZoekWhen;
  whenDate?: string;
  origin?: { lat: number; lng: number };
};

/** Lege default voor de eerste beurt. */
export const EMPTY_PROFILE: PreferenceProfile = {
  want: [],
  avoid: [],
  excludeVenueIds: [],
  excludeEventIds: [],
  maxDistanceKm: null,
  priceMax: null,
  when: 'tonight',
};

/** Compacte event-vorm die het LLM krijgt om te kiezen + te motiveren.
    Bewust mager: geen coördinaten of interne velden — scheelt tokens. */
export type ZoekCandidate = {
  id: string;
  title: string;
  venueId: string;
  venueName: string;
  start: string; // ISO 8601
  end?: string | null;
  genres: string[];
  priceTier: PriceTier | null;
  vibe: string[];
};

export type ZoekChatTurn = { role: 'user' | 'assistant'; content: string };
