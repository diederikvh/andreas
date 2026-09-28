/**
 * De vaste genrelijst waar meldingsregels op matchen.
 *
 * `events.genres` is vrije tekst uit ruim honderd scrapers: 1.661
 * verschillende labels, en hiphop alleen al als `hip-hop`, `hiphop`,
 * `hip hop`, `rap`, `Hip-Hop/Rap`… Een regel "hiphop" moet die allemaal
 * vangen en niets anders. Deze lijst vertaalt de rommel naar een handvol
 * vaste sleutels.
 *
 * Drie keuzes die precisie boven volledigheid zetten:
 *
 *  - **Alleen de eigen `genres` van het event**, niet `effective_genres`.
 *    Die laatste trekt de Spotify/MusicBrainz-genres van de line-up mee,
 *    en dan wordt Ezra Collective hiphop en een technonacht in Radion ook.
 *  - **Een genre geldt binnen z'n categorie.** Hiphop is Muziek; een
 *    theaterstuk met hiphop-dans valt erbuiten. Dans is Theater; `dance`
 *    bij een concert is een ander ding.
 *  - **Alleen de eerste twee labels tellen** (`MAIN_LABELS`). Het eerste
 *    label is bijna altijd het hoofdgenre; wat achteraan hangt is vaak
 *    sfeer. Paradiso zet `hip-hop` achter half het soul- en jazzaanbod, en
 *    zo werden Jungle en een jazzfestival hiphop. Prijs: een ADE-nacht met
 *    `house,electronic,techno` telt niet als techno (wel als elektronisch).
 *    Voor het uitsluiten van kinderaanbod tellen wél alle labels.
 *    Uitzondering: techno en house tellen ook op de derde plek, want een
 *    clubnacht zet ze vaak achter `house, electronic`.
 *  - **Verzamellabels met een `/` doen niet mee** in de ruime patronen.
 *    `pop / rock` (418× bij TivoliVredenburg) zegt niet of het pop óf
 *    rock is, dus het telt voor geen van beide. Een verzamellabel dat wél
 *    iets zegt (`dance / by night`) staat er exact in.
 *
 * Een patroon is een genormaliseerd label (zie `normalizeGenre`). Met `%`
 * erin is het een LIKE-patroon; zonder is het een exacte match.
 *
 * Nieuwe labels in de data? `pnpm tsx --env-file=.env
 * src/scripts/inspect-genre-coverage.ts` laat zien wat er niet gevangen
 * wordt.
 */

export type Category = 'Muziek' | 'Theater' | 'Literatuur' | 'Film' | 'Kunst' | 'Lezing';

type GenreDef = {
  label: string;
  categories: Category[];
  match: string[];
};

const HIPHOP = ['%hiphop%', 'hiphop/rap', 'rap', 'rapper', 'trap', 'drill', 'grime', 'cloudrap', 'poprap', 'gangstarap', 'nederhop', 'nlrap'];
const TECHNO = ['%techno%'];
const HOUSE = ['house', 'housemusic', '%house'];
const DNB = ['drumandbass', 'drum&bass', 'dnb', 'jungle', 'dubstep', 'ukgarage', 'ukg'];
const ALL: Category[] = ['Muziek', 'Theater', 'Literatuur', 'Film', 'Kunst', 'Lezing'];

