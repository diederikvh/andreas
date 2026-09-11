/**
 * Datumparser voor De Brakke Grond. Apart van brakkegrond.ts zodat de
 * logica te testen is zonder DB-verbinding — zie brakkegrond.test.ts.
 */
import { parseAmsterdamLocal } from './_amsterdam-tz.js';

const DUTCH_MONTHS_SHORT: Record<string, number> = {
  jan: 1, feb: 2, mrt: 3, mar: 3, maart: 3, apr: 4, mei: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dec: 12,
};

export type Slot = { startsAt: Date; endsAt: Date | null };

/** Zelfde drempel als refineKindByDuration: langer dan dit is het geen
    reeks voorstellingen meer maar een doorlopende periode. */
const SPAN_DAYS = 7;


/** "wo 21 okt '26" → de kale datum. Jaar staat er altijd bij, dus geen
    gok meer op basis van een anchor — dat ging sowieso mis voor alles
    verder dan een jaar vooruit, en hier staat programmering tot juli '27. */
function parseDayToken(token: string): { y: number; m: number; d: number } | null {
  const m = token.match(/(\d{1,2})\s+([a-z]{3,})\.?\s*'(\d{2})/i);
  if (!m) return null;
  const month = DUTCH_MONTHS_SHORT[m[2]!.slice(0, 3).toLowerCase()];
  if (!month) return null;
  return { y: 2000 + parseInt(m[3]!, 10), m: month, d: parseInt(m[1]!, 10) };
}

function atAmsterdam(p: { y: number; m: number; d: number }, hh: number, mi: number): Date {
  const pad = (n: number) => String(n).padStart(2, '0');
  return parseAmsterdamLocal(`${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(hh)}:${pad(mi)}:00`);
}

/**
 * De ticketkolom is de enige plek waar de speeldata betrouwbaar staan:
 *
 *   .event-detail__tickets-date   "wo 21 okt '26—do 22 okt '26"   reeks
 *                                 "vr 18 sep '26"                 los
 *                                 "vr 18 sep '26,zo 25 okt '26"   lijst
 *   .event-detail__tickets-info   "Grote zaal 20:00 uur"
 *
 * De tijd staat dus in een ánder element dan de datum; daarom vond een
 * regex over de datumtekst nooit iets.
 *
 * Per speeldag een occurrence, maar alleen als er een tijd staat én de
 * reeks kort is. Zonder tijd is het een expositie, residentie of
 * meerdaags festival — dat is één doorlopende periode, geen serie
 * voorstellingen. Mu.ZEE loopt van 14 apr tot 18 jul '27: als losse
 * dagen zijn dat 96 rijen die de agenda dichtslibben.
 */
export function parseTicketSlots(dateText: string, infoText: string): Slot[] {
  const t = infoText.match(/(\d{1,2})[:.](\d{2})/);
  const hh = t ? parseInt(t[1]!, 10) : 0;
  const mi = t ? parseInt(t[2]!, 10) : 0;
  const slots: Slot[] = [];

  for (const group of dateText.split(',')) {
    const parts = group.split(/[\u2014\u2013]/).map((x) => x.trim()).filter(Boolean);
    const from = parseDayToken(parts[0] ?? '');
    if (!from) continue;
    const to = parts.length > 1 ? parseDayToken(parts[1]!) : null;

    if (!to) {
      slots.push({ startsAt: atAmsterdam(from, hh, mi), endsAt: null });
      continue;
    }

    // Dagstappen via UTC: die kent geen DST, dus een reeks die over de
    // klokwissel heen loopt verschuift niet. De Amsterdam-offset komt er
    // per dag weer op in atAmsterdam.
    const firstUtc = Date.UTC(from.y, from.m - 1, from.d);
    const lastUtc = Date.UTC(to.y, to.m - 1, to.d);
    if (lastUtc < firstUtc) {
      slots.push({ startsAt: atAmsterdam(from, hh, mi), endsAt: null });
      continue;
    }
    const days = Math.round((lastUtc - firstUtc) / 86_400_000) + 1;

    if (t && days <= SPAN_DAYS) {
      for (const c = new Date(firstUtc); c.getTime() <= lastUtc; c.setUTCDate(c.getUTCDate() + 1)) {
        const day = { y: c.getUTCFullYear(), m: c.getUTCMonth() + 1, d: c.getUTCDate() };
        slots.push({ startsAt: atAmsterdam(day, hh, mi), endsAt: null });
      }
    } else {
      slots.push({ startsAt: atAmsterdam(from, hh, mi), endsAt: atAmsterdam(to, 23, 59) });
    }
  }
  return slots;
}
