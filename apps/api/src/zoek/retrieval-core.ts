/**
 * Pure retrieval-kern (stap [2]) — GEEN DB, GEEN AI. Deze functies zijn
 * deterministisch en los unit-getest in retrieval.test.ts. De DB-query +
 * end-to-end orchestratie staan in retrieval.ts (importeert hieruit).
 *
 * Bewust gescheiden van db/index.js zodat de tests draaien zonder
 * DATABASE_URL.
 */
import type { PreferenceProfile, PriceTier, ZoekCandidate, ZoekWhen } from './types.js';

export const MAX_CANDIDATES = 25;
/** Onder dit aantal zetten we de `sparse`-vlag zodat het LLM eerlijk kan
    zeggen dat er vanavond weinig past. */
export const SPARSE_THRESHOLD = 3;

/** Rauwe rij uit de DB met net genoeg om te filteren én te mappen naar
    de magere `ZoekCandidate`. Coördinaten blijven hier zodat we de straal
    kunnen rekenen; ze gaan níét mee naar het LLM. */
export type CandidateRow = {
  id: string;
  title: string;
  venueId: string;
  venueName: string;
  start: Date;
  end: Date | null;
  /** Hoofd-categorie (Muziek/Film/Theater/…) — gebruikt voor categorie-
      besef bij het ranken ("band/concert" → boost Muziek). */
  category: string;
  genres: string[];
  priceCents: number | null;
  lat: number;
  lng: number;
  scene: string | null;
  subtype: string[];
  /** Namen uit de occurrence-lineup (DJ's, support, cast). Laat een act die
      wél in de line-up maar níét in de titel staat tóch matchen op naam. */
  lineup: string[];
  /** artistId's uit de line-up (gevuld door `_artists-enrich.ts`). Bron voor
      het ophalen van artiest-genres die naar het event doordruppelen. */
  artistIds: string[];
  /** Genre-labels van de gelinkte line-up-artiesten (techno/house/…), uit de
      `artists`-tabel. Druppelen door als sfeer-hint zodat een clubavond met
      techno-DJ's ook op "techno" matcht, ook zonder eigen genre-tag. */
  artistGenres: string[];
};

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

/**
 * Deterministische tijd-detectie uit het bericht. Vangt expliciete
 * periode-woorden zodat die ALTIJD doorwerken in de retrieval, los van wat
 * het profiel-LLM ervan maakt (dat bleek onbetrouwbaar voor "deze maand" /
 * "dit jaar"). Geeft null als het bericht geen duidelijke periode noemt — dan
 * blijft het LLM-bepaalde `when` staan. Breedste periode wint.
 */