export const GENRES = {
  // ── Muziek ──
  hiphop: { label: 'hiphop', categories: ['Muziek'], match: HIPHOP },
  rnb: { label: 'r&b', categories: ['Muziek'], match: ['r&b', 'rnb', 'rhythmandblues', '%r&b'] },
  soul: { label: 'soul', categories: ['Muziek'], match: ['soul', 'neosoul', 'northernsoul', 'motown', 'gospel'] },
  funk: { label: 'funk', categories: ['Muziek'], match: ['funk', 'funky', 'pfunk', 'jazzfunk'] },
  jazz: { label: 'jazz', categories: ['Muziek'], match: ['%jazz%', 'bebop', 'bigband'] },
  blues: { label: 'blues', categories: ['Muziek'], match: ['blues', 'bluesrock', 'deltablues', 'roots/blues'] },
  rock: { label: 'rock', categories: ['Muziek'], match: ['rock', '%rock', 'rock&roll', 'rocknroll', 'grunge', 'psychedelic', 'psychedelica', 'psychedelisch', 'psych', 'prog'] },
  indie: { label: 'indie', categories: ['Muziek'], match: ['%indie%', 'alternative', 'alternatief', 'shoegaze', 'dreampop', 'slowcore'] },
  wave: { label: 'new wave & darkwave', categories: ['Muziek'], match: ['newwave', 'darkwave', 'coldwave', 'synthwave', 'gothic', 'goth', 'gothicrock', 'industrial'] },
  punk: { label: 'punk', categories: ['Muziek'], match: ['%punk%', 'emo', 'posthardcore'] },
  metal: { label: 'metal', categories: ['Muziek'], match: ['%metal%', 'deathcore', 'grindcore', 'doom', 'sludge', 'thrash', 'djent', 'heavy'] },
  pop: {
    label: 'pop',
    categories: ['Muziek'],
    match: ['pop', 'popmuziek', 'nederpop', 'kpop', 'jpop', 'synthpop', 'electropop', 'hyperpop', 'artpop', 'altpop', 'alternativepop', 'powerpop', 'chamberpop', 'britpop', 'dancepop'],
  },
  electronic: {
    label: 'elektronisch',
    categories: ['Muziek'],
    // Wie "elektronisch" zegt bedoelt techno en house ook.
    match: ['electronic', 'elektronisch', 'elektronische', 'elektronischemuziek', 'electronica', 'elektronica', 'electro', 'idm', 'experimenteleelektronica', 'triphop', 'trance', 'hardstyle', 'gabber', 'ebm', ...TECHNO, ...HOUSE, ...DNB,
      // Verzamellabel van TivoliVredenburg voor hun clubprogramma.
      'dance/bynight'],
  },
  techno: { label: 'techno', categories: ['Muziek'], match: TECHNO },
  house: { label: 'house', categories: ['Muziek'], match: HOUSE },
  dnb: { label: 'drum & bass', categories: ['Muziek'], match: DNB },
  disco: { label: 'disco', categories: ['Muziek'], match: ['disco', '%disco'] },
  ambient: { label: 'ambient', categories: ['Muziek'], match: ['ambient', 'drone', 'downtempo'] },
  experimenteel: { label: 'experimenteel', categories: ['Muziek'], match: ['experimental', 'experimenteel', 'avantgarde', 'noise'] },
  klassiek: {
    label: 'klassiek',
    // Ook Theater: klassieke concerten in theaterzalen staan vaak zo.
    categories: ['Muziek', 'Theater'],
    match: ['%klassiek%', 'klassieke', 'classical', 'contemporaryclassical', 'kamermuziek', 'chambermusic', 'barok', 'baroque', 'orkest', 'orchestral', 'symfonisch', 'symphonisch', 'koor'],
  },
  opera: { label: 'opera', categories: ['Muziek', 'Theater'], match: ['opera', 'operette', 'operetta'] },
  folk: { label: 'folk', categories: ['Muziek'], match: ['folk', 'indiefolk', 'folkrock', 'irishfolk', 'celtic'] },
  // "singer – songwriter / americana" (Effenaar) telt voor allebei.
  country: { label: 'country & americana', categories: ['Muziek'], match: ['country', 'americana', 'bluegrass', 'altcountry', 'singersongwriter/americana'] },
  singersongwriter: { label: 'singer-songwriter', categories: ['Muziek'], match: ['singersongwriter', 'singersongwriter/americana'] },
  reggae: { label: 'reggae', categories: ['Muziek'], match: ['reggae', 'dub', 'ska', 'dancehall', 'rootsreggae'] },
  latin: {
    label: 'latin',
    categories: ['Muziek'],
    match: ['latin', 'latino', 'salsa', 'cumbia', 'bachata', 'merengue', 'reggaeton', 'samba', 'bossanova', 'mpb', 'forro', 'bailefunk', 'brazilian', 'choro', 'latinjazz'],
  },
  afro: { label: 'afro', categories: ['Muziek'], match: ['afro', 'afrobeat', 'afrobeats', 'afropop', 'amapiano', 'highlife', 'afrohouse'] },
  wereld: {
    label: 'wereldmuziek',
    categories: ['Muziek'],
    match: ['world', 'worldmusic', 'wereld', 'wereldmuziek', 'global', 'balkan', 'klezmer', 'fado', 'flamenco', 'tango', 'arabisch', 'arabischemuziek', 'andalusisch', 'persian'],
  },
  nederlandstalig: { label: 'Nederlandstalig', categories: ['Muziek'], match: ['nederlandstalig', 'nederlands', 'levenslied'] },

  // ── Theater ──
  comedy: { label: 'comedy & cabaret', categories: ['Theater'], match: ['comedy', 'cabaret', 'standup', 'humor', 'improv', 'satire', 'komedie', 'kleinkunst', 'sketch'] },
  dans: { label: 'dans', categories: ['Theater'], match: ['dans', 'dance', 'ballet', 'moderndance', 'hedendaagsedans', 'choreografie'] },
  toneel: { label: 'toneel', categories: ['Theater'], match: ['toneel', 'theater', 'drama', 'theatervoorstelling'] },
  musical: { label: 'musical', categories: ['Theater'], match: ['musical', 'muziektheater'] },
  circus: { label: 'circus', categories: ['Theater'], match: ['circus', 'acrobatiek'] },
  spokenword: { label: 'spoken word & poëzie', categories: ['Theater', 'Literatuur'], match: ['spokenword', 'poezie', 'poetry'] },

  // ── Film ──
  documentaire: { label: 'documentaire', categories: ['Film'], match: ['documentaire', 'documentary', 'docu'] },
  horror: { label: 'horror', categories: ['Film'], match: ['horror'] },
  animatie: { label: 'animatie', categories: ['Film'], match: ['animatie', 'animation', 'anime'] },
  scifi: { label: 'sciencefiction', categories: ['Film'], match: ['scifi', 'sciencefiction'] },
  thriller: { label: 'thriller', categories: ['Film'], match: ['thriller', 'crime', 'mystery'] },
  arthouse: { label: 'arthouse', categories: ['Film'], match: ['arthouse'] },

  // ── Lezing / Literatuur / Kunst ──
  debat: { label: 'debat', categories: ['Lezing'], match: ['debat', 'debate', 'panel', 'kennis&debat'] },
  filosofie: { label: 'filosofie', categories: ['Lezing'], match: ['filosofie', 'philosophy'] },
  maatschappij: { label: 'maatschappij', categories: ['Lezing'], match: ['maatschappij', 'society'] },
  politiek: { label: 'politiek', categories: ['Lezing'], match: ['politiek', 'politics', 'geopolitiek'] },
  boekpresentatie: { label: 'boekpresentatie', categories: ['Literatuur'], match: ['boekpresentatie'] },
  installatie: { label: 'installatie', categories: ['Kunst'], match: ['installatie', 'installation', 'videoart'] },
  schilderkunst: { label: 'schilderkunst', categories: ['Kunst'], match: ['schilderkunst', 'painting'] },
  fotografie: { label: 'fotografie', categories: ['Kunst'], match: ['fotografie', 'photography'] },

  // ── Soorten, vooral om uit te sluiten ("geen tributebands") ──
  tribute: { label: 'tribute- en coverbands', categories: ['Muziek', 'Theater'], match: ['tribute', 'tributes', 'tributeband', 'coverband', 'covers'] },

  // ── Wat standaard buiten elke regel valt ──
  familie: { label: 'kinderen & familie', categories: ALL, match: ['familie', 'family', 'kindertheater', 'jeugd', 'kinderen', 'kinderliedjes', 'kids', 'poppenspel'] },
  workshop: { label: 'workshop', categories: ALL, match: ['workshop', 'masterclass', 'cursus'] },
  // Geen voorstelling maar iets om te doen: quiz, podcastopname,
  // rondleiding, les. TivoliVredenburg zet die onder "Anders".
  activiteit: {
    label: 'activiteit (quiz, rondleiding, les)',
    categories: ALL,
    match: ['anders', 'quiz', 'pubquiz', 'popquiz', 'bingo', 'yoga', 'podcast', 'rondleiding', 'boekenclub', 'markt', 'spelavond'],
  },
} satisfies Record<string, GenreDef>;

