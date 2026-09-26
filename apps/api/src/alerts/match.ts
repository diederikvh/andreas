/**
 * Wanneer past een occurrence bij een meldingsregel?
 *
 * Eén SQL-fragment, gebruikt op twee plekken: de job die nieuwe events aan
 * regels koppelt (`jobs/reminders.ts`) en de preview in `create_alert`. Zo
 * is wat je bij het aanmaken te zien krijgt precies wat de melding later
 * zou vangen — geen tweede, net iets andere interpretatie.
 *
 * Verwacht de aliassen `a` (regel), `o` (occurrence), `e` (event), `v`
 * (venue) en de CTE `genre_alias` (zet `GENRE_ALIAS_CTE` in de WITH).
 */
import { sql, type SQL } from 'drizzle-orm';

import { db } from '../db/index.js';
import {
  EXCLUDED_BY_DEFAULT,
  KIDS_TITLE_REGEX,
  MAIN_LABELS,
  genreAliasValuesSql,
  normalizeGenreSql,
} from './genres.js';

export const GENRE_ALIAS_CTE = sql.raw(
  `genre_alias(key, category, pattern, is_like) AS (${genreAliasValuesSql()})`
);

const N = normalizeGenreSql('g');

/** Heeft het event (eigen `genres`, binnen z'n categorie) een van deze
    vaste genres? Met `mainOnly` alleen in de eerste labels. Verzamellabels
    met een `/` doen alleen exact mee. */
function hasGenre(keysExpr: string, mainOnly: boolean): string {
  const labels = mainOnly ? `e.genres[1:${MAIN_LABELS}]` : 'e.genres';
  return `EXISTS (
    SELECT 1 FROM unnest(${labels}) g
    JOIN genre_alias ga ON ga.category = e.category::text
      AND CASE WHEN ga.is_like THEN position('/' in ${N}) = 0 AND ${N} LIKE ga.pattern
               ELSE ${N} = ga.pattern END
    WHERE ga.key = ANY(${keysExpr})
  )`;
}

/** Woorden van een tekst, gescheiden door spaties en met een spatie aan
    beide kanten. "Fred again.. — USB" → " fred again usb ". Zo matcht een
    naam alleen op hele woorden, zonder regex-escaping van de naam. */
const words = (expr: string) =>
  `(' ' || lower(trim(regexp_replace(${expr}, '[^[:alnum:]]+', ' ', 'g'))) || ' ')`;

/** Staat deze artiestnaam als hele woorden in de titel? Alleen bij namen
    van 4+ tekens ("Eve" zit ook in "New Year's Eve") en niet bij tributes
    ("Tribute to Adele" is geen Adele). Line-ups zijn maar bij een op de
    vijf avonden gekoppeld; bij concerten is de titel vaak gewoon de naam. */
export function titleHasName(nameExpr: string, titleExpr = 'e.title'): string {
  return `(length(${nameExpr}) >= 4
    AND ${titleExpr} !~* 'tribute'
    AND position(${words(nameExpr)} in ${words(titleExpr)}) > 0)`;
}

const excluded = `ARRAY[${EXCLUDED_BY_DEFAULT.map((k) => `'${k}'`).join(',')}]`;

export const ALERT_MATCH = sql.raw(`
  (a.venue_ids IS NULL OR v.id = ANY(a.venue_ids))
  AND (a.cities IS NULL OR v.city = ANY(a.cities))
  AND (a.categories IS NULL OR e.category = ANY(a.categories))
  AND (a.starts_from IS NULL OR o.starts_at >= a.starts_from)
  AND (a.starts_until IS NULL OR o.starts_at < a.starts_until)
  -- Onbekende prijs telt als passend: dat is bij de helft van het aanbod zo.
  AND (a.price_max_cents IS NULL OR o.price_cents IS NULL OR o.price_cents <= a.price_max_cents)
  AND (a.genres IS NULL OR ${hasGenre('a.genres', true)})
  -- Kinder- en workshopaanbod valt erbuiten, tenzij de regel erom vraagt.
  AND NOT ${hasGenre(`ARRAY(SELECT x FROM unnest(${excluded}) x WHERE NOT x = ANY(COALESCE(a.genres, '{}')))`, false)}
  AND ('familie' = ANY(COALESCE(a.genres, '{}')) OR e.title !~* '${KIDS_TITLE_REGEX}')
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
  -- Artiest: in de line-up op naam, of als hele woorden in de titel.
  AND (a.artist_names IS NULL OR EXISTS (
    SELECT 1 FROM unnest(a.artist_names) an
    WHERE EXISTS (
        SELECT 1 FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(o.lineup) = 'array' THEN o.lineup ELSE '[]'::jsonb END
        ) le
        WHERE lower(le->>'name') = lower(an)
      )
      OR ${titleHasName('an')}
  ))
`);

export type AlertFilters = {
  /** Voor wie: diens niet-leuk-genres vallen weg. Leeg = niemand. */
  userId?: string | null;
  venueIds: string[] | null;
  cities: string[] | null;
  categories: string[] | null;
  genres: string[] | null;
  artistNames: string[] | null;
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

/** De nieuwste events die door de harde filters komen: de steekproef
    waarop een smaakregel bij het aanmaken wordt voorgekeurd. "Nieuw" =
    wanneer het event voor het eerst binnenkwam (`MIN`), niet z'n laatste
    nieuwe datum: een wekelijkse jam krijgt elke week een datum erbij en
    stond daardoor bij elke proef bovenaan. */
export async function recentCandidates(f: AlertFilters, limit: number): Promise<string[]> {
  const res = await db.execute<{ id: string }>(sql`
    WITH ${GENRE_ALIAS_CTE}
    SELECT e.id
    FROM ${alertSource(f)} a
    JOIN occurrences o ON o.starts_at > NOW() AND o.status <> 'cancelled'
    JOIN events e ON e.id = o.event_id AND e.published
    JOIN venues v ON v.id = COALESCE(o.venue_id, e.venue_id) AND v.published
    WHERE ${ALERT_MATCH}
    GROUP BY e.id
    ORDER BY MIN(o.created_at) DESC
    LIMIT ${limit}
  `);
  return res.rows.map((r) => r.id);
}
