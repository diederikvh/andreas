/**
 * Day-themed social posts: één post per dag met een herkenbaar
 * concept dat de weekstructuur leesbaar maakt voor de IG-volger
 * ("op maandag is het theater-tips").
 *
 *   ma  theater         · komende 7 dagen
 *   di  live muziek     · komende 7 dagen (excl. clubs)
 *   wo  film            · deze week
 *   do  weekend kickoff · komend weekend  (clubs)
 *   vr  galleries       · dit weekend     (alleen galeries, geen musea)
 *   za  vanavond        · zaterdagavond   (mixed)
 *   zo  deze week       · komende 7 dagen (mixed preview)
 *
 * Window-expansie zit in selectPicksForTheme: heeft een dag te weinig
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
  | 'weekend-kickoff'
  | 'galleries'
  | 'tonight'
  | 'week-preview';

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
    windowLabel: { nl: 'Deze week', en: 'This week' },
    windowDays: 7,
    maxWindowDays: 14,
    categories: ['Film'],
  },
  {
    key: 'weekend-kickoff',
    weekday: 4,
    label: { nl: 'Weekend kickoff', en: 'Weekend kickoff' },
    windowLabel: { nl: 'Komend weekend', en: 'This weekend' },
    windowDays: 4,
    maxWindowDays: 11,
    venueTypes: ['club'],
  },
  {
    key: 'galleries',
    weekday: 5,
    label: { nl: 'Galleries', en: 'Galleries' },
    windowLabel: { nl: 'Dit weekend', en: 'This weekend' },
    windowDays: 3,
    maxWindowDays: 14,
    categories: ['Kunst'],
    venueTypes: ['galerie'],
  },
  {
    key: 'tonight',
    weekday: 6,
    label: { nl: 'Vanavond', en: 'Tonight' },
    windowLabel: { nl: 'Zaterdagavond', en: 'Saturday night' },
    windowDays: 1,
    maxWindowDays: 7,
  },
  {
    key: 'week-preview',
    weekday: 0,
    label: { nl: 'Deze week', en: 'This week' },
    windowLabel: { nl: 'Komende 7 dagen', en: 'Next 7 days' },
    windowDays: 7,
    maxWindowDays: 14,
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
export function getThemeForDate(at: Date): Theme {
  const wd = amsterdamWeekday(at);
  const found = THEMES.find((t) => t.weekday === wd);
  if (!found) throw new Error(`geen theme voor weekday=${wd}`);
  return found;
}

export function getThemeByKey(key: string): Theme | null {
  return THEMES.find((t) => t.key === key) ?? null;
}

export const THEME_KEYS = THEMES.map((t) => t.key) as readonly ThemeKey[];
