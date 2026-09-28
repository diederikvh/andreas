/**
 * Wanneer past een occurrence bij een meldingsregel?
 *
 * Eén SQL-fragment, gebruikt door de job die nieuwe events aan regels
 * koppelt (`jobs/reminders.ts`), de preview bij het aanmaken, en het zoeken
 * (`alerts/search.ts`). Zo
 * is wat je bij het aanmaken te zien krijgt precies wat de melding later
 * zou vangen — geen tweede, net iets andere interpretatie.
 *
 * Verwacht de aliassen `a` (regel), `o` (occurrence), `e` (event), `v`
 * (venue) en de CTE `genre_alias` (zet `GENRE_ALIAS_CTE` in de WITH).
 */
import { sql, type SQL } from 'drizzle-orm';

import { db } from '../db/index.js';
import {
  DEEP_LABEL_KEYS,
  EXCLUDED_BY_DEFAULT,
  GENRE_KEYS,
  ACTIVITY_TITLE_REGEX,
  KIDS_TITLE_REGEX,
  MAIN_LABELS,
  genreAliasValuesSql,
  normalizeGenreSql,
} from './genres.js';

export const GENRE_ALIAS_CTE = sql.raw(
  `genre_alias(key, category, pattern, is_like) AS (${genreAliasValuesSql()})`
);

const N = normalizeGenreSql('g');

const deepKeys = `ARRAY[${DEEP_LABEL_KEYS.map((k) => `'${k}'`).join(',')}]`;

/** Heeft het event (eigen `genres`, binnen z'n categorie) een van deze
    vaste genres? Met `mainOnly` alleen in de eerste labels (techno en house
    ook op de plek erna, zie `mainGenresOf`). Verzamellabels met een `/`
    doen alleen exact mee. */
export function hasGenre(keysExpr: string, mainOnly: boolean): string {
  return `EXISTS (
    SELECT 1 FROM unnest(e.genres) WITH ORDINALITY AS t(g, pos)
    JOIN genre_alias ga ON ga.category = e.category::text
      AND CASE WHEN ga.is_like THEN position('/' in ${N}) = 0 AND ${N} LIKE ga.pattern
               ELSE ${N} = ga.pattern END
    WHERE ga.key = ANY(${keysExpr})
      ${mainOnly ? `AND (t.pos <= ${MAIN_LABELS} OR (t.pos = ${MAIN_LABELS + 1} AND ga.key = ANY(${deepKeys})))` : ''}
  )`;
}

/** Alle genres die iets over de smaak zeggen (niet kinderaanbod,
    workshops of tributes). Heeft het event daar zelf geen van, dan weten
    de labels van de zaal het niet. */
const tasteKeys = `ARRAY[${GENRE_KEYS.filter((k) => !['familie', 'workshop', 'tribute'].includes(k)).map((k) => `'${k}'`).join(',')}]`;
const NA = normalizeGenreSql('ag');

/** Geeft de zaal (eigen labels van `e`) een genre dat iets over de smaak
    zegt? Verwacht de CTE `genre_alias`. */
export const EVENT_HAS_TASTE_GENRE = sql.raw(hasGenre(tasteKeys, true));

/** Terugval op de artiest: zeggen de labels van de zaal niets ("Pop /
    Rock", of niets), dan telt het genre van de hoofdact. Dat is de eerste
    naam in de line-up, of een artiest die precies zo heet als de titel
    ("Kim Wilde"). Alleen de eerste twee tags van die artiest, net als bij
    de zaal. Nooit als de zaal zelf al een genre gaf: dan wint de zaal, en
    wordt Ezra Collective geen hiphop omdat de artiest dat label ook heeft. */
function artistHasGenre(keysExpr: string): string {
  return `(NOT ${hasGenre(tasteKeys, true)} AND EXISTS (
    SELECT 1 FROM artists ar
    CROSS JOIN LATERAL unnest(ar.genres[1:${MAIN_LABELS}]) ag
    JOIN genre_alias ga ON ga.category = e.category::text
      AND CASE WHEN ga.is_like THEN position('/' in ${NA}) = 0 AND ${NA} LIKE ga.pattern
               ELSE ${NA} = ga.pattern END
    WHERE ga.key = ANY(${keysExpr})
      AND (ar.id = CASE WHEN jsonb_typeof(o.lineup) = 'array' THEN o.lineup->0->>'artistId' END
           OR lower(ar.name) = lower(e.title))
  ))`;
}

