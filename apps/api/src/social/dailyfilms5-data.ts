import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  THEME_KEYS,
  getThemeByKey,
  type Theme,
  type ThemeKey,
} from './themes.js';

/**
 * Bouwt de DailyFilms5-props voor een gegeven thema. Hergebruikt de
 * pick-selector + hook + film-still-resolutie zodat de UI-knop én de
 * /video-props endpoint identieke output geven.
 */

export interface DailyFilms5Props {
  themeKicker: string;
  hook: string;
  audio: string;
  picks: Array<{
    imageUrl: string;
    title: string;
    venueName: string;
    dateLabel: string;
    timeLabel: string;
  }>;
}

/** Korte thema-naam voor "Andreas X …" pill — strakker dan de volle
 *  themeLabel ("Live muziek" → "Live"). */
export const KICKERS: Partial<Record<ThemeKey, string>> = {
  'theater': 'Theater',
  'live-music': 'Live',
  'film': 'Film',
  'weekend-kickoff': 'Weekend',
  'galleries': 'Galeries',
  'tonight': 'Vanavond',
  'week-preview': 'Week',
};

export const HOOKS: Partial<Record<ThemeKey, string>> = {
  'theater': 'De voorstellingen waar Amsterdam over praat',
  'live-music': 'De concerten die je deze week niet wil missen',
  'film': 'Films die je echt moet zien dit weekend in Amsterdam',
  'weekend-kickoff': 'Het weekend dat Amsterdam wakker schudt',
  'galleries': 'De tentoonstellingen waar Amsterdam naartoe gaat',
  'tonight': 'Wat je vanavond in Amsterdam wil doen',
  'week-preview': 'De week die Amsterdam aan het praten houdt',
};

function formatDateLabel(d: Date): string {
  const days = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
  const months = [
    'jan', 'feb', 'mrt', 'apr', 'mei', 'jun',
    'jul', 'aug', 'sep', 'okt', 'nov', 'dec',
  ];
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}`;
}

function formatTimeLabel(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Roept de pick-selector aan via een gedelegeerde callback (zodat we de
 * grote selectPicksForTheme-implementatie niet hoeven dupliceren).
 */
export async function fetchDailyFilms5Props(
  themeKey: string,
  selectPicks: (
    theme: Theme,
    options: { limit: number; skipIds: Set<string>; now: Date },
  ) => Promise<{
    picks: Array<{
      eventId: string;
      title: string;
      venueName: string;
      imageUrl: string;
      startsAt: Date;
    }>;
  }>,
): Promise<DailyFilms5Props> {
  const theme = getThemeByKey(themeKey);
  if (!theme) {
    throw new Error(
      `onbekend thema ${themeKey} — geldig: ${THEME_KEYS.join(', ')}`,
    );
  }
  const now = new Date();
  const { picks } = await selectPicks(theme, {
    limit: 6,
    skipIds: new Set(),
    now,
  });
  if (picks.length === 0) {
    throw new Error(`geen picks voor thema ${themeKey}`);
  }

  // Voor films: liever stillUrl > posterUrl > imageUrl.
  const useFilmImages = theme.key === 'film';
  const heroByEventId = new Map<string, string>();
  if (useFilmImages) {
    const rows = await db
      .select({
        id: schema.events.id,
        stillUrl: schema.events.stillUrl,
        posterUrl: schema.events.posterUrl,
        imageUrl: schema.events.imageUrl,
      })
      .from(schema.events)
      .where(inArray(schema.events.id, picks.map((p) => p.eventId)));
    for (const r of rows) {
      const url = r.stillUrl ?? r.posterUrl ?? r.imageUrl ?? null;
      if (url) heroByEventId.set(r.id, url);
    }
  }

  return {
    themeKicker: KICKERS[theme.key] ?? theme.label.nl,
    hook: HOOKS[theme.key] ?? theme.label.nl,
    audio: 'audio/daily.mp3',
    picks: picks.map((p) => ({
      imageUrl: heroByEventId.get(p.eventId) ?? p.imageUrl,
      title: p.title,
      venueName: p.venueName,
      dateLabel: formatDateLabel(new Date(p.startsAt)),
      timeLabel: formatTimeLabel(new Date(p.startsAt)),
    })),
  };
}
