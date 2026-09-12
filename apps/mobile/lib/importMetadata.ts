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

/**
 * Woorden die op een kaartje het *soort* kaartje beschrijven, of de
 * ticketboer die het drukte. Nooit de naam van wat je gaat zien, wél vaak
 * in een groot lettertype — op een Paylogic-kaartje staat "Paylogic
 * Customer Care" vier keer zo groot als de band.
 */
const TICKET_TYPE =
  /^(normaal|normal|standaard|standard|regulier|regular|early\s*bird|vroege\s*vogel|student|senior|kind|child|combi|dagticket|weekendticket|staanplaats|zitplaats|entree|toegang)\b|lidmaatschap|membership|paylogic|stager|eventix|ticketmaster|see\s*tickets|eventbrite|weeztix|ticketswap|yourticketprovider|active\s*tickets/i;

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
/**
 * Hoeveel tekens er tussen twee woorden zitten. Klein en zonder
 * optimalisaties: we vergelijken een handvol regels met een paar honderd
 * zaalnamen, geen woordenboeken.
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = row;
  }
  return prev[b.length];
}

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

  // 3. Bijna goed. Een logo waar een QR doorheen loopt levert "Pagadiso"
  //    op, en dat is geen titel maar een zaal met één verkeerde letter.
  //    Alleen op een hele regel vergelijken en alleen bij namen die lang
  //    genoeg zijn: bij korte namen is één letter verschil een ander
  //    woord.
  for (const [index, line] of lines.entries()) {
    const haystack = normalize(line.text);
    if (haystack.length < 5) continue;
    const hit = candidates.find((v) => {
      if (v.key.length < 5) return false;
      const room = v.key.length >= 8 ? 2 : 1;
      return editDistance(haystack, v.key) <= room;
    });
    if (hit) return { name: hit.name, index };
  }

  return null;
}

/**
 * Elke regel die een zaal noemt, of er één letter naast zit.
 *
 * `findVenue` stopt bij de eerste treffer, want die vult het veld. Voor de
 * titel moeten we ze allemaal weten: op het Paradiso-kaartje kwam de zaal
 * uit het adresblok terwijl het logo bovenaan — met een QR er dwars
 * doorheen, gelezen als "Pagadiso" — de grootste regel was en dus titel
 * werd. Een zaalnaam is nooit de naam van wat je gaat zien.
 */
function venueLikeLines(lines: Line[], venueNames: string[]): number[] {
  const keys = venueNames
    .map((name) => ({ words: normalizeWords(name), key: normalize(name) }))
    .filter((v) => v.key.length >= 3);
  const hits: number[] = [];
  for (const [index, line] of lines.entries()) {
    const words = ` ${normalizeWords(line.text)} `;
    const flat = normalize(line.text);
    const hit = keys.some(
      (v) =>
        words.includes(` ${v.words} `) ||
        (v.key.length >= 8 && flat.includes(v.key)) ||
        (v.key.length >= 5 &&
          flat.length >= 5 &&
          editDistance(flat, v.key) <= (v.key.length >= 8 ? 2 : 1))
    );
    if (hit) hits.push(index);
  }
  return hits;
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
  // Een tourposter staat vol met "14.11 DUBLIN, IE" — dat is een datum,
  // geen tijd, en zonder dit werd de eerste speeldatum 14:11. Staan er
  // drie of meer van die puntparen, dan is de punt in dit document een
  // datumscheiding en luisteren we alleen nog naar de dubbele punt.
  const dotDates = [...text.matchAll(/\b\d{1,2}\.\d{1,2}\b/g)].length;
  const separator = dotDates >= 3 ? '[:hu]' : '[:.hu]';
  const matches = [
    ...text.matchAll(
      new RegExp(`\\b(\\d{1,2})\\s*${separator}\\s*([\\dOoIl)]{2})`, 'gi')
    ),
  ];
  if (matches.length === 0) return null;

  const scored = matches
    .map((m) => {
      const hour = Number(m[1]);
      // ML Kit leest de nullen op een ticket geregeld als ) of O:
      // "21:00" komt binnen als "21:0)". Een uur heeft altijd twee
      // cijfers achter de dubbele punt, dus dit is te repareren.
      const minute = Number(m[2].replace(/[Oo)]/g, '0').replace(/[Il]/g, '1'));
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
      // "met 40% korting" matcht dezelfde vorm als "met Library Card",
      // maar een kortingsregel is geen support-act.
      .filter((s) => !/\d\s*%|korting|discount|gratis|free\b/i.test(s))
      .slice(0, 4);
  }
  return [];
}

