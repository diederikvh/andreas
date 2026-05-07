import type { ApiEvent, VenueType } from '@/lib/api';
import { useLocale, type Locale, useLocaleStore } from '@/lib/i18n';
import type { BadgeTone } from '@/lib/types';

/**
 * Shared display-helpers voor events. ApiEvent → strings/groepen die de
 * lijst- en detail-schermen direct kunnen renderen.
 */

export const DOW_NL_UPPER = ['ZO', 'MA', 'DI', 'WO', 'DO', 'VR', 'ZA'] as const;
export const DOW_NL_MIXED = ['Zo', 'Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za'] as const;
export const DOW_NL_FULL = [
  'Zondag', 'Maandag', 'Dinsdag', 'Woensdag', 'Donderdag', 'Vrijdag', 'Zaterdag',
] as const;
export const MONTHS_NL = [
  'JAN', 'FEB', 'MRT', 'APR', 'MEI', 'JUN',
  'JUL', 'AUG', 'SEP', 'OKT', 'NOV', 'DEC',
] as const;
export const MONTHS_NL_FULL = [
  'januari', 'februari', 'maart', 'april', 'mei', 'juni',
  'juli', 'augustus', 'september', 'oktober', 'november', 'december',
] as const;
export const DOW_EN_UPPER = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
export const DOW_EN_MIXED = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const;
export const DOW_EN_FULL = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;
export const MONTHS_EN = [
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
] as const;
export const MONTHS_EN_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/** Locale-aware wrappers — read the active locale at call time. */
export function dowUpper(dayIndex: number, locale?: Locale): string {
  const l = locale ?? useLocaleStore.getState().locale;
  return (l === 'nl' ? DOW_NL_UPPER : DOW_EN_UPPER)[dayIndex];
}
export function dowMixed(dayIndex: number, locale?: Locale): string {
  const l = locale ?? useLocaleStore.getState().locale;
  return (l === 'nl' ? DOW_NL_MIXED : DOW_EN_MIXED)[dayIndex];
}
export function dowFull(dayIndex: number, locale?: Locale): string {
  const l = locale ?? useLocaleStore.getState().locale;
  return (l === 'nl' ? DOW_NL_FULL : DOW_EN_FULL)[dayIndex];
}
export function monthShort(monthIndex: number, locale?: Locale): string {
  const l = locale ?? useLocaleStore.getState().locale;
  return (l === 'nl' ? MONTHS_NL : MONTHS_EN)[monthIndex];
}
export function monthFull(monthIndex: number, locale?: Locale): string {
  const l = locale ?? useLocaleStore.getState().locale;
  return (l === 'nl' ? MONTHS_NL_FULL : MONTHS_EN_FULL)[monthIndex];
}

export const CATEGORY_TICK: Record<ApiEvent['category'], BadgeTone> = {
  Muziek: 'acid',
  Theater: 'flare',
  Literatuur: 'plum',
  Film: 'azure',
  // Kunst deelt `plum` met galleries/musea — zelfde curatorial-vibe.
  Kunst: 'plum',
};

const CATEGORY_EN: Record<ApiEvent['category'], string> = {
  Muziek: 'Music',
  Theater: 'Theatre',
  Literatuur: 'Literature',
  Film: 'Film',
  Kunst: 'Art',
};

export function translateCategory(
  cat: ApiEvent['category'],
  locale?: Locale
): string {
  const l = locale ?? useLocaleStore.getState().locale;
  return l === 'nl' ? cat : CATEGORY_EN[cat];
}

/** Tone per venue-type — zelfde 4 brand-tones als event-categorieën,
 *  gemapt zodat verwante types een logische kleur delen (bv. boekhandel
 *  & Literatuur = plum; club & Muziek = acid). */
export const VENUE_TYPE_TICK: Record<VenueType, BadgeTone> = {
  podium: 'acid',
  club: 'flare',
  galerie: 'plum',
  museum: 'azure',
  film: 'azure',
  ruimte: 'flare',
  'boekhandel-cafe': 'plum',
};

const VENUE_TYPE_LABEL_NL: Record<VenueType, string> = {
  podium: 'Podium',
  club: 'Club',
  galerie: 'Galerie',
  museum: 'Museum',
  film: 'Film',
  ruimte: 'Ruimte',
  'boekhandel-cafe': 'Boekhandel',
};