/** Woorden van een tekst, gescheiden door spaties en met een spatie aan
    beide kanten. "Fred again.. — USB" → " fred again usb ". Zo matcht een
    naam alleen op hele woorden, zonder regex-escaping van de naam. */
const words = (expr: string) =>
  `(' ' || lower(trim(regexp_replace(${expr}, '[^[:alnum:]]+', ' ', 'g'))) || ' ')`;

/** Kleine letters, zonder accenten en ®/™. Postgres heeft hier geen
    `unaccent`, dus een vaste vertaaltabel. */
const plain = (expr: string) =>
  `regexp_replace(translate(lower(${expr}), 'áàâäãåéèêëíìîïóòôöõúùûüñçøý', 'aaaaaaeeeeiiiiooooouuuuncoy'), '[®™]', '', 'g')`;

/** Een naam als woorden: "The Afghan Whigs" → "afghan whigs", "Simon &
    Garfunkel" → "simon and garfunkel". */
const nameWords = (expr: string) =>
  `regexp_replace(trim(regexp_replace(replace(${plain(expr)}, '&', ' and '), '[^[:alnum:]]+', ' ', 'g')), '^the ', '')`;

/** De titel in stukken: gescheiden door ":" "," "+" "(" " - " "—" "/"
    "presents", "feat." enz., elk stuk als woorden met een "| " ervoor.
    "KINK presents Come As You Are: The Afghan Whigs, shame" →
    "| kink | come as you are | afghan whigs | shame |". */
const titleSegments = (expr: string) =>
  `regexp_replace(' | ' || trim(regexp_replace(replace(regexp_replace(${plain(expr)},
    '\\s[-–—]\\s|[:,+|/()\\[\\]–—•·;]|\\s(x|vs\\.?|presents|pres\\.|w/|feat\\.?|featuring|ft\\.?|b2b)\\s', ' | ', 'g'),
    '&', ' and '), '[^[:alnum:]|]+', ' ', 'g')) || ' ', '\\| the ', '| ', 'g')`;

/** Woorden die op een tribute of eerbetoon wijzen. */
const TRIBUTE_RE = `tribute|eerbetoon|the music of|music of|songs of|rumours of|celebrat|salute to|a night of|legacy of|on tour|plays the|performs the|\\d+ jaar `;

/** Staat er letterlijk "tribute", dan is het nooit de artiest zelf, ook
    niet vooraan ("Adele Tribute"). */
const TRIBUTE_WORD = `tribute|eerbetoon`;

/** Goedkope voorfilter: staat het eerste woord van de naam ergens in de
    titel? De regels hieronder zijn regex-zwaar; zonder dit duurt een
    ronde over alle gevolgde artiesten en alle komende avonden een halve
    minuut. */
const firstWordIn = (nameExpr: string, titleExpr: string) =>
  `strpos(lower(${titleExpr}), lower(split_part(regexp_replace(${nameExpr}, '^[Tt]he ', ''), ' ', 1))) > 0`;

/** Begint de titel (of een stuk ervan) met de naam? */
const atSegmentStart = (nameExpr: string, titleExpr: string) =>
  `position(' | ' || ${nameWords(nameExpr)} || ' ' in ${titleSegments(titleExpr)}) > 0`;
const firstSegmentStart = (nameExpr: string, titleExpr: string) =>
  `position(' | ' || ${nameWords(nameExpr)} || ' ' in ' | ' || split_part(${titleSegments(titleExpr)}, ' | ', 2) || ' ') > 0`;

/** Een tribute aan deze artiest: tribute-woorden in de titel, de naam
    ergens erin, en niet vooraan (tenzij er letterlijk "tribute" staat).
    Vooraan is de artiest zelf, ook bij
    "Alison Moyet - Songs of Yazoo" (dat is Moyet, en voor Yazoo een
    tribute). */
export function titleTributeOf(nameExpr: string, titleExpr = 'e.title'): string {
  return `(length(${nameExpr}) >= 4
    AND ${plain(titleExpr)} ~ '${TRIBUTE_RE}'
    AND position(' ' || ${nameWords(nameExpr)} || ' ' in ${titleSegments(titleExpr)}) > 0
    AND (${plain(titleExpr)} ~ '${TRIBUTE_WORD}' OR NOT (${firstSegmentStart(nameExpr, titleExpr)})))`;
}

