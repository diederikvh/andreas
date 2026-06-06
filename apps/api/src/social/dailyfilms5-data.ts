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

/**
 * Een hook-zin opgesplitst in getypeerde units zodat elk deel zijn
 * eigen styling kan krijgen in de Remotion-intro.
 *
 *  - eyebrow   → categorie-label ("THEATER")
 *  - countLead → mini-label vlak boven count ("TOP") — ranglijst-signaal,
 *                zodat de eerste pick er echt toe doet, en de tweede,
 *                en de derde.
 *  - count     → het getal van de aftelbare lijst ("6") — wordt op
 *                render-tijd automatisch overschreven met picks.length
 *                zodat de belofte altijd klopt met wat volgt.
 *  - headline  → waar de lijst over gaat ("voorstellingen")
 *  - meta      → plek + tijd ("Amsterdam · komende 7 dagen")
 *
 * Sfeer mag terug als aparte gedempte unit (rol `meta`), niet vermengd
 * met de belofte.
 */
export type HookRole = 'eyebrow' | 'countLead' | 'count' | 'headline' | 'meta';

export interface HookUnit {
  role: HookRole;
  text: string;
}

export interface DailyFilms5Props {
  themeKicker: string;
  /** Legacy: platte hook-string voor carousel-render. */
  hook: string;
  /** Nieuwe gestructureerde hook voor de Remotion-intro. */
  hookUnits: HookUnit[];
  /** Eén-regelige titel boven de Overview-slide (laatste frame). */
  overviewTitle: string;
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
  'clubs': 'Club',
  'galleries': 'Galerie',
};

export const HOOKS: Partial<Record<ThemeKey, string>> = {
  'theater': 'De voorstellingen waar Amsterdam over praat',
  'live-music': 'De concerten die je deze week niet wil missen',
  'film': 'Films die je deze week wil zien',
  'clubs': 'De clubnachten waar Amsterdam naartoe gaat',
  'galleries': 'De tentoonstellingen waar Amsterdam naartoe gaat',
};

/**
 * Gestructureerde hooks per thema. De `count`-unit krijgt op render-tijd
 * de werkelijke `picks.length` als text-overschrijving — wat hier staat
 * is een placeholder voor type-soundness.
 *
 * Principe: één concrete belofte per hook (getal + categorie + plek +
 * tijd). Geen zachte bijzinnen als "die je echt moet zien".
 */
export const HOOK_UNITS: Partial<Record<ThemeKey, HookUnit[]>> = {
  'theater': [
    { role: 'eyebrow', text: 'THEATER' },
    { role: 'countLead', text: 'TOP' },
    { role: 'count', text: '6' },
    { role: 'headline', text: 'voorstellingen' },
    { role: 'meta', text: 'Amsterdam\n{date}' },
  ],
  'live-music': [
    { role: 'eyebrow', text: 'LIVE' },
    { role: 'countLead', text: 'TOP' },
    { role: 'count', text: '5' },
    { role: 'headline', text: 'concerten' },
    { role: 'meta', text: 'Amsterdam\n{date}' },
  ],
  'film': [
    { role: 'eyebrow', text: 'FILM' },
    { role: 'countLead', text: 'TOP' },
    { role: 'count', text: '6' },
    { role: 'headline', text: 'films in de filmhuizen' },
    { role: 'meta', text: 'Amsterdam\n{date}' },
  ],
  'clubs': [
    { role: 'eyebrow', text: 'CLUB' },
    { role: 'countLead', text: 'TOP' },
    { role: 'count', text: '6' },
    { role: 'headline', text: 'clubnachten' },
    { role: 'meta', text: 'Amsterdam\n{date}' },
  ],
  'galleries': [
    { role: 'eyebrow', text: 'EXPO' },
    { role: 'countLead', text: 'TOP' },
    { role: 'count', text: '6' },
    { role: 'headline', text: 'exposities' },
    { role: 'meta', text: 'Amsterdam\n{date}' },
  ],
};

