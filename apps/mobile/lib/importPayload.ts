/**
 * De enige route van geïmporteerde content naar de Andreas-server.
 *
 * Het privacyprincipe uit de featurelijn is een harde ontwerpregel:
 * **tickets verlaten nooit het toestel**. Geen PDF, geen QR, geen
 * barcode, geen ticket- of ordernummer, geen persoonsgegevens, geen
 * volledige OCR-output. Wat wél mag is de publieke event-metadata die
 * nodig is om te matchen.
 *
 * Die regel is hier één functie, geen afspraak: {@link toServerMetadata}
 * is een whitelist. Alles wat niet in {@link ALLOWED_KEYS} staat bestaat
 * niet in het resultaat, ook niet als een latere fase het er per ongeluk
 * in stopt. Roep nooit een API-functie met een OCR-object aan — altijd
 * eerst hierlangs.
 *
 * Bewust geen "verwijder de gevaarlijke velden"-aanpak: dan moet je álles
 * voorzien wat ooit kan lekken. Een whitelist faalt de goede kant op.
 *
 * Zelfcheck: `lib/importPayload.test.ts` (pnpm --filter @andreas/mobile test).
 */

export type EventMetadata = {
  title: string | null;
  artists: string[];
  venue: string | null;
  date: string | null;
  time: string | null;
  city: string | null;
};

export const ALLOWED_KEYS = [
  'title',
  'artists',
  'venue',
  'date',
  'time',
  'city',
] as const;

/** Langste waarde die een echt veld kan hebben. Een OCR-dump van een
    ticket haalt dit altijd; een eventtitel nooit. */
const MAX_LEN: Record<string, number> = {
  title: 160,
  venue: 120,
  city: 80,
  artist: 120,
};

const MAX_ARTISTS = 8;

/** Acht of meer cijfers op een rij is geen titel maar een ticket-,
    order- of barcodenummer. Ook met streepjes/spaties ertussen, want zo
    printen ticketproviders ze. */
const NUMERIC_RUN = /(?:\d[ -]?){8,}/;

/** Woorden die alleen op een ticket staan. Komt zo'n woord in een veld
    voor, dan is de OCR uitgelopen en gooien we het veld weg. */
const TICKET_WORDS =
  /\b(?:barcode|qr|ticketnummer|ticket\s*(?:no|nr|number|id)|order\s*(?:no|nr|number|id)|ordernummer|bestelnummer|boekingsnummer|reference\s*(?:no|nr)|e-?ticket|rij\s*\d|seat|stoel|vak\b|iban|bsn)\b/i;

function cleanString(value: unknown, key: string): string | null {
  if (typeof value !== 'string') return null;
  // Eén regel, geen dubbele spaties. Een meerregelige waarde is per
  // definitie een tekstblok-dump en geen veld.
  if (/[\r\n]/.test(value)) return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) return null;
  if (trimmed.length > (MAX_LEN[key] ?? 160)) return null;
  if (NUMERIC_RUN.test(trimmed)) return null;
  if (TICKET_WORDS.test(trimmed)) return null;
  return trimmed;
}

/** `2026-10-18`, niets anders. Een datum die we niet kunnen normaliseren
    laten we liever weg dan dat we hem half meesturen. */
function cleanDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${y}-${mo}-${d}`;
}

/** `20:00` in 24-uursnotatie. */
function cleanTime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

function cleanArtists(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const cleaned = cleanString(item, 'artist');
    if (cleaned && !out.includes(cleaned)) out.push(cleaned);
    if (out.length === MAX_ARTISTS) break;
  }
  return out;
}

/**
 * Whitelist een lokaal herkend metadata-object tot wat naar de server mag.
 * Accepteert `unknown` met opzet: de aanroeper hoeft niet te bewijzen dat
 * z'n OCR-resultaat de goede vorm heeft, deze functie bepaalt dat.
 */
export function toServerMetadata(draft: unknown): EventMetadata {
  const src = (draft ?? {}) as Record<string, unknown>;
  return {
    title: cleanString(src.title, 'title'),
    artists: cleanArtists(src.artists),
    venue: cleanString(src.venue, 'venue'),
    date: cleanDate(src.date),
    time: cleanTime(src.time),
    city: cleanString(src.city, 'city'),
  };
}

/** Heeft dit genoeg om mee te matchen? Alleen een stad is niks. */
export function isMatchable(meta: EventMetadata): boolean {
  return Boolean(meta.title || meta.artists.length > 0 || meta.venue);
}