const VENUE_TYPE_LABEL_EN: Record<VenueType, string> = {
  podium: 'Stage',
  club: 'Club',
  galerie: 'Gallery',
  museum: 'Museum',
  film: 'Cinema',
  ruimte: 'Space',
  'boekhandel-cafe': 'Bookshop',
};

export function translateVenueType(type: VenueType, locale?: Locale): string {
  const l = locale ?? useLocaleStore.getState().locale;
  return (l === 'nl' ? VENUE_TYPE_LABEL_NL : VENUE_TYPE_LABEL_EN)[type];
}

const VENUE_SCENE_LABEL_EN: Record<string, string> = {
  mainstream: 'Mainstream',
  alternatief: 'Alternative',
  underground: 'Underground',
  fringe: 'Fringe',
};

const VENUE_SCENE_LABEL_NL: Record<string, string> = {
  mainstream: 'Mainstream',
  alternatief: 'Alternatief',
  underground: 'Underground',
  fringe: 'Fringe',
};

export function translateVenueScene(scene: string, locale?: Locale): string {
  const l = locale ?? useLocaleStore.getState().locale;
  const map = l === 'nl' ? VENUE_SCENE_LABEL_NL : VENUE_SCENE_LABEL_EN;
  return map[scene] ?? scene;
}

export const CATEGORY_DOT: Record<ApiEvent['category'], string> = {
  Muziek: 'M',
  Theater: 'T',
  Literatuur: 'L',
  Film: 'F',
  Kunst: 'K',
};

/**
 * Haversine afstand in km tussen twee punten op de aarde. Voldoende voor
 * loopafstand binnen Amsterdam — geen geoid-correctie nodig.
 */
export function distanceKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

export type TransportMode = 'walk' | 'bike';

// Snelheid in km/u: 5 voor wandel, 15 voor stadse fiets.
const KMH: Record<TransportMode, number> = {
  walk: 5,
  bike: 15,
};

// Correctie-factor op hemelsbrede afstand om de werkelijke route in
// Amsterdam te benaderen (grachten + eenrichting + omlopen). Wandelaars
// raken meer omleidingen; fietsers volgen netter de rechte lijn.
const ROUTE_FACTOR: Record<TransportMode, number> = {
  walk: 1.3,
  bike: 1.15,
};

/**
 * Geschatte reisminuten tussen twee punten voor de gekozen mode.
 * Basis is hemelsbreed (Haversine) × route-factor om de Amsterdam-
 * realiteit te benaderen — geen externe routing-API.
 */
export function travelMinutes(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  mode: TransportMode = 'walk'
): number {
  const km = distanceKm(from, to) * ROUTE_FACTOR[mode];
  const minutes = (km / KMH[mode]) * 60;
  return Math.max(1, Math.round(minutes));
}

/** @deprecated gebruik `travelMinutes(from, to, 'walk')`. */
export function walkingMinutes(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number }
): number {
  return travelMinutes(from, to, 'walk');
}

// ─── Sociale dag-grenzen ──────────────────────────────────────────────
// "Vanavond" loopt van 17:00 tot 05:00 's ochtends; daarbuiten is het
// overdag. Wordt door Avond én Kaart gebruikt zodat "wat speelt nu"
// op beide plekken hetzelfde betekent.

export const NACHT_HOUR_THRESHOLD = 17;
export const NACHT_END_HOUR = 5;

export function isNachtHour(hour: number): boolean {
  return hour >= NACHT_HOUR_THRESHOLD || hour < NACHT_END_HOUR;
}

export type SocialWindow = {
  from: string;
  to: string;
  refDate: Date;
  shifted: boolean;
};

/**
 * Het "wat speelt nu / vandaag" venster — kleinst mogelijke subset.
 * Nacht-mode: de 17:00→05:00 bubbel die je nu beleeft. Dag-mode:
 * vandaag overdag, of (na 17:00) morgen overdag.
 *
 * `nowMs` is optioneel. Wordt typisch doorgegeven door `useNowMinute()`
 * zodat het venster (en dus de query-key voor /events) automatisch
 * meeschuift wanneer de gebruiker langer in de app blijft of de app
 * uit de achtergrond komt op een ander moment van de dag.
 */