export function detectWhenOverride(
  message: string
): Exclude<ZoekWhen, 'specific'> | null {
  const m = message.toLowerCase();
  if (/\bdit jaar\b|\bkomende maanden\b|\brest van het jaar\b/.test(m)) return 'this_year';
  // "volgende X" = de periode ná deze (vooruit geschoven), niet de lopende.
  if (/\bvolgende? maand\b/.test(m)) return 'next_month';
  if (/\bvolgend weekend\b/.test(m)) return 'next_weekend';
  if (/\bvolgende? week\b/.test(m)) return 'next_week';
  if (
    /\b(deze|komende) maand\b|\bhele maand\b|\brest van de maand\b|\bkomende weken\b|\blangere? periode\b|\blanger vooruit\b|\bverder vooruit\b|\bkomende tijd\b/.test(
      m
    )
  )
    return 'this_month';
  if (
    /\b(deze|komende|aankomende) week\b|\bhele week\b|\b(rest van de|later deze) week\b|\bkomende dagen\b/.test(
      m
    )
  )
    return 'this_week';
  if (/\bdit weekend\b|\bin het weekend\b|\bhet weekend\b/.test(m)) return 'this_weekend';
  if (/\bvanavond\b|\bvannacht\b|\bvandaag\b|\bnu\b|\bstraks\b/.test(m)) return 'tonight';
  return null;
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

/** centen → grove tier. null (onbekende prijs) blijft null zodat een prijs-
    filter onbekende prijzen niet onterecht wegdrukt. */
export function priceTierFromCents(cents: number | null): PriceTier | null {
  if (cents == null) return null;
  if (cents === 0) return 0;
  if (cents <= 1500) return 1;
  if (cents <= 3500) return 2;
  return 3;
}

// ─── Straal ───────────────────────────────────────────────────────────────

const EARTH_RADIUS_KM = 6371;

export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ─── Pure rank/filter ────────────────────────────────────────────────────────

/** Sfeer-hints voor het LLM + matching: venue.scene + subtype + de genres van
    de line-up-artiesten, ge-dedupe. Zo telt "techno" mee als de DJ techno
    draait, ook al heeft het event zelf geen techno-tag. */
export function vibeOf(
  row: Pick<CandidateRow, 'scene' | 'subtype' | 'artistGenres'>
): string[] {
  const out = new Set<string>();
  if (row.scene) out.add(row.scene);
  for (const s of row.subtype) out.add(s);
  for (const g of row.artistGenres) out.add(g);
  return [...out];
}

function normalize(s: string): string {
  return s.toLowerCase().trim();
}

/** Categorie-trefwoorden in een bericht → de event-categorieën die de
    gebruiker waarschijnlijk bedoelt. "band optredens" → ['Muziek'], "een
    film" → ['Film']. Gebruikt om de juiste categorie omhoog te ranken zodat
    bv. concerten niet wegvallen tussen films in een druk weekvenster. */
export function inferCategories(message: string): string[] {
  const m = message.toLowerCase();
  const out = new Set<string>();
  // Muziek: "muziek" als deel van een woord (popmuziek, livemuziek,
  // wereldmuziek) óf een muziek-/genre-term als los woord.
  if (
    /muziek/.test(m) ||
    /\b(band|bands|concert|concerten|optreden|optredens|live|dj|dj'?s|pop|rock|jazz|techno|house|hiphop|hip-?hop|rap|metal|punk|indie|folk|soul|funk|disco|klassiek|klassieke|elektronisch|electronic|elektro|drum|bass|dnb|reggae|latin|afro|ambient|hardcore|gabber|dance|rave|club|clubnacht|singer|songwriter|gig|akoestisch)\b/.test(m)
  )
    out.add('Muziek');
  if (/\b(film|films|movie|movies|bioscoop|cinema|screening|documentaire)\b/.test(m))
    out.add('Film');
  if (/\b(theater|toneel|voorstelling|cabaret|dans|musical|opera|comedy)\b/.test(m))
    out.add('Theater');
  if (/\b(expo|tentoonstelling|museum|musea|kunst|galerie|fotografie)\b/.test(m))
    out.add('Kunst');
  if (/\b(lezing|debat|talk|talkshow|college)\b/.test(m)) out.add('Lezing');
  if (/\b(boek|po[eë]zie|literatuur|spoken\s?word|verhaal)\b/.test(m))
    out.add('Literatuur');
  return [...out];
}

/** Woorden die geen titel-/venue-match mogen forceren: tijd-/categorie-/
    vulwoorden. Eigennamen (artiest, venue) blijven over. */
const KEYWORD_STOP = new Set([
  'deze', 'week', 'weekend', 'vanavond', 'vannacht', 'vandaag', 'maand',
  'jaar', 'komende', 'aankomende', 'volgende', 'dagen', 'avond', 'nacht',
  'band', 'bands', 'concert', 'concerten', 'optreden', 'optredens', 'live',
  'livemuziek', 'muziek', 'film', 'films', 'theater', 'voorstelling',
  'leuk', 'leuke', 'leuks', 'nieuw', 'nieuwe', 'populair', 'populaire',
  'zelfs', 'iets', 'graag', 'ook', 'waar', 'wat', 'welke', 'heb', 'hebben',
  'gaan', 'kunnen', 'niet', 'meer', 'goede', 'goed', 'echt', 'naar', 'voor',
  'met', 'een', 'het', 'dat', 'wel', 'maar', 'over', 'deze', 'rustig',
  'rustigs', 'buurt', 'duur', 'goedkoop', 'gratis',
  // veelvoorkomende werkwoorden/vulwoorden (≥4 tekens) die geen eigennaam zijn
  'zijn', 'ben', 'kan', 'zou', 'wil', 'wilt', 'mag', 'moet', 'even', 'nog',
  'dan', 'als', 'dus', 'toch', 'soms', 'jij', 'ben', 'mij', 'mijn', 'jouw',
  'weet', 'ken', 'kijk', 'zoek', 'zoeken', 'vind', 'vinden', 'doen', 'doe',
]);

/** Significante trefwoorden uit het bericht (eigennamen e.d.): kleine
    letters, ≥4 tekens, geen stopwoorden. Drijft titel-/venue-matching zodat
    een vraag die een act of zaal bij naam noemt ("guns n roses in de ziggo")
    dat event omhoog haalt, ook al valt 't verderop in het venster. */
export function extractKeywords(message: string): string[] {
  const out = new Set<string>();
  for (const raw of message.toLowerCase().split(/[^a-z0-9à-ÿ]+/)) {
    if (raw.length >= 4 && !KEYWORD_STOP.has(raw)) out.add(raw);
  }
  return [...out];
}

/** Genre/categorie-/sfeer-vocabulaire: woorden die een TYPE aanduiden, geen
    eigennaam. Gebruikt om een genre-browse ("techno") te onderscheiden van een
    entiteit-lookup ("bruno mars"). Alleen ≥4-teken-woorden hoeven hier; kortere
    (pop, dj, rap) vallen toch al buiten extractKeywords. */
export const GENRE_VOCAB = new Set<string>([
  'rock', 'jazz', 'techno', 'house', 'hiphop', 'metal', 'punk', 'indie', 'folk',
  'soul', 'funk', 'disco', 'klassiek', 'klassieke', 'elektronisch', 'electronic',
  'elektro', 'drum', 'bass', 'reggae', 'latin', 'afro', 'ambient', 'hardcore',
  'gabber', 'dance', 'rave', 'club', 'clubnacht', 'clubavond', 'singer',
  'songwriter', 'akoestisch', 'concert', 'concerten', 'optreden', 'optredens',
  'livemuziek', 'popmuziek', 'muziek', 'house',
  'film', 'films', 'movie', 'movies', 'bioscoop', 'cinema', 'screening',
  'documentaire', 'theater', 'toneel', 'voorstelling', 'cabaret', 'dans',
  'musical', 'opera', 'comedy', 'expo', 'tentoonstelling', 'museum', 'musea',
  'kunst', 'galerie', 'fotografie', 'lezing', 'debat', 'talk', 'talkshow',
  'college', 'boek', 'literatuur', 'spoken', 'verhaal',
]);

/** Trefwoorden die waarschijnlijk een EIGENNAAM zijn (act/zaal): keywords
    minus het genre/categorie-vocabulaire. Bepaalt of we direct breed (heel
    jaar) moeten zoeken i.p.v. progressief vanuit een kort venster. */
export function entityKeywordsOf(message: string): string[] {
  return extractKeywords(message).filter((k) => !GENRE_VOCAB.has(k));
}

/** Matcht een kandidaat op titel/genre/sfeer tegen de trefwoorden — gebruikt
    om te bepalen of een browse-venster genoeg ÉCHT relevante treffers bevat
    (anders verbreden we het venster). Lege keywords → alles telt mee. */
export function candidateMatchesKeywords(c: ZoekCandidate, keywords: string[]): boolean {
  if (keywords.length === 0) return true;
  const title = c.title.toLowerCase();
  const hay = [...c.genres, ...c.vibe].map((s) => s.toLowerCase());
  return keywords.some((k) => title.includes(k) || hay.some((h) => h.includes(k)));
}

/** Hoe goed matcht een rij op want/avoid + gewenste categorie + trefwoorden
    (zachte score, geen hard filter). */
function matchScore(
  profile: PreferenceProfile,
  row: CandidateRow,
  desiredCategories: string[],
  keywords: string[]
): number {
  const haystack = new Set([...row.genres, ...vibeOf(row)].map(normalize));
  let score = 0;
  for (const w of profile.want) if (haystack.has(normalize(w))) score += 2;
  for (const a of profile.avoid) if (haystack.has(normalize(a))) score -= 3;
  // (Categorie is een HARD filter in rankCandidates, niet hier — zie onder.)
  void desiredCategories;
  // Trefwoord-match op titel/venue/genre — laat een bij naam genoemde act of
  // zaal bovendrijven ongeacht datum binnen het venster.
  if (keywords.length > 0) {
    const title = row.title.toLowerCase();
    const venue = row.venueName.toLowerCase();
    const lineup = row.lineup.map((n) => n.toLowerCase());
    for (const kw of keywords) {
      if (title.includes(kw)) score += 5;
      else if (lineup.some((n) => n.includes(kw))) score += 4;
      else if (venue.includes(kw)) score += 4;
      else if (haystack.has(kw)) score += 3;
    }
  }
  return score;
}

export type RankResult = { candidates: ZoekCandidate[]; sparse: boolean };

/**
 * Pure stap: harde filters (straal, uitsluiting, prijs) + zachte sortering
 * op categorie, want/avoid en starttijd. Genre/categorie worden NIET hard
 * gefilterd — dat maakt de set te snel leeg; het LLM doet de fijne afweging.
 *
 * `desiredCategories` komt uit `inferCategories(message)` en duwt de gevraagde
 * categorie omhoog zodat die de kandidaten-cap overleeft.
 */
export function rankCandidates(
  profile: PreferenceProfile,
  rows: CandidateRow[],
  desiredCategories: string[] = [],
  keywords: string[] = []
): RankResult {
  const excludeVenues = new Set(profile.excludeVenueIds);
  const excludeEvents = new Set(profile.excludeEventIds);
  // Categorie is een HARD filter: noemt de gebruiker een type (muziek/film/
  // theater/…), dan tonen we UITSLUITEND dat type. Anders blijft er film-ruis
  // in een muziekvraag staan. Levert dit te weinig op, dan zegt het LLM dat
  // eerlijk (sparse) i.p.v. de set met ander materiaal te vullen.
  const catFilter = new Set(desiredCategories);

  const kept = rows.filter((row) => {
    if (excludeEvents.has(row.id)) return false;
    if (excludeVenues.has(row.venueId)) return false;
    if (catFilter.size > 0 && !catFilter.has(row.category)) return false;

    if (profile.priceMax != null) {
      const tier = priceTierFromCents(row.priceCents);
      if (tier != null && tier > profile.priceMax) return false;
    }

    if (profile.maxDistanceKm != null && profile.origin) {
      const dist = haversineKm(profile.origin, { lat: row.lat, lng: row.lng });
      if (dist > profile.maxDistanceKm) return false;
    }

    return true;
  });

  kept.sort((a, b) => {
    const ms =
      matchScore(profile, b, desiredCategories, keywords) -
      matchScore(profile, a, desiredCategories, keywords);
    if (ms !== 0) return ms;
    return a.start.getTime() - b.start.getTime();
  });

  const candidates = kept.slice(0, MAX_CANDIDATES).map(toCandidate);
  return { candidates, sparse: candidates.length < SPARSE_THRESHOLD };
}

function toCandidate(row: CandidateRow): ZoekCandidate {
  return {
    id: row.id,
    title: row.title,
    venueId: row.venueId,
    venueName: row.venueName,
    start: row.start.toISOString(),
    end: row.end ? row.end.toISOString() : null,
    genres: row.genres,
    priceTier: priceTierFromCents(row.priceCents),
    vibe: vibeOf(row),
  };
}
