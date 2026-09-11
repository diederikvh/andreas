import type { OcrResult } from './importOcr';

/**
 * Van OCR-tekstblokken naar een gestructureerd event-concept.
 *
 * Dit is fase 3 van "Share naar Andreas". Puur en zonder React Native
 * imports, zodat `pnpm --filter @andreas/mobile test` het kan draaien op
 * echte OCR-uitkomsten.
 *
 * Twee bronnen, twee heel andere signalen — dat bepaalt de opzet:
 *
 *  - **Poster of screenshot**: layout zegt bijna alles. De grootste regel
 *    is de titel, de rest hangt eromheen.
 *  - **Ticket-PDF**: layout zegt niets. Gerenderd op mediaBox-maat komt
 *    élke regel op 10-14px uit en staat de titel kleiner dan de
 *    venue-regel. Daar moet het van patronen en van de venue-lijst komen.
 *
 * Dus: eerst alles wat op patronen te vinden is (datum, tijd, venue,
 * support), en de titel als laatste uit wat er overblijft — op grootte
 * als die informatie er is, anders op leesorde.
 *
 * Het resultaat is een *concept*. De gebruiker kan het op `/import`
 * aanpassen, en pas `toServerMetadata()` uit
 * [importPayload.ts](./importPayload.ts) bepaalt wat er naar de server mag.
 */

export type EventDraft = {
  title: string | null;
  artists: string[];
  venue: string | null;
  /** `YYYY-MM-DD` */
  date: string | null;
  /** `HH:MM`, 24-uurs */
  time: string | null;
  city: string | null;
};

export const EMPTY_DRAFT: EventDraft = {
  title: null,
  artists: [],
  venue: null,
  date: null,
  time: null,
  city: null,
};

/** Eén OCR-regel met de hoogte van z'n bounding box, plus het blok waar
    hij uit komt. Die index is nodig omdat ML Kit bij elkaar horende
    regels groepeert: matcht de venuenaam, dan hoort de adresregel eronder
    er ook bij en mag die niet meer als titel gelden. */
type Line = { text: string; height: number; block: number };

/**
 * Woorden die op een ticket bovenaan staan maar nooit de eventtitel zijn.
 * Bewust kort gehouden: liever een label missen dan een echte titel
 * weggooien.
 */
const LABELS =
  /^(e-?\s*ticket|ticket|tickets|admission|toegang|entree|entrance|order|bestelling|bestelbon|factuur|invoice|barcode|qr[- ]?code|scan|voorverkoop|presale)\b/i;