/**
 * Hoort dit event bij deze artiest, te zien aan de titel? Als de titel of
 * een stuk ervan met de volledige naam begint, of als het een tribute is
 * (wie van Adele houdt, wil ook "Adele Tribute" zien; `titleTributeOf`
 * zegt welke van de twee het is):
 *   - wel: "Jon Allen & the Luna Kings", "Angine De Poitrine (CAN) + …",
 *     "KINK presents Come As You Are: The Afghan Whigs, shame",
 *     "The Music of Prince"
 *   - niet: "A Page of Madness" (Madness), "Future Palace" (Palace),
 *     "Bonnie 'Prince' Billy" (Prince), "van guru tot shishya" (Guru)
 * Een naam van minder dan 4 tekens nooit ("Eve"). Line-ups zijn maar bij
 * een op de vijf avonden gekoppeld; bij concerten is de titel vaak
 * gewoon de naam.
 */
// ponytail: "Prince Fatty" telt nog voor Prince (naam vooraan, woord erachter); een
// lijst toegestane vervolgwoorden als dat in de praktijk vaak misgaat.
export function titleHasName(nameExpr: string, titleExpr = 'e.title'): string {
  return `(length(${nameExpr}) >= 4
    AND ${firstWordIn(nameExpr, titleExpr)}
    AND (${atSegmentStart(nameExpr, titleExpr)} OR ${titleTributeOf(nameExpr, titleExpr)}))`;
}

const WANTS_ACTIVITY = `'Activiteit' = ANY(COALESCE(a.categories::text[], '{}'))`;
const excluded = `ARRAY[${EXCLUDED_BY_DEFAULT.map((k) => `'${k}'`).join(',')}]`;

export const ALERT_MATCH = sql.raw(`
  (a.venue_ids IS NULL OR v.id = ANY(a.venue_ids))
  AND (a.cities IS NULL OR v.city = ANY(a.cities))
  AND (a.categories IS NULL OR e.category = ANY(a.categories))
  AND (a.starts_from IS NULL OR o.starts_at >= a.starts_from)
  AND (a.starts_until IS NULL OR o.starts_at < a.starts_until)
  -- Onbekende prijs telt als passend: dat is bij de helft van het aanbod zo.
  AND (a.price_max_cents IS NULL OR o.price_cents IS NULL OR o.price_cents <= a.price_max_cents)
  -- Kinder- en workshopaanbod valt erbuiten, tenzij de regel erom vraagt.
  -- Vraagt de regel om de categorie Activiteit, dan tellen activiteit en
  -- workshop als gevraagd.
  AND NOT ${hasGenre(`ARRAY(SELECT x FROM unnest(${excluded}) x WHERE NOT x = ANY(COALESCE(a.genres, '{}'))
    AND NOT (x IN ('activiteit', 'workshop') AND ${WANTS_ACTIVITY}))`, false)}
  AND ('familie' = ANY(COALESCE(a.genres, '{}')) OR e.title !~* '${KIDS_TITLE_REGEX}')
  -- Iets om te doen (quiz, rondleiding, workshop), aan de titel of de
  -- categorie, alleen als de regel erom vraagt.
  AND (${WANTS_ACTIVITY} OR 'activiteit' = ANY(COALESCE(a.genres, '{}')) OR 'workshop' = ANY(COALESCE(a.genres, '{}'))
       OR (e.title !~* '${ACTIVITY_TITLE_REGEX}' AND e.category <> 'Activiteit'))
  -- Genres die deze gebruiker niet leuk vindt (genre_prefs), en
  -- tributes ook aan de titel herkend: "Tribute to Adele" heeft zelden
  -- het label.
  AND NOT ${hasGenre(`ARRAY(SELECT gp.genre FROM genre_prefs gp WHERE gp.user_id = a.user_id AND gp.sentiment = 'dislike')`, true)}
  -- Een geblokkeerde zaal is overal weg, ook uit meldingen en voorstellen.
  AND NOT EXISTS (
    SELECT 1 FROM venue_follows vf
    WHERE vf.user_id = a.user_id AND vf.venue_id = v.id AND vf.state = 'blokken'
  )
  AND NOT (e.title ~* 'tribute' AND EXISTS (
    SELECT 1 FROM genre_prefs gp
    WHERE gp.user_id = a.user_id AND gp.genre = 'tribute' AND gp.sentiment = 'dislike'
  ))
  -- Wat: een van de artiesten, óf genre en trefwoord samen. Zo is
  -- "gitaarbands met een jaren-90-randje, zoals Afghan Whigs" te schrijven
  -- als artiesten [Afghan Whigs, Screaming Trees] of genres [rock, indie]
  -- met trefwoord "90s": verwante artiesten altijd, een onbekende band
  -- alleen als hij rock is én "90s" in titel of beschrijving heeft.
  AND (
    (a.genres IS NULL AND a.artist_names IS NULL AND a.keywords IS NULL)
    -- Artiest: in de line-up op naam, of als hele woorden in de titel.
    OR (a.artist_names IS NOT NULL AND EXISTS (
      SELECT 1 FROM unnest(a.artist_names) an
      WHERE EXISTS (
          SELECT 1 FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(o.lineup) = 'array' THEN o.lineup ELSE '[]'::jsonb END
          ) le
          WHERE lower(le->>'name') = lower(an)
        )
        OR ${titleHasName('an')}
    ))
    OR ((a.genres IS NOT NULL OR a.keywords IS NOT NULL)
      AND (a.genres IS NULL OR ${hasGenre('a.genres', true)} OR ${artistHasGenre('a.genres')})
      -- Trefwoord: als hele woorden in titel of beschrijving.
      AND (a.keywords IS NULL OR EXISTS (
        SELECT 1 FROM unnest(a.keywords) k
        WHERE position(${words('k')} in ${words(`e.title || ' ' || COALESCE(e.description, '')`)}) > 0
      )))
  )
`);