/**
 * Eén-regelige titel voor de Overview-slide (laatste video-frame).
 * Komt op de plek van "Andreas X <ThemeKicker>" en moet zelfstandig
 * uitleggen wat de kijker heeft gezien.
 *
 *   {count}  → wordt vervangen door picks.length
 *
 * Voor themes zonder count blijft de zin gewoon staan zoals 'ie is.
 */
export const OVERVIEW_TITLES: Partial<Record<ThemeKey, string>> = {
  'theater': 'Top {count} voorstellingen deze week',
  'live-music': 'Top {count} concerten deze week',
  'film': 'Top {count} films deze week',
  'clubs': 'Top {count} clubnachten deze week',
  'galleries': 'Top {count} exposities deze week',
};

/**
 * Vervangt de placeholder-text van de count-unit door het werkelijke
 * aantal picks zodat de hook altijd matcht met wat volgt in de video.
 */
export function withDynamicCount(
  units: HookUnit[],
  count: number,
): HookUnit[] {
  return units.map((u) =>
    u.role === 'count' ? { ...u, text: String(count) } : u,
  );
}

/** Maandafkortingen NL — 3 letters, lowercase. */
const MONTHS_NL = [
  'jan', 'feb', 'mrt', 'apr', 'mei', 'jun',
  'jul', 'aug', 'sep', 'okt', 'nov', 'dec',
];

/**
 * Bouwt een korte date-range tekst voor de meta-unit, gebaseerd op
 * theme.windowDays + start-datum. Voorbeelden:
 *
 *   windowDays=1                   → "12 jun"
 *   windowDays=3, zelfde maand     → "13–15 jun"
 *   windowDays=7, maand-grens      → "28 jun – 4 jul"
 *
 * Geeft de carousel/video een tijdstempel zodat een terugkijker ook
 * later begrijpt over welke periode het ging.
 */
export function formatWindowRange(windowDays: number, now: Date): string {
  if (windowDays <= 1) {
    return `${now.getDate()} ${MONTHS_NL[now.getMonth()]}`;
  }
  const end = new Date(now.getTime() + (windowDays - 1) * 24 * 60 * 60 * 1000);
  const startDay = now.getDate();
  const endDay = end.getDate();
  if (now.getMonth() === end.getMonth()) {
    return `${startDay}–${endDay} ${MONTHS_NL[end.getMonth()]}`;
  }
  return `${startDay} ${MONTHS_NL[now.getMonth()]} – ${endDay} ${MONTHS_NL[end.getMonth()]}`;
}

/**
 * Vervangt het `{date}`-token in elke unit-text met de gegeven string.
 * Themes die geen {date}-token hebben (zoals galleries' "nu open")
 * blijven onaangetast — die zijn intrinsiek tijd-bestendig.
 */
export function withDynamicDate(
  units: HookUnit[],
  dateText: string,
): HookUnit[] {
  return units.map((u) =>
    u.text.includes('{date}')
      ? { ...u, text: u.text.replace('{date}', dateText) }
      : u,
  );
}

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

  // Hook-units: per-theme structured array. Twee dynamische overrides
  // op render-tijd:
  //   - count → werkelijke pick-count zodat de belofte altijd matcht.
  //   - {date} → concrete date-range zodat een terugkijker ook later
  //              ziet wanneer dit speelde (i.p.v. alleen 'dit weekend').
  const baseUnits: HookUnit[] = HOOK_UNITS[theme.key] ?? [
    { role: 'eyebrow', text: theme.label.nl },
    { role: 'count', text: String(picks.length) },
    { role: 'headline', text: 'highlights' },
    { role: 'meta', text: 'Amsterdam\n{date}' },
  ];
  const dateRange = formatWindowRange(theme.windowDays, now);
  const hookUnits = withDynamicDate(
    withDynamicCount(baseUnits, picks.length),
    dateRange,
  );

  const overviewTitleTemplate =
    OVERVIEW_TITLES[theme.key] ?? `Top ${picks.length} ${theme.label.nl}`;
  const overviewTitle = overviewTitleTemplate.replace(
    '{count}',
    String(picks.length),
  );

  return {
    themeKicker: KICKERS[theme.key] ?? theme.label.nl,
    hook: HOOKS[theme.key] ?? theme.label.nl,
    hookUnits,
    overviewTitle,
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