/** Regels die alleen ticket-administratie zijn. */
const TICKET_DATA =
  /(ticket|order|bestel|boeking|reference|klant)\s*(nr|no|nummer|number|id)?\.?\s*[:#]?\s*[\w-]*\d{4}/i;

const MONTHS: Record<string, number> = {
  januari: 1, january: 1, jan: 1,
  februari: 2, february: 2, feb: 2,
  maart: 3, march: 3, mrt: 3, maa: 3, mar: 3,
  april: 4, apr: 4,
  mei: 5, may: 5,
  juni: 6, june: 6, jun: 6,
  juli: 7, july: 7, jul: 7,
  augustus: 8, august: 8, aug: 8,
  september: 9, sept: 9, sep: 9,
  oktober: 10, october: 10, okt: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

/**
 * Kaal maken voor vergelijken: kleine letters, diacritieken eraf, en
 * álles wat geen letter of cijfer is weg.
 *
 * Die laatste stap doet het echte werk. OCR breekt woorden op plekken
 * waar geen spatie staat — "Weteringschans" kwam terug als "Weterings
 * chans" — en door spaties óók te verwijderen valt dat verschil weg.
 */
function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Zelfde normalisatie, maar mét woordgrenzen: niet-alfanumeriek wordt een
 * spatie in plaats van niets. Nodig omdat een kale vergelijking te grijpig
 * is — "Bret" zit ook in "Bretagne".
 */
function normalizeWords(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Blokken → regels. Een blok zonder regel-geometrie levert z'n eigen
    tekst op, zodat we nooit informatie kwijt zijn. */
function toLines(ocr: OcrResult): Line[] {
  const lines: Line[] = [];
  ocr.blocks.forEach((block, index) => {
    if (block.lines.length > 0) {
      for (const line of block.lines) {
        lines.push({
          text: line.text.trim(),
          height: line.box?.height ?? 0,
          block: index,
        });
      }
    } else {
      lines.push({
        text: block.text.trim(),
        height: block.box?.height ?? 0,
        block: index,
      });
    }
  });
  // Losse tekens zijn ruis. Een QR-vlak levert betrouwbaar één verdwaalde
  // letter op met een enorme bounding box — die werd anders de titel.
  return lines.filter((l) => l.text.replace(/[^a-zA-Z0-9]/g, '').length >= 3);
}

/**
 * Venue zoeken door de bekende namen in de tekst te herkennen, niet
 * andersom. Een poster zegt "PARADISO", een ticket "Paradiso Grote Zaal,
 * Weteringschans 6-8" — in beide gevallen zit de bekende naam ín de regel.
 *
 * Twee passes, want de twee fouten liggen aan weerszijden van elkaar:
 *
 *  1. **Hele woorden.** Zo matcht "Bret" wel als losse naam en niet in
 *     "Bretagne Sessions".
 *  2. **Spaties genegeerd, alleen voor namen van 8+ tekens.** Dit vangt de
 *     OCR-woordbreuk op ("Concert gebouw" → Concertgebouw). Bij een lange
 *     naam is zo'n match geen toeval; bij een korte wel, vandaar de grens.
 *
 * Geeft de index in `lines` terug, niet alleen de naam: de aanroeper moet
 * weten wélke regel het was om de adresregel eronder mee uit te sluiten.
 */
function findVenue(
  lines: Line[],
  venueNames: string[]
): { name: string; index: number } | null {
  const candidates = venueNames
    .map((name) => ({ name, words: normalizeWords(name), key: normalize(name) }))
    .filter((v) => v.key.length >= 3)
    // Langste eerst, zodat "Paradiso Noord" voor "Paradiso" gaat.
    .sort((a, b) => b.key.length - a.key.length);

  for (const [index, line] of lines.entries()) {
    const haystack = ` ${normalizeWords(line.text)} `;
    const hit = candidates.find((v) => haystack.includes(` ${v.words} `));
    if (hit) return { name: hit.name, index };
  }

  for (const [index, line] of lines.entries()) {
    const haystack = normalize(line.text);
    if (haystack.length === 0) continue;
    const hit = candidates.find(
      (v) => v.key.length >= 8 && haystack.includes(v.key)
    );
    if (hit) return { name: hit.name, index };
  }

  return null;
}

/**
 * Datum uit de volledige tekst. Herkent `18 oktober 2026`,
 * `zaterdag 18 okt`, `2026-10-18` en `18/10/2026`.
 *
 * Zonder jaartal kiezen we het eerstvolgende voorkomen vanaf `today`: een
 * poster zonder jaar gaat over de komende editie, niet over die van
 * vorig jaar.
 */
export function parseDate(text: string, today: Date): string | null {
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const d = asDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    if (d) return d;
  }

  const monthNames = Object.keys(MONTHS).join('|');
  const named = new RegExp(
    `\\b(\\d{1,2})\\s*(?:e|ste|de)?\\s+(${monthNames})\\b\\.?,?\\s*(\\d{4})?`,
    'i'
  ).exec(text);
  if (named) {
    const day = Number(named[1]);
    const month = MONTHS[named[2].toLowerCase()];
    const year = named[3] ? Number(named[3]) : inferYear(day, month, today);
    const d = asDate(year, month, day);
    if (d) return d;
  }

  const numeric = text.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/);
  if (numeric) {
    const year = Number(numeric[3]);
    const d = asDate(
      year < 100 ? 2000 + year : year,
      Number(numeric[2]),
      Number(numeric[1])
    );
    if (d) return d;
  }

  return null;
}

function inferYear(day: number, month: number, today: Date): number {
  const thisYear = today.getFullYear();
  const candidate = new Date(thisYear, month - 1, day);
  // Meer dan een dag in het verleden? Dan bedoelen ze volgend jaar.
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  return candidate < cutoff ? thisYear + 1 : thisYear;
}

function asDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (year < 2000 || year > 2100) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Tijd uit de volledige tekst, met voorkeur voor de aanvang.
 *
 * "deuren 19:30 - aanvang 20:30" moet 20:30 opleveren: de deuren zijn
 * niet het event. Daarom drie rondes — eerst een tijd met een
 * aanvang-woord ervoor, dan een tijd zonder deur-woord ervoor, en anders
 * de eerste die er staat.
 */
export function parseTime(text: string): string | null {
  const matches = [...text.matchAll(/\b(\d{1,2})\s*[:.hu]\s*(\d{2})\b/gi)];
  if (matches.length === 0) return null;

  const scored = matches
    .map((m) => {
      const hour = Number(m[1]);
      const minute = Number(m[2]);
      if (hour > 23 || minute > 59) return null;
      const before = text.slice(Math.max(0, (m.index ?? 0) - 24), m.index ?? 0);
      return {
        value: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
        isStart: /\b(aanvang|start|begint|begin|show|optreden|live|doors\s*open\s*\d*\s*$|van)\b[\s:–-]*$/i.test(
          before
        ),
        isDoors: /\b(deur|deuren|doors|inloop|zaal\s*open|open)\b[\s:–-]*$/i.test(before),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  if (scored.length === 0) return null;
  return (
    scored.find((s) => s.isStart)?.value ??
    scored.find((s) => !s.isDoors)?.value ??
    scored[0].value
  );
}

/** "support: Library Card", "met Library Card & Roosbeef" → losse namen. */
function parseSupport(lines: Line[]): string[] {
  for (const line of lines) {
    const m = line.text.match(
      /^(?:support|supports|met|with|w\/|plus|special\s+guests?)\s*[:–-]?\s*(.+)$/i
    );
    if (!m) continue;
    return m[1]
      .split(/[,&+/]|\s+en\s+|\s+and\s+/i)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2)
      .slice(0, 4);
  }
  return [];
}

/**
 * Titel kiezen uit wat na alle andere velden overblijft.
 *
 * Met bruikbare geometrie (poster, screenshot) is de hoogste regel de
 * titel. Zonder — of als alle regels even hoog zijn, zoals op een
 * gerenderde PDF — valt hij terug op leesorde, want dan staat de titel
 * vrijwel altijd boven de venue en de datum.
 */
function findTitle(lines: Line[], used: Set<number>): string | null {
  const candidates = lines.filter(
    (l, index) =>
      !used.has(index) &&
      !LABELS.test(l.text) &&
      !TICKET_DATA.test(l.text) &&
      // Een regel die alleen een datum of tijd is, is geen titel.
      !/^[\s\d:.\-/u]+$/i.test(l.text) &&
      !isMostlyDate(l.text)
  );
  if (candidates.length === 0) return null;

  // Grootte mag alleen beslissen als de hoogste regel er écht uitspringt.
  // Op een gerenderde PDF zit alles tussen 10 en 14px; dat verschil is
  // ruis, geen hiërarchie, en dan koos hij de adresregel als titel.
  const sorted = [...new Set(candidates.map((c) => c.height))].sort((a, b) => b - a);
  const [tallest, next] = sorted;
  if (tallest > 0 && (next === undefined || tallest >= next * 1.4)) {
    return candidates.reduce((a, b) => (b.height > a.height ? b : a)).text;
  }
  return candidates[0].text;
}

/** Regels als "zaterdag 18 oktober 2026" zijn datum, geen titel. */
function isMostlyDate(text: string): boolean {
  const monthNames = Object.keys(MONTHS).join('|');
  const dayNames =
    'maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag|monday|tuesday|wednesday|thursday|friday|saturday|sunday';
  const stripped = text
    .replace(new RegExp(`\\b(${monthNames}|${dayNames})\\b`, 'gi'), '')
    .replace(/\b(deuren|doors|aanvang|start|inloop|open|om|van|tot)\b/gi, '')
    .replace(/[\s\d:.\-/u,]/g, '');
  return stripped.length <= 2;
}

export function extractEventDraft(
  ocr: OcrResult,
  opts: { venueNames?: string[]; today?: Date; city?: string } = {}
): EventDraft {
  const lines = toLines(ocr);
  if (lines.length === 0) return EMPTY_DRAFT;

  const fullText = lines.map((l) => l.text).join('\n');
  const today = opts.today ?? new Date();
  const venueNames = opts.venueNames ?? [];

  const venueHit = findVenue(lines, venueNames);
  const venue = venueHit?.name ?? null;
  const date = parseDate(fullText, today);
  const time = parseTime(fullText);
  const support = parseSupport(lines);

  // Regels die al een veld vullen, kunnen de titel niet meer zijn.
  //
  // Voor de venue geldt dat ook voor de regels eróndér in hetzelfde blok:
  // ML Kit groepeert "PARADISO" en "Weteringschans 6-8, Amsterdam" tot één
  // blok, en die adresregel is net zo min een titel. Alleen naar beneden,
  // niet naar boven — op een poster kan de titel bóven de venuenaam in
  // hetzelfde blok staan en die willen we juist houden.
  const used = new Set<number>();
  if (venueHit) {
    const block = lines[venueHit.index].block;
    for (let i = venueHit.index; i < lines.length && lines[i].block === block; i++) {
      used.add(i);
    }
  }
  // Support alleen op de regel zelf: op een ticket-PDF staat de
  // support-regel in hetzelfde blok als de titel.
  lines.forEach((line, index) => {
    if (
      support.length > 0 &&
      /^(support|supports|met|with|w\/|plus)/i.test(line.text)
    ) {
      used.add(index);
    }
  });

  const title = findTitle(lines, used);

  // Stad: alleen als ze het zelf zeggen, of als de venue uit onze
  // Amsterdamse lijst kwam — dan is het geen gok maar een gevolg.
  const cityInText = /\bamsterdam\b/i.test(fullText) ? 'Amsterdam' : null;
  const city = cityInText ?? (venue ? (opts.city ?? 'Amsterdam') : null);

  return {
    title,
    // De titel van een poster ís meestal de artiest; dat is ook de vorm
    // die de featurelijn voorschrijft (`artists: ["Ploegendienst"]`).
    artists: [...(title ? [title] : []), ...support].slice(0, 8),
    venue,
    date,
    time,
    city,
  };
}