export type AlertFilters = {
  /** Voor wie: diens niet-leuk-genres vallen weg. Leeg = niemand. */
  userId?: string | null;
  venueIds: string[] | null;
  cities: string[] | null;
  categories: string[] | null;
  genres: string[] | null;
  artistNames: string[] | null;
  /** Woorden die in titel of beschrijving moeten staan ("90s", "grunge"). */
  keywords?: string[] | null;
  priceMaxCents: number | null;
  startsFrom: Date | null;
  startsUntil: Date | null;
};

function arr(xs: string[] | null, type: string): SQL {
  if (!xs?.length) return sql.raw(`NULL::${type}[]`);
  // Niet `${xs}::text[]`: Drizzle maakt van een JS-array een rij, geen array.
  return sql`ARRAY[${sql.join(xs.map((x) => sql`${x}`), sql`, `)}]::${sql.raw(type)}[]`;
}

const ts = (d: Date | null) => (d ? sql`${d.toISOString()}::timestamptz` : sql`NULL::timestamptz`);

/** Een regel die (nog) niet in de database staat, als rij `a`. */
export function alertSource(f: AlertFilters): SQL {
  return sql`(SELECT
    ${f.userId ?? null}::text AS user_id,
    ${arr(f.venueIds, 'text')} AS venue_ids,
    ${arr(f.cities, 'city')} AS cities,
    ${arr(f.categories, 'event_category')} AS categories,
    ${arr(f.genres, 'text')} AS genres,
    ${arr(f.artistNames, 'text')} AS artist_names,
    ${arr(f.keywords ?? null, 'text')} AS keywords,
    ${f.priceMaxCents}::int AS price_max_cents,
    ${ts(f.startsFrom)} AS starts_from,
    ${ts(f.startsUntil)} AS starts_until)`;
}

export type AlertMatch = { id: string; title: string; venue: string; startsAt: Date };

/** Wat er nú al staat dat bij deze filters past: eerste avond per event,
    vroegste eerst. */
export async function previewAlert(
  f: AlertFilters,
  limit = 8
): Promise<{ total: number; events: AlertMatch[] }> {
  const res = await db.execute<{ id: string; title: string; venue: string; starts_at: string }>(sql`
    WITH ${GENRE_ALIAS_CTE}
    SELECT DISTINCT ON (e.id) e.id, e.title, v.name AS venue, o.starts_at
    FROM ${alertSource(f)} a
    JOIN occurrences o ON o.starts_at > NOW() AND o.status <> 'cancelled'
    JOIN events e ON e.id = o.event_id AND e.published
    JOIN venues v ON v.id = COALESCE(o.venue_id, e.venue_id) AND v.published
    WHERE ${ALERT_MATCH}
    ORDER BY e.id, o.starts_at
  `);
  const all = res.rows
    .map((r) => ({ id: r.id, title: r.title, venue: r.venue, startsAt: new Date(r.starts_at) }))
    .sort((x, y) => x.startsAt.getTime() - y.startsAt.getTime());
  return { total: all.length, events: all.slice(0, limit) };
}
