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
