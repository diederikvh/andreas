/**
 * Lichtgewicht iCal (RFC 5545) parser, beperkt tot wat WordPress-feeds
 * nodig hebben: VEVENT-blocks met DTSTART/DTEND/SUMMARY/DESCRIPTION/
 * URL/UID/ATTACH/CATEGORIES. Geen RRULE-expansie, geen VTIMEZONE-blok-
 * lezen — voor TZID gebruiken we Intl.DateTimeFormat om de offset op
 * de gegeven datum uit te rekenen (zomertijd-correct).
 *
 * Bewust geen npm-dependency: ICS is regelgebaseerd plain-text en de
 * subset die we hier nodig hebben past in 60 regels.
 */

export type ParsedVEvent = {
  uid: string;
  summary: string;
  description: string | null;
  startsAt: Date;
  endsAt: Date | null;
  url: string | null;
  imageUrl: string | null;
  categories: string[];
};

/** Unfold RFC 5545 line continuations: regels die beginnen met space of
 *  tab horen bij de vorige regel. */
function unfold(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** Unescape iCal text-values: `\n` → newline, `\,` → comma, `\;` → ; */
function unescapeText(s: string): string {
  return s
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

/** Minute-offset (positive = oost van UTC) van een tz op de gegeven datum. */
function offsetMinutesFor(tz: string, atDate: Date): number {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'longOffset',
    });
    const parts = dtf.formatToParts(atDate);
    const namePart = parts.find((p) => p.type === 'timeZoneName');
    if (!namePart) return 0;
    const m = namePart.value.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
    if (!m) return 0;
    const sign = m[1] === '+' ? 1 : -1;
    const hours = parseInt(m[2], 10);
    const minutes = parseInt(m[3] ?? '0', 10);
    return sign * (hours * 60 + minutes);
  } catch {
    return 0;
  }
}

/**
 * Parse iCal datetime: `20260507T200000` (floating local), `20260507T200000Z`
 * (UTC), of `20260507T200000` met een aparte TZID-parameter (lokaal in TZ).
 */
function parseICalDate(value: string, tzid: string | null): Date {
  const v = value.trim();
  // Date-only? bv. 20260507 (VALUE=DATE in iCal)
  const dateOnly = /^\d{8}$/.test(v);
  if (dateOnly) {
    const yyyy = v.slice(0, 4);
    const mm = v.slice(4, 6);
    const dd = v.slice(6, 8);
    return new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) throw new Error(`Onbekend datetime-formaat: ${v}`);
  const [, yyyy, mo, dd, hh, mi, ss, z] = m;
  const isoBare = `${yyyy}-${mo}-${dd}T${hh}:${mi}:${ss}`;
  if (z === 'Z' || !tzid) {
    return new Date(`${isoBare}Z`);
  }
  // Lokaal in TZ — bouw eerst tentative UTC, vraag offset, corrigeer.
  const tentative = new Date(`${isoBare}Z`);
  const offsetMin = offsetMinutesFor(tzid, tentative);
  return new Date(tentative.getTime() - offsetMin * 60_000);
}

/** Splits een prop-line in `name`, `params{}`, `value`. */
function splitProp(line: string): {
  name: string;
  params: Record<string, string>;
  value: string;
} | null {
  const colon = line.indexOf(':');
  if (colon === -1) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const segs = head.split(';');
  const name = segs[0].toUpperCase();
  const params: Record<string, string> = {};
  for (let i = 1; i < segs.length; i++) {
    const eq = segs[i].indexOf('=');
    if (eq !== -1) {
      params[segs[i].slice(0, eq).toUpperCase()] = segs[i].slice(eq + 1);
    }
  }
  return { name, params, value };
}

export function parseVEvents(ics: string): ParsedVEvent[] {
  const lines = unfold(ics);
  const events: ParsedVEvent[] = [];

  let inEvent = false;
  let cur: Partial<ParsedVEvent> & { categories: string[] } | null = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      inEvent = true;
      cur = { categories: [] };
      continue;
    }
    if (line === 'END:VEVENT') {
      if (
        cur &&
        cur.uid &&
        cur.summary &&
        cur.startsAt instanceof Date &&
        !isNaN(cur.startsAt.getTime())
      ) {
        events.push({
          uid: cur.uid,
          summary: cur.summary,
          description: cur.description ?? null,
          startsAt: cur.startsAt,
          endsAt: cur.endsAt ?? null,
          url: cur.url ?? null,
          imageUrl: cur.imageUrl ?? null,
          categories: cur.categories,
        });
      }
      cur = null;
      inEvent = false;
      continue;
    }
    if (!inEvent || !cur) continue;
    const prop = splitProp(line);
    if (!prop) continue;
    const { name, params, value } = prop;
    switch (name) {
      case 'UID':
        cur.uid = value.trim();
        break;
      case 'SUMMARY':
        cur.summary = unescapeText(value).trim();
        break;
      case 'DESCRIPTION':
        cur.description = unescapeText(value).trim() || null;
        break;
      case 'DTSTART':
        try {
          cur.startsAt = parseICalDate(value, params.TZID ?? null);
        } catch {}
        break;
      case 'DTEND':
        try {
          cur.endsAt = parseICalDate(value, params.TZID ?? null);
        } catch {}
        break;
      case 'URL':
        cur.url = value.trim() || null;
        break;
      case 'ATTACH':
        // ATTACH;FMTTYPE=image/jpeg:https://… — alleen images opslaan
        if ((params.FMTTYPE ?? '').toLowerCase().startsWith('image/')) {
          cur.imageUrl = value.trim() || null;
        }
        break;
      case 'CATEGORIES':
        cur.categories.push(
          ...value.split(',').map((c) => c.trim()).filter(Boolean)
        );
        break;
    }
  }
  return events;
}