/**
 * De adresregel van een ticket: `De Roma - Turnhoutsebaan 286 - 2140
 * Borgerhout`, of `Paradiso, Weteringschans 6-8, 1017 SG Amsterdam`.
 *
 * Waarom dit bestaat: `findVenue` kent alleen de venues die Andreas al in
 * z'n database heeft, en dat zijn Amsterdamse. Een kaartje voor De Roma in
 * Borgerhout leverde dus geen venue én geen stad op, terwijl het er
 * letterlijk stond. Deze regel is specifiek genoeg om veilig te zijn: hij
 * eist een straat mét huisnummer én een postcode, en pakt alleen de
 * segmenten eromheen.
 */
function findLocationLine(
  lines: Line[]
): { venue: string | null; city: string | null; indices: number[] } | null {
  // NL: 1017 SG Amsterdam · BE: 2140 Borgerhout · DE: 10178 Berlin.
  // De stad is wat ná de postcode komt; die eruit knippen en de rest
  // houden gaf het hele adres terug ("Turnhoutsebaan 286 - Borgerhout").
  const CITY_AFTER_POSTCODE =
    /\b(?:\d{4}\s?[A-Z]{2}|\d{4,5})\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’ -]{1,38})\s*$/;
  const STREET = /\b[a-zà-ÿ]{3,}\s+\d+([-–]\d+)?\b/i;
  // Dezelfde postcode+plaats, maar dan als hele regel: een ticketprovider
  // drukt het adres vaak onder elkaar af in plaats van achter elkaar.
  const POSTCODE_CITY =
    /^\s*(?:\d{4}\s?[A-Z]{2}|\d{4,5})\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’ -]{1,38})\s*$/;
  // OCR levert wisselende streepjes: hyphen, en dash, em dash, minus,
  // soms een bullet. Allemaal hetzelfde scheidingsteken.
  const SEPARATOR = /\s+[-–—‒−•·]\s+|,\s*/;

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].text;
    // "zaterdag 03 april 2027 - 20u00" ziet er als adres uit: "april 2027"
    // is straat-plus-nummer en 2027 is een geldige postcode. Datumregels
    // gaan er dus eerst uit.
    if (isMostlyDate(text)) continue;
    if (!STREET.test(text)) continue;

    const parts = text
      .split(SEPARATOR)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    if (parts.length >= 2) {
      // Stad: het laatste segment dat op "postcode + naam" eindigt. Zit
      // die vorm er niet in, dan laten we de stad leeg — een gok op basis
      // van "het laatste woord" levert een straatnaam op.
      let city: string | null = null;
      for (const part of [...parts].reverse()) {
        const m = part.match(CITY_AFTER_POSTCODE);
        if (m) {
          city = m[1].trim();
          break;
        }
      }

      // Venue: het eerste segment zonder cijfers. Staat er geen naam voor
      // het adres, dan blijft dit leeg in plaats van de straat te pakken.
      const venue = /\d/.test(parts[0]) ? null : parts[0];
      if (venue || city) return { venue, city, indices: [i] };
    }

    // Hetzelfde adres, maar onder elkaar afgedrukt:
    //
    //     Cinetol
    //     Tolstraat 182
    //     1074 VM Amsterdam
    //
    // Zonder deze tak telt geen van die regels als "al gebruikt", en op
    // een ticket zoeken we de titel bóven de datum — dan werd "1074 VM
    // Amsterdam" de titel van je avond (Stager-kaartje, 12 sep 2026).
    const below = lines[i + 1];
    const postcode =
      below && !isMostlyDate(below.text)
        ? below.text.match(POSTCODE_CITY)
        : null;
    if (!postcode) continue;

    // De regel erboven is de zaal. Alleen als het er ook naar uitziet:
    // geen cijfers, geen datum, geen ticketopschrift.
    const above = lines[i - 1];
    const venueAbove =
      above &&
      !/\d/.test(above.text) &&
      !isMostlyDate(above.text) &&
      !LABELS.test(above.text)
        ? above.text
        : null;

    return {
      venue: venueAbove,
      city: postcode[1].trim(),
      indices: venueAbove ? [i - 1, i, i + 1] : [i, i + 1],
    };
  }
  return null;
}

/**
 * Titel kiezen uit wat na alle andere velden overblijft.
 *
 * Met bruikbare geometrie (poster, screenshot) is de hoogste regel de
 * titel. Zonder — of als alle regels even hoog zijn, zoals op een
 * gerenderde PDF — valt hij terug op leesorde, want dan staat de titel
 * vrijwel altijd boven de venue en de datum.
 */
