import type { ApiEvent } from '@/lib/api';
import type { BadgeTone } from '@/mocks/feed';

/**
 * Shared display-helpers voor events. ApiEvent → strings/groepen die de
 * lijst- en detail-schermen direct kunnen renderen.
 */

export const DOW_NL_UPPER = ['ZO', 'MA', 'DI', 'WO', 'DO', 'VR', 'ZA'] as const;
export const DOW_NL_MIXED = ['Zo', 'Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za'] as const;
export const MONTHS_NL = [
  'JAN', 'FEB', 'MRT', 'APR', 'MEI', 'JUN',
  'JUL', 'AUG', 'SEP', 'OKT', 'NOV', 'DEC',
] as const;

export const CATEGORY_TICK: Record<ApiEvent['category'], BadgeTone> = {
  Muziek: 'acid',
  Theater: 'flare',
  Literatuur: 'plum',
  Film: 'azure',
};

export const CATEGORY_DOT: Record<ApiEvent['category'], string> = {
  Muziek: 'M',
  Theater: 'T',
  Literatuur: 'L',
  Film: 'F',
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

/** Loopminuten tussen twee punten (5 km/u → 12 min/km). */
export function walkingMinutes(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number }
): number {
  return Math.max(1, Math.round(distanceKm(from, to) * 12));
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
 */
export function socialWindow(mode: 'nacht' | 'dag'): SocialWindow {
  const now = new Date();

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

export function formatTime(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function formatPrice(cents: number | null): string {
  if (cents == null) return '—';
  if (cents === 0) return 'Gratis';
  return `€${(cents / 100).toFixed(2).replace('.', ',')}`;
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
        dow: DOW_NL_MIXED[d.getDay()],
        num: dd,
        month: MONTHS_NL[d.getMonth()],
        count: 1,
        events: [event],
      });
    }
  }
  return Array.from(map.values());
}