/** Hoeveel labels vooraan in `events.genres` meetellen voor een regel. */
export const MAIN_LABELS = 2;
/** Deze genres tellen ook op plek 3: een ADE-nacht met
    `house, electronic, techno` is gewoon techno. */
export const DEEP_LABEL_KEYS = ['techno', 'house'] as const;

export type GenreKey = keyof typeof GENRES;
export const GENRE_KEYS = Object.keys(GENRES) as [GenreKey, ...GenreKey[]];

/** Een regel matcht deze nooit, tenzij de regel er zelf om vraagt: een
    hiphop-regel hoort geen kindervoorstelling of dansles op te leveren. */
export const EXCLUDED_BY_DEFAULT: GenreKey[] = ['familie', 'workshop', 'activiteit'];

/** Titels die op kinderaanbod wijzen maar geen label hebben: "(4+)",
    "vanaf 8 jaar". Alleen 1–12, want "20+" op een feest is een leeftijdsgrens. */
export const KIDS_TITLE_REGEX = String.raw`(^|[^0-9])([1-9]|1[0-2]) ?\+|vanaf [0-9]{1,2} jaar|schoolconcert|babyconcert|peuterconcert|kinderconcert|t/m [0-9]{1,2} (maanden|jaar)`;

/** Titels van iets om te doen in plaats van te zien, zonder dat label:
    "Backstage rondleiding", "Popquiz", "Masterclass — Kian Soltani",
    "Hagelslag de Podcast". Niet "karaoke" (vaak een band) en niet
    "high tea" (vaak een festival). */