export function socialWindow(
  mode: 'nacht' | 'dag',
  nowMs?: number
): SocialWindow {
  const now = nowMs !== undefined ? new Date(nowMs) : new Date();

  if (mode === 'nacht') {
    const start = new Date(now);
    start.setHours(NACHT_HOUR_THRESHOLD, 0, 0, 0);
    if (now.getHours() < NACHT_END_HOUR) {
      start.setDate(start.getDate() - 1);
    }
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    end.setHours(NACHT_END_HOUR, 0, 0, 0);
    const refDate = new Date(start);
    refDate.setHours(0, 0, 0, 0);
    return {
      from: start.toISOString(),
      to: end.toISOString(),
      refDate,
      shifted: false,
    };
  }

  const refDate = new Date(now);
  refDate.setHours(0, 0, 0, 0);
  let shifted = false;
  if (now.getHours() >= NACHT_HOUR_THRESHOLD) {
    refDate.setDate(refDate.getDate() + 1);
    shifted = true;
  }
  const to = new Date(refDate);
  to.setDate(to.getDate() + 1);
  return {
    from: refDate.toISOString(),
    to: to.toISOString(),
    refDate,
    shifted,
  };
}

// ─── Tijdsblokken voor de Agenda-filter ──────────────────────────────
// Vier vaste blokken die los staan van de app-modus (nacht/dag).
// Multi-select: de gebruiker kan bv. "Avond + Nacht" tegelijk kiezen.

export type TimeBlock = 'ochtend' | 'middag' | 'avond' | 'nacht';

export const TIME_BLOCKS: {
  id: TimeBlock;
  label: string;
  range: string;
}[] = [
  { id: 'ochtend', label: 'Ochtend', range: '06–12' },
  { id: 'middag', label: 'Middag', range: '12–18' },
  { id: 'avond', label: 'Avond', range: '18–23' },
  { id: 'nacht', label: 'Nacht', range: '23–06' },
];

/** Locale-aware variant — same shape, English labels for EN locale. */
export function useTimeBlocks(): typeof TIME_BLOCKS {
  const locale = useLocale();
  if (locale === 'nl') return TIME_BLOCKS;
  return [
    { id: 'ochtend', label: 'Morning', range: '06–12' },
    { id: 'middag', label: 'Afternoon', range: '12–18' },
    { id: 'avond', label: 'Evening', range: '18–23' },
    { id: 'nacht', label: 'Night', range: '23–06' },
  ];
}

export function getTimeBlock(hour: number): TimeBlock {
  if (hour >= 6 && hour < 12) return 'ochtend';
  if (hour >= 12 && hour < 18) return 'middag';
  if (hour >= 18 && hour < 23) return 'avond';
  return 'nacht';
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function formatPrice(cents: number | null, locale?: Locale): string {
  if (cents == null) return '—';
  const l = locale ?? useLocaleStore.getState().locale;
  if (cents === 0) return l === 'nl' ? 'Gratis' : 'Free';
  return l === 'nl'
    ? `€${(cents / 100).toFixed(2).replace('.', ',')}`
    : `€${(cents / 100).toFixed(2)}`;
}

export function freeLabel(locale?: Locale): string {
  const l = locale ?? useLocaleStore.getState().locale;
  return l === 'nl' ? 'gratis' : 'free';
}

export type EventGroup = {
  /** Stable id, e.g. "2026-05-08" */
  id: string;
  /** "Vr" / "Za" / "Wo" — first-letter capitalised */
  dow: string;
  /** "08" / "25" — zero-padded day of month */
  num: string;
  /** "MEI" / "APR" — uppercase NL month abbreviation */
  month: string;
  count: number;
  events: ApiEvent[];
};

/**
 * Groepeer een lijst events per kalenderdag (lokaal). Behoudt de
 * sortering binnen een dag (events komen al gesorteerd uit GET /events
 * via starts_at ascending).
 */
export function groupEventsByDay(events: ApiEvent[]): EventGroup[] {
  const map = new Map<string, EventGroup>();
  for (const event of events) {
    const d = new Date(event.startsAt);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const id = `${yyyy}-${mm}-${dd}`;
    const existing = map.get(id);
    if (existing) {
      existing.events.push(event);
      existing.count = existing.events.length;
    } else {
      map.set(id, {
        id,
        dow: dowMixed(d.getDay()),
        num: dd,
        month: monthShort(d.getMonth()),
        count: 1,
        events: [event],
      });
    }
  }
  return Array.from(map.values());
}

import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';

import type { ApiOccurrence } from './api';

/**
 * Tikt elke 60s een nieuwe `now`-timestamp uit zodat list-views
 * automatisch events laten vallen die hun eindtijd net gepasseerd zijn,
 * zonder dat we een server-roundtrip nodig hebben. Cache-stale (10 min)
 * + window-focus refetch dekken de server-side; deze hook dekt het
 * gat tussen refetches voor de client-side filter.
 */
export function useNowMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * Geeft een timestamp die alleen ververst bij **focus events**: tab-
 * focus (terug op deze tab) en app-resume (uit background). Niet
 * continuous — gebruik dit voor zaken die tijdens actief gebruik
 * stabiel moeten blijven (zoals het socialWindow op Avond) maar wél
 * mee moeten kantelen wanneer de gebruiker wegloopt en terugkomt.
 *
 * Verschil met `useNowMinute`: die tikt elke minuut tijdens gebruik,
 * deze tikt alleen op focus-events. Voor de Avond-window: tijdens
 * gebruik blijf je dus in dezelfde "vanavond"-bubbel ook als 17:00 of
 * middernacht passeert; pas wanneer je terugkomt op de tab is het
 * venster opnieuw ingesteld.
 */
export function useFocusedNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useFocusEffect(
    useCallback(() => {
      setNow(Date.now());
    }, [])
  );
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') setNow(Date.now());
    });
    return () => sub.remove();
  }, []);
  return now;
}

