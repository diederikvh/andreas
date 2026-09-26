/**
 * Periodes van de gids als absolute datums (YYYY-MM-DD). Een dag loopt tot
 * 06:00 de volgende ochtend, net als overal in de app en op de server.
 */
export type ZoekWhen = 'tonight' | 'tomorrow' | 'weekend' | 'week' | 'month' | 'any';

/** YYYY-MM-DD in lokale tijd. */
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** Periode als absolute datums. Vóór 06:00 hoort het nog bij gisteravond. */
export function periodOf(when: ZoekWhen, now = new Date()): { from?: string; to?: string } {
  const today = new Date(now.getTime() - 6 * 3600 * 1000);
  const day = today.getDay(); // 0 = zondag
  switch (when) {
    case 'any':
      // De server kiest: een jaar bij een naam, anders een week.
      return {};
    case 'tonight':
      return { from: iso(today), to: iso(today) };
    case 'tomorrow':
      return { from: iso(addDays(today, 1)), to: iso(addDays(today, 1)) };
    case 'weekend': {
      // Vrijdag t/m zondag; ben je al in het weekend, dan vanaf vandaag.
      const toSunday = (7 - day) % 7;
      const friday = addDays(today, toSunday - 2);
      return { from: iso(friday > today ? friday : today), to: iso(addDays(today, toSunday)) };
    }
    case 'week':
      return { from: iso(today), to: iso(addDays(today, 6)) };
    case 'month':
      return { from: iso(today), to: iso(new Date(today.getFullYear(), today.getMonth() + 1, 0)) };
  }
}

