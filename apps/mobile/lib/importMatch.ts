import type { EventMetadata } from './importPayload';

/**
 * Matchen van een geïmporteerd event-concept tegen wat Andreas al kent.
 *
 * Puur en zonder React-Native-imports, zodat de weging op fixtures te
 * testen is. De kandidaten komen van `GET /search` — dat endpoint bestond
 * al voor de zoekbalk en doet een ilike op titel én venuenaam, dus we
 * hebben geen nieuw endpoint nodig om te beginnen.
 *
 * Weging zoals in de featurelijn: titel/artiest 40%, venue 30%,
 * datum 20%, tijd 10% — maar genormaliseerd over de onderdelen die we
 * *kunnen* beoordelen. Heeft de poster geen tijd, dan verdwijnt die 10%
 * uit de noemer in plaats van als nul mee te tellen; anders zou een
 * perfecte match met ontbrekende tijd nooit boven de drempel komen.
 *
 * **Wat `/search` niet levert:** per event alleen de eerstvolgende
 * occurrence, geen datumlijst. Bij een film die dertig keer speelt of een
 * wekelijks feest matcht de posterdatum dus vaak niet op `startsAt` terwijl
 * het event wél klopt. Daarom straft een niet-matchende datum niet af maar
 * levert hij deelscore — en is een datum-match wél een *voorwaarde* voor
 * "hoge confidence". Zonder harde datum stellen we niks automatisch voor,
 * we vragen het. Wil je dat strakker, dan is dat het moment voor een eigen
 * `/import/match` endpoint dat occurrences meeneemt (4.4 in de doc).
 */

export type MatchCandidate = {
  id: string;
  title: string;
  venueName: string;
  /** ISO-string van de eerstvolgende occurrence. */
  startsAt: string;
};

export type MatchParts = {
  title: number;
  venue: number | null;
  date: number | null;
  time: number | null;
};

export type ScoredCandidate = {
  candidate: MatchCandidate;
  /** 0..1 */
  score: number;
  parts: MatchParts;
  /** Valt de logische dag van deze occurrence samen met de herkende datum? */
  dateMatches: boolean;
};

export type MatchLevel = 'high' | 'medium' | 'low';

export type MatchResult = {
  level: MatchLevel;
  /** Best eerst. Bij 'medium' de opties voor "Bedoel je deze?". */
  ranked: ScoredCandidate[];
};

const WEIGHTS = { title: 0.4, venue: 0.3, date: 0.2, time: 0.1 } as const;

/** Zelfde grens als `LOGICAL_DAY_BOUNDARY_HOUR` in eventDisplay.ts: een
    event dat om 02:00 begint hoort bij de avond ervoor. Hier opnieuw
    gedeclareerd omdat eventDisplay react-native importeert en deze module
    puur moet blijven. */
const LOGICAL_DAY_BOUNDARY_HOUR = 6;

function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokens(s: string): string[] {
  return normalize(s)
    .split(' ')
    .filter((t) => t.length > 1);
}

/**
 * Tekstscore tussen twee titels. Exact gelijk is 1, de een bevat de
 * ander 0.9, en daaronder de overlap gedeeld door de kortste van de twee
 * — zo scoort "Ploegendienst" tegen "Ploegendienst + Library Card" hoog
 * zonder dat een lange programmatitel automatisch wint.
 */
export function textScore(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na.length === 0 || nb.length === 0) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;

  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size);
}

/** Lokale dag van een ISO-tijd, met de 06:00-grens. Device-lokaal, zoals
    de rest van de app (`eventDisplay.ts` doet hetzelfde). */
export function logicalDay(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getHours() < LOGICAL_DAY_BOUNDARY_HOUR) {
    d.setDate(d.getDate() - 1);
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

function minutesOfDay(iso: string): number | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.getHours() * 60 + d.getMinutes();
}

function parseClock(hhmm: string): number | null {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function scoreCandidate(
  draft: EventMetadata,
  candidate: MatchCandidate
): ScoredCandidate {
  // Titel óf een van de artiesten mag matchen: op een poster staat de
  // artiest groot en heet het event in Andreas soms anders
  // ("Ploegendienst" vs "Ploegendienst + support").
  const titleSources = [draft.title, ...draft.artists].filter(
    (s): s is string => Boolean(s)
  );
  const title = titleSources.reduce(
    (best, source) => Math.max(best, textScore(source, candidate.title)),
    0
  );

  const venue = draft.venue ? textScore(draft.venue, candidate.venueName) : null;

  const candidateDay = logicalDay(candidate.startsAt);
  const dateMatches = Boolean(
    draft.date && candidateDay && draft.date === candidateDay
  );
  // Geen match is géén bewijs van ongelijk: `/search` geeft alleen de
  // eerstvolgende datum, dus een ander moment van hetzelfde event ziet er
  // hier precies zo uit als een verkeerd event.
  const date = draft.date ? (dateMatches ? 1 : 0.3) : null;

  let time: number | null = null;
  if (draft.time) {
    const want = parseClock(draft.time);
    const got = minutesOfDay(candidate.startsAt);
    if (want !== null && got !== null) {
      const diff = Math.abs(want - got);
      time = diff === 0 ? 1 : diff <= 30 ? 0.7 : diff <= 90 ? 0.4 : 0;
    }
  }

  const parts: MatchParts = { title, venue, date, time };
  let sum = 0;
  let weight = 0;
  for (const [key, value] of Object.entries(parts)) {
    if (value === null) continue;
    const w = WEIGHTS[key as keyof typeof WEIGHTS];
    sum += value * w;
    weight += w;
  }

  return {
    candidate,
    score: weight === 0 ? 0 : sum / weight,
    parts,
    dateMatches,
  };
}

/**
 * Drie uitkomsten, zoals de featurelijn ze omschrijft.
 *
 *  - **high** — één duidelijke winnaar: sterke titel, sterke venue én een
 *    datum die klopt. Dan mogen we het event zelf voorstellen.
 *  - **medium** — genoeg om te vragen: "Bedoel je deze?" met max 3 opties.
 *  - **low** — behandelen als mogelijk nieuw event (fase 5/6).
 *
 * De datum-eis op 'high' is niet cosmetisch: zonder occurrence-lijst kan
 * een titel+venue-match net zo goed het juiste event op de verkeerde avond
 * zijn, en dan is automatisch voorstellen precies verkeerd.
 */
export function matchEvent(
  draft: EventMetadata,
  candidates: MatchCandidate[]
): MatchResult {
  const ranked = candidates
    .map((c) => scoreCandidate(draft, c))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.score < 0.5 || best.parts.title < 0.5) {
    return { level: 'low', ranked: ranked.slice(0, 3) };
  }

  const runnerUp = ranked[1];
  const clear = !runnerUp || best.score - runnerUp.score >= 0.15;
  if (
    best.score >= 0.8 &&
    best.parts.title >= 0.8 &&
    best.dateMatches &&
    clear
  ) {
    return { level: 'high', ranked: [best] };
  }

  return { level: 'medium', ranked: ranked.slice(0, 3) };
}