function findTitle(
  lines: Line[],
  used: Set<number>,
  /** Op een ticket: de index van de datumregel. Dan zoeken we omhoog
      vanaf daar in plaats van naar de grootste regel te kijken — het
      grootste element op een kaartje is het logo van de zaal, en dat
      OCR't ook nog eens slecht ("De Roma" werd "Bma"). De naam van wat je
      gaat zien staat vlak boven de datum. */
  aboveIndex?: number
): string | null {
  const ok = (l: Line, index: number) =>
    !used.has(index) &&
    !LABELS.test(l.text) &&
    !TICKET_DATA.test(l.text) &&
    !TICKET_TYPE.test(l.text) &&
    // Een regel die alleen een datum of tijd is, is geen titel.
    !/^[\s\d:.\-/u]+$/i.test(l.text) &&
    !isMostlyDate(l.text);

  if (aboveIndex !== undefined) {
    for (let i = aboveIndex - 1; i >= 0; i--) {
      if (ok(lines[i], i)) return lines[i].text;
    }
  }

  const candidates = lines.filter((l, index) => ok(l, index));
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

/** Ruis die als bestandsnaam voorkomt maar nooit een event is. */
const FILE_NOISE =
  /^(download|document|bestand|file|scan|scan\d*|bijlage|attachment|untitled|naamloos|image|img|foto|photo|screenshot|whatsapp.*|afbeelding|print|pdf)$/i;

/** Segmenten die over de bestelling gaan in plaats van over de avond. */
const FILE_ADMIN =
  /^(order|orders|bestelling|bestelnummer|ticket|tickets|e-?ticket|e-?tickets|invoice|factuur|bevestiging|confirmation|reservering|reservation|booking)\b/i;

/**
 * De bestandsnaam als titelkandidaat.
 *
 * Ticketproviders zetten de naam van het event erin — "The Afghan Whigs -
 * order 165876208.pdf", "Stager Tickets - Cinetol - Event De Nachtelijke
 * Escapades support Scout.pdf". Die naam is getypt en niet gelezen, en
 * dat maakt 'm sterk precies waar OCR zwak is: een logo dat door een QR
 * heen loopt las hij als "Pagadiso", terwijl in de bestandsnaam gewoon
 * "The Afghan Whigs" stond.
 *
 * Eruit: bestelnummers, het woord ticket zelf, de zaal (die kennen we al)
 * en algemene ruis. Wat overblijft is het langste stuk — dat is in de
 * praktijk de eventnaam.
 *
 * Let op: dit is metadata van de deler, geen OCR. Het mag dus ook hier
 * niet buiten de whitelist om naar de server; `toServerMetadata` blijft
 * de enige uitgang.
 */
export function titleFromFileName(
  name: string | null | undefined,
  venueNames: string[] = []
): string | null {
  if (!name) return null;
  const known = new Set(venueNames.map((v) => normalize(v)));
  const parts = name
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .split(/\s*[-–—|]\s+|_{2,}/)
    // "the-afghan-whigs" is geen woord maar een zin: streepjes en
    // liggende streepjes zijn spaties zodra er geen spaties in zitten.
    .map((part) => (/\s/.test(part) ? part : part.replace(/[-_]+/g, ' ')))
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .map((part) => part.replace(/^(event|evenement|tickets?|e-?ticket)\s+/i, ''))
    // En achteraan net zo goed: "afghan whigs ticket" is de band.
    .map((part) =>
      part.replace(/\s+(tickets?|e-?tickets?|bestelling|order)$/i, '')
    )
    .filter((part) => {
      if (part.length < 4) return false;
      if (!/[a-zà-ÿ]{3,}/i.test(part)) return false;
      if (FILE_NOISE.test(part)) return false;
      if (FILE_ADMIN.test(part)) return false;
      if (TICKET_DATA.test(part)) return false;
      return !known.has(normalize(part));
    });
  if (parts.length === 0) return null;
  return parts.reduce((a, b) => (b.length > a.length ? b : a));
}

/**
 * Welke van de twee titels we geloven.
 *
 * Zeggen ze hetzelfde, dan wint wat er op het kaartje staat — die kent de
 * schrijfwijze. Spreken ze elkaar tegen, dan wint de bestandsnaam: de OCR
 * heeft dan waarschijnlijk het logo of een adresregel te pakken.
 */
/** De regel op het kaartje waar de bestandsnaam naar wijst. */
function titleLineFor(
  fromFile: string | null,
  lines: Line[],
  used: Set<number>
): string | null {
  const words = fromFile ? normalize(fromFile).split(' ').filter(Boolean) : [];
  if (words.length === 0) return null;
  const max = words.join(' ').length * 2;
  for (const [index, line] of lines.entries()) {
    if (used.has(index)) continue;
    // ML Kit plakt "The Afghan Whigs" en "Open 19:30" tot één blok; we
    // willen alleen het stuk waar de bestandsnaam in zit.
    for (const part of line.text.split('\n')) {
      const norm = normalize(part);
      if (norm.length > 0 && norm.length <= max && words.every((w) => norm.includes(w))) {
        return part.trim();
      }
    }
  }
  return null;
}

function chooseTitle(fromOcr: string | null, fromFile: string | null) {
  if (!fromFile) return fromOcr;
  if (!fromOcr) return fromFile;
  const a = normalize(fromOcr);
  const b = normalize(fromFile);
  if (a.length === 0) return fromFile;
  if (b.includes(a) || a.includes(b)) return fromOcr;
  // Delen ze een woord, dan lazen we hetzelfde en is de OCR-versie de
  // nettere: met hoofdletters, zonder "ticket-2" erachter. Delen ze niets,
  // dan is de OCR-titel vermoedelijk onzin en is de bestandsnaam veiliger.
  const words = new Set(b.split(' ').filter((w) => w.length >= 4));
  return a.split(' ').some((w) => words.has(w)) ? fromOcr : fromFile;
}

export function extractEventDraft(
  ocr: OcrResult,
  opts: {
    venueNames?: string[];
    today?: Date;
    city?: string;
    /** Komt uit `detectTicket`. Een kaartje is een formulier en geen
        affiche: daar is het grootste element het logo van de zaal, niet
        de naam van wat je gaat zien. */
    isTicket?: boolean;
    /** De naam van het gedeelde bestand. Zie {@link titleFromFileName}:
        wat de provider tikte is betrouwbaarder dan wat wij lezen. */
    fileName?: string | null;
  } = {}
): EventDraft {
  const lines = toLines(ocr);
  if (lines.length === 0) return EMPTY_DRAFT;

  const fullText = lines.map((l) => l.text).join('\n');
  const today = opts.today ?? new Date();
  const venueNames = opts.venueNames ?? [];

  const venueHit = findVenue(lines, venueNames);
  // De adresregel lezen we altijd: ook als we de venue kennen staat de
  // stad daar zwart-op-wit, en dat is beter dan onze aanname Amsterdam.
  const location = findLocationLine(lines);
  const venue = venueHit?.name ?? location?.venue ?? null;
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
  // Geen enkele zaalnaam is een titel — ook niet die ene die we niet als
  // venue gebruikten.
  for (const index of venueLikeLines(lines, venueNames)) used.add(index);
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

  for (const index of location?.indices ?? []) used.add(index);

  // Op een ticket zoeken we de titel bóven de datum. Daarvoor moeten we
  // weten welke regel de datum is.
  //
  // Zoek de regel waar diezelfde datum in staat, niet de regel die er
  // alléén een datum is: op een Paylogic-kaartje staat hij achter de
  // prijs geplakt ("Prijs: € 34,30 EUR* Datum: 28 september 2026 21:00")
  // en dan vonden we geen anker, waarna de grootste regel won — het logo
  // van de ticketboer.
  const dateLineIndex =
    opts.isTicket && date
      ? lines.findIndex((l) => /\d/.test(l.text) && parseDate(l.text, today) === date)
      : -1;
  // "De Nachtelijke Escapades +" — dat plusje hoort bij de support-regel
  // eronder, die we net als aparte artiest hebben gelezen.
  const readTitle =
    findTitle(lines, used, dateLineIndex > 0 ? dateLineIndex : undefined)
      ?.replace(/\s*[+&,]\s*$/, '')
      .trim() || null;
  const fromFile = titleFromFileName(opts.fileName, venueNames);
  // De bestandsnaam zegt wát er staat, de OCR hóe het geschreven wordt.
  // Vinden we "afghan-whigs-ticket.pdf" terug als regel op het kaartje,
  // dan is dat de titel — ook als die regel nergens uitspringt.
  const title =
    titleLineFor(fromFile, lines, used) ?? chooseTitle(readTitle, fromFile);

  // Stad: alleen als ze het zelf zeggen, of als de venue uit onze
  // Amsterdamse lijst kwam — dan is het geen gok maar een gevolg.
  const cityInText = /\bamsterdam\b/i.test(fullText) ? 'Amsterdam' : null;
  // Staat de stad op het kaartje, dan telt die — ook boven onze eigen
  // aanname. Een ticket voor Borgerhout is geen Amsterdams event.
  const city =
    location?.city ??
    cityInText ??
    (venueHit ? (opts.city ?? 'Amsterdam') : null);

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
