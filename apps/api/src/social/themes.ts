/**
 * Day-themed social posts: één post per dag met een herkenbaar
 * concept dat de weekstructuur leesbaar maakt voor de IG-volger.
 * Alle thema's tonen "Top X in Amsterdam voor de komende 7 dagen".
 *
 *   ma  theater       · komende 7 dagen (alleen Theater)
 *   di  live muziek   · komende 7 dagen (Muziek excl. club-venues)
 *   wo  film          · komende 7 dagen (alleen Film)
 *   do  clubs         · komende 7 dagen (alleen club-venues)
 *   vr  galleries     · komende 7 dagen (alleen galerie-venues)
 *   za/zo: geen vast thema — admin kan handmatig kiezen.
 *
 * Window-expansie zit in selectPicksForTheme: heeft een week te weinig
 * candidates, dan groeit het venster (windowDays → +7 tot maxWindowDays)
 * tot er genoeg events zijn — i.p.v. de theme te wisselen.
 */

import { schema } from '../db/index.js';

type EventCategory = (typeof schema.events.category.enumValues)[number];
type VenueType = (typeof schema.venues.type.enumValues)[number];

export type ThemeKey =
  | 'theater'
  | 'live-music'
  | 'film'
  | 'clubs'
  | 'galleries';

export interface Theme {
  key: ThemeKey;
  /** 0 = Sunday … 6 = Saturday (Amsterdam tz). */
  weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  /** Hoofdlabel (kicker op slides). */
  label: { nl: string; en: string };
  /** Subtekst onder de label — geeft tijdseenheid weer. */
  windowLabel: { nl: string; en: string };
  /** Initial event-window (vandaag → vandaag + windowDays). */
  windowDays: number;
  /** Auto-expand ceiling — selectPicksForTheme groeit hierheen als er
      te weinig candidates zijn in het initiale window. */
  maxWindowDays: number;
  /** Whitelist categorieën (leeg = alle). */
  categories?: EventCategory[];
  /** Whitelist venue-types (leeg = alle). */
  venueTypes?: VenueType[];
  /** Blacklist venue-types — past ná de whitelist. */
  excludeVenueTypes?: VenueType[];
}

export const THEMES: readonly Theme[] = [
  {
    key: 'theater',
    weekday: 1,
    label: { nl: 'Theater', en: 'Theatre' },
    windowLabel: { nl: 'Komende 7 dagen', en: 'Next 7 days' },
    windowDays: 7,
    maxWindowDays: 28,
    categories: ['Theater'],
  },
  {
    key: 'live-music',
    weekday: 2,
    label: { nl: 'Live muziek', en: 'Live music' },
    windowLabel: { nl: 'Komende 7 dagen', en: 'Next 7 days' },
    windowDays: 7,
    maxWindowDays: 21,
    categories: ['Muziek'],
    excludeVenueTypes: ['club'],
  },
  {
    key: 'film',
    weekday: 3,
    label: { nl: 'Film', en: 'Film' },
    windowLabel: { nl: 'Komende 7 dagen', en: 'Next 7 days' },
    windowDays: 7,
    maxWindowDays: 14,
    categories: ['Film'],
  },
  {
    key: 'clubs',
    weekday: 4,
    label: { nl: 'Clubs', en: 'Clubs' },
    windowLabel: { nl: 'Komende 7 dagen', en: 'Next 7 days' },
    windowDays: 7,
    maxWindowDays: 14,
    venueTypes: ['club'],
  },
  {
    key: 'galleries',
    weekday: 5,
    label: { nl: 'Galleries', en: 'Galleries' },
    windowLabel: { nl: 'Komende 7 dagen', en: 'Next 7 days' },
    windowDays: 7,
    maxWindowDays: 28,
    categories: ['Kunst'],
    venueTypes: ['galerie'],
  },
];

const WEEKDAY_LOOKUP: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** Amsterdam-tz weekday (0=Sun..6=Sat) voor een given moment. */
export function amsterdamWeekday(at: Date): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Amsterdam',
    weekday: 'short',
  });
  return WEEKDAY_LOOKUP[fmt.format(at)] ?? 0;
}

/** Geef de theme voor de Amsterdam-dag waarop `at` valt. */
export function getThemeForDate(at: Date): Theme | null {
  const wd = amsterdamWeekday(at);
  return THEMES.find((t) => t.weekday === wd) ?? null;
}

export function getThemeByKey(key: string): Theme | null {
  return THEMES.find((t) => t.key === key) ?? null;
}

export const THEME_KEYS = THEMES.map((t) => t.key) as readonly ThemeKey[];
