/**
 * Tijd-vensters ("vanavond", "dit weekend", …) voor de "Voor jou"-horizon in
 * `routes/events.ts`. Puur, zonder DB; getest in retrieval.test.ts.
 */
import type { PreferenceProfile } from './types.js';

// ─── Tijd-window ────────────────────────────────────────────────────────────
// NL-logische dag wisselt om 06:00 (clubs die 02:00 nog draaien horen bij de
// avond ervoor). We rekenen in Europe/Amsterdam wall-clock en zetten om naar
// UTC-instants voor de timestamptz-query.

const NL_TZ = 'Europe/Amsterdam';
export const LOGICAL_DAY_BOUNDARY_HOUR = 6;

type NlParts = { year: number; month: number; day: number; hour: number; weekday: number };

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** Wall-clock onderdelen van een instant in Europe/Amsterdam. */
export function nlParts(date: Date): NlParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: NL_TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    weekday: 'short',
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    weekday: WEEKDAY_INDEX[parts.weekday as string] ?? 0,
  };
}

/** UTC-instant voor een NL wall-clock moment. Twee-pass zodat de DST-offset
    op het juiste moment wordt gepakt (DST-overgangsuur niet meegerekend). */
export function nlWallToUtc(year: number, month: number, day: number, hour: number): Date {
  const guess = Date.UTC(year, month - 1, day, hour, 0, 0);
  const offset = offsetMsAt(new Date(guess));
  return new Date(guess - offset);
}

function offsetMsAt(date: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: NL_TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - date.getTime();
}

export type TimeWindow = { from: Date; to: Date };

/**
 * Vertaal `profile.when` naar een harde [from, to)-window in UTC.
 *  - tonight       → nu t/m de eerstvolgende 06:00 NL (de logische dag).
 *  - this_weekend  → komende vr 18:00 t/m ma 06:00 NL (incl. lopend weekend).
 *  - specific      → die datum 06:00 t/m de volgende dag 06:00 NL.
 */
export function resolveWhenWindow(profile: PreferenceProfile, now: Date): TimeWindow {
  const p = nlParts(now);

  if (profile.when === 'specific' && profile.whenDate) {
    const [y, m, d] = profile.whenDate.split('-').map(Number);
    const from = nlWallToUtc(y, m, d, LOGICAL_DAY_BOUNDARY_HOUR);
    const to = new Date(from.getTime() + 24 * 3600 * 1000);
    return { from, to };
  }

  if (profile.when === 'this_weekend' || profile.when === 'next_weekend') {
    const dayStart = logicalDayStart(now, p);
    let friStart = weekendFridayStart(dayStart);
    if (profile.when === 'next_weekend') friStart = addDays(friStart, 7);
    const fp = nlParts(friStart);
    const friday18 = nlWallToUtc(fp.year, fp.month, fp.day, 18);
    // Lopend weekend: niet vóór 'nu' beginnen. Volgend weekend ligt sowieso
    // in de toekomst.
    const from = profile.when === 'this_weekend' ? maxDate(now, friday18) : friday18;
    const mp = nlParts(addDays(friStart, 3)); // maandag
    const to = nlWallToUtc(mp.year, mp.month, mp.day, LOGICAL_DAY_BOUNDARY_HOUR);
    return { from, to };
  }

  if (profile.when === 'this_week') {
    // Nu t/m de logische dag-grens over 7 dagen.
    const dayStart = logicalDayStart(now, p);
    const end = nlParts(addDays(dayStart, 7));
    const to = nlWallToUtc(end.year, end.month, end.day, LOGICAL_DAY_BOUNDARY_HOUR);
    return { from: now, to };
  }

  if (profile.when === 'next_week') {
    // De kalenderweek ná deze: komende maandag 06:00 t/m de maandag daarna.
    const dayStart = logicalDayStart(now, p);
    const nextMon = addDays(mondayOfWeek(dayStart), 7);
    const mp = nlParts(nextMon);
    const from = nlWallToUtc(mp.year, mp.month, mp.day, LOGICAL_DAY_BOUNDARY_HOUR);
    const ep = nlParts(addDays(nextMon, 7));
    const to = nlWallToUtc(ep.year, ep.month, ep.day, LOGICAL_DAY_BOUNDARY_HOUR);
    return { from, to };
  }

  if (profile.when === 'this_month') {
    // Nu t/m 06:00 op de 1e van de volgende maand.
    const nextMonth = p.month === 12 ? 1 : p.month + 1;
    const nextYear = p.month === 12 ? p.year + 1 : p.year;
    return { from: now, to: nlWallToUtc(nextYear, nextMonth, 1, LOGICAL_DAY_BOUNDARY_HOUR) };
  }

  if (profile.when === 'next_month') {
    // De 1e van volgende maand 06:00 t/m de 1e van de maand daarna.
    const m1 = p.month === 12 ? 1 : p.month + 1;
    const y1 = p.month === 12 ? p.year + 1 : p.year;
    const m2 = m1 === 12 ? 1 : m1 + 1;
    const y2 = m1 === 12 ? y1 + 1 : y1;
    return {
      from: nlWallToUtc(y1, m1, 1, LOGICAL_DAY_BOUNDARY_HOUR),
      to: nlWallToUtc(y2, m2, 1, LOGICAL_DAY_BOUNDARY_HOUR),
    };
  }

  if (profile.when === 'this_year') {
    // Nu t/m 06:00 op 1 januari van het volgende jaar.
    return { from: now, to: nlWallToUtc(p.year + 1, 1, 1, LOGICAL_DAY_BOUNDARY_HOUR) };
  }

  // tonight (default)
  const dayStart = logicalDayStart(now, p);
  const next = nlParts(addDays(dayStart, 1));
  const to = nlWallToUtc(next.year, next.month, next.day, LOGICAL_DAY_BOUNDARY_HOUR);
  return { from: now, to };
}

function logicalDayStart(now: Date, p: NlParts): Date {
  // Vóór 06:00 NL hoort bij de vorige kalenderdag.
  const base = p.hour < LOGICAL_DAY_BOUNDARY_HOUR ? addDays(now, -1) : now;
  const bp = nlParts(base);
  return nlWallToUtc(bp.year, bp.month, bp.day, LOGICAL_DAY_BOUNDARY_HOUR);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 3600 * 1000);
}

/** 06:00-start van de vrijdag van het weekend dat hoort bij `dayStart`. Als
    het al weekend is (vr/za/zo) → de vrijdag van dat lopende weekend. */
function weekendFridayStart(dayStart: Date): Date {
  const dow = nlParts(dayStart).weekday; // 0=zo … 6=za
  let daysToFri = (5 - dow + 7) % 7;
  if (dow === 6) daysToFri = -1; // za → vr ervoor
  else if (dow === 0) daysToFri = -2; // zo → vr ervoor
  return addDays(dayStart, daysToFri);
}

/** 06:00-start van de maandag van de week waarin `dayStart` valt. */
function mondayOfWeek(dayStart: Date): Date {
  const dow = nlParts(dayStart).weekday; // 0=zo … 6=za
  const daysSinceMon = (dow + 6) % 7; // ma=0, di=1 … zo=6
  return addDays(dayStart, -daysSinceMon);
}

function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

// ─── Prijs ──────────────────────────────────────────────────────────────────