export const ACTIVITY_TITLE_REGEX = String.raw`quiz|podcast|rondleiding|bingo|yoga|skateles|tarot|scrabble|boekenclub|proefles|\mmarkt\M|creatief met|dinner at|spelavond|masterclass|workshop|gear talk|\mcursus`;

// Postgres kent geen unaccent zonder extensie; deze tabel doet in SQL en TS
// precies hetzelfde, zodat de test de échte matching dekt.
const ACCENT_FROM = 'áàâäãéèêëíìîïóòôöõúùûüçñ';
const ACCENT_TO = 'aaaaaeeeeiiiiooooouuuucn';
const STRIP = /[\s._–—-]+/g;

/** "Hip-Hop" → "hiphop", "Poëzie" → "poezie", "drum & bass" → "drum&bass". */
export function normalizeGenre(raw: string): string {
  let s = raw.toLowerCase();
  s = [...s].map((ch) => {
    const i = ACCENT_FROM.indexOf(ch);
    return i >= 0 ? ACCENT_TO[i] : ch;
  }).join('');
  return s.replace(STRIP, '');
}

/** Dezelfde normalisatie als SQL-expressie over kolom/alias `col`. */
export function normalizeGenreSql(col: string): string {
  return `regexp_replace(translate(lower(${col}), '${ACCENT_FROM}', '${ACCENT_TO}'), '[[:space:]._–—-]+', '', 'g')`;
}

function patternMatches(norm: string, pattern: string): boolean {
  if (!pattern.includes('%')) return norm === pattern;
  if (norm.includes('/')) return false;
  const re = new RegExp('^' + pattern.split('%').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(norm);
}

/** Welke vaste genres een event heeft. De TS-tweeling van de SQL-matching,
    voor de test en het coverage-script. */
export function genresOf(category: Category, raw: string[]): GenreKey[] {
  const norms = raw.map(normalizeGenre);
  return GENRE_KEYS.filter((key) => {
    const def: GenreDef = GENRES[key];
    return def.categories.includes(category) && def.match.some((p) => norms.some((n) => patternMatches(n, p)));
  });
}

/** De vaste genres die voor een regel tellen: die van de eerste twee
    labels, plus techno en house van de derde. Tweeling van `hasGenre` in
    `match.ts`. */
export function mainGenresOf(category: Category, raw: string[]): GenreKey[] {
  const main = genresOf(category, raw.slice(0, MAIN_LABELS));
  const deep = genresOf(category, raw.slice(MAIN_LABELS, MAIN_LABELS + 1)).filter(
    (k) => (DEEP_LABEL_KEYS as readonly string[]).includes(k) && !main.includes(k)
  );
  return [...main, ...deep];
}

/**
 * De genrelijst als `VALUES`-rijen (key, category, pattern, is_like), voor
 * een `WITH genre_alias(...) AS (...)`. Letterlijk in de query in plaats van
 * een tabel: één bron van waarheid, en een aanpassing hier geldt meteen voor
 * alle bestaande regels.
 */
export function genreAliasValuesSql(): string {
  const rows: string[] = [];
  for (const key of GENRE_KEYS) {
    const def: GenreDef = GENRES[key];
    for (const cat of def.categories) {
      for (const p of def.match) {
        rows.push(`('${key}','${cat}','${p.replace(/'/g, "''")}',${p.includes('%')})`);
      }
    }
  }
  return `VALUES ${rows.join(',')}`;
}