/**
 * Effectieve eindtijd van een occurrence in ms-since-epoch. Voor
 * occurrences zonder endsAt nemen we startsAt + 4u als default — dezelfde
 * fallback die de server gebruikt in z'n filter, dus de UI valt
 * consistent met de lijst.
 */
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
export function effectiveEndsAtMs(occ: ApiOccurrence): number {
  if (occ.endsAt) return new Date(occ.endsAt).getTime();
  return new Date(occ.startsAt).getTime() + FOUR_HOURS_MS;
}

/**
 * Eén tijd-rij in een list-view. Een event met N occurrences geeft N
 * rijen — zo verschijnt een 3-daagse festival op alle 3 dagen in de
 * Agenda en op zijn eigen tijdslot in de Avond.
 */
export type OccurrenceRow = {
  /** Stable key voor React-lists. */
  id: string;
  event: ApiEvent;
  occurrence: ApiOccurrence;
};

/**
 * Spread events naar één rij per occurrence. Gebruikt
 * `event.occurrencesInRange` als die er is (komt van list-endpoints met
 * occurrence-data). Fallback: maakt één rij van `event.startsAt` voor
 * mocks of oudere API-responses zonder occurrencesInRange.
 */
export function expandToOccurrenceRows(events: ApiEvent[]): OccurrenceRow[] {
  const rows: OccurrenceRow[] = [];
  for (const event of events) {
    const occs = event.occurrencesInRange;
    if (occs && occs.length > 0) {
      for (const occurrence of occs) {
        rows.push({
          id: `${event.id}::${occurrence.id}`,
          event,
          occurrence,
        });
      }
    } else if (event.startsAt) {
      // Synthetische occurrence vanuit gedenormaliseerde event-velden.
      rows.push({
        id: `${event.id}::next`,
        event,
        occurrence: {
          id: `${event.id}::next`,
          startsAt: event.startsAt,
          endsAt: event.endsAt,
          priceCents: event.priceCents,
          priceNote: event.priceNote ?? null,
          ticketUrl: event.ticketUrl,
          room: null,
          lineup: null,
          status: 'scheduled',
        },
      });
    }
  }
  return rows.sort(
    (a, b) =>
      new Date(a.occurrence.startsAt).getTime() -
      new Date(b.occurrence.startsAt).getTime()
  );
}

export type OccurrenceGroup = {
  id: string;
  dow: string;
  num: string;
  month: string;
  count: number;
  rows: OccurrenceRow[];
};

/**
 * Groepeer occurrence-rows per kalenderdag (lokaal). Geeft per dag de
 * rijen sorted op tijd. Eén event met meerdere occurrences op
 * verschillende dagen verschijnt op elke dag.
 */
export function groupOccurrenceRowsByDay(
  rows: OccurrenceRow[]
): OccurrenceGroup[] {
  const map = new Map<string, OccurrenceGroup>();
  for (const row of rows) {
    const d = new Date(row.occurrence.startsAt);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const id = `${yyyy}-${mm}-${dd}`;
    const existing = map.get(id);
    if (existing) {
      existing.rows.push(row);
      existing.count = existing.rows.length;
    } else {
      map.set(id, {
        id,
        dow: dowMixed(d.getDay()),
        num: dd,
        month: monthShort(d.getMonth()),
        count: 1,
        rows: [row],
      });
    }
  }
  return Array.from(map.values());
}
