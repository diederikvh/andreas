/**
 * Genres bij artiesten zetten, uit Last.fm.
 *
 * Twee groepen, in die volgorde:
 *
 *  1. **Artiesten in komende line-ups.** Last.fm is de eerste bron voor
 *     genres, ook als MusicBrainz al tags gaf: die van Last.fm zijn beter.
 *     Geeft Last.fm niets, dan blijven de MusicBrainz-tags staan. Met een
 *     MusicBrainz-id is de match exact; zonder alleen als Last.fm exact
 *     dezelfde naam teruggeeft.
 *  2. **Concerten zonder line-up waarvan de titel de artiest is.**
 *     TivoliVredenburg en Effenaar koppelen geen line-up, maar "Kim Wilde"
 *     is gewoon Kim Wilde. Alleen bij een exacte naam en een artiest die
 *     echt bekend is (`TITLE_MIN_LISTENERS`): een titel als "Nobu" of
 *     "Closing Party" hoort geen artiest te worden.
 *
 * Wat er niet gevonden wordt, krijgt ook een `genres_tried_at`, zodat het
 * niet elke nacht vooraan staat. Opnieuw proberen na `RETRY_DAYS`.
 */
import { sql } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { lastfmArtist } from '../lastfm.js';
import { slugify } from '../scrapers/_artists-enrich.js';

const RETRY_DAYS = 30;
/** Op naam (zonder MusicBrainz-id) moet de artiest minstens zo bekend zijn.
    Weert de meeste naamgenoten van een lokale act. */
const NAME_MIN_LISTENERS = 1000;
/** Voor een titel die de artiest zou zijn, strenger: dan is er geen
    line-up die zegt dat het een artiest is. */
const TITLE_MIN_LISTENERS = 10000;
const MAX_TAGS = 5;
/** Last.fm staat ~5 per seconde toe; ruim eronder. */
const THROTTLE_MS = 250;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
/** Op naam alleen bij een naam die niet snel een naamgenoot heeft: twee
    woorden of meer, of minstens zes tekens. "Moss" op naam werd een Britse
    doommetalband; "Tramhaus" en "Kim Wilde" zijn eenduidig. */
const distinct = (name: string) => name.trim().split(/\s+/).length >= 2 || name.trim().length >= 6;

export async function fillArtistGenres(
  opts: { limit?: number } = {}
): Promise<{ looked: number; filled: number; fromTitles: number; stopped: boolean }> {
  if (!process.env.LASTFM_API_KEY) return { looked: 0, filled: 0, fromTitles: 0, stopped: true };
  const limit = opts.limit ?? 300;
  // Een derde van de beurt voor titels: anders zijn die pas aan de beurt als
  // alle duizenden line-upnamen geweest zijn.
  const titleShare = Math.floor(limit / 3);
  let looked = 0;
  let filled = 0;
  let fromTitles = 0;

  // 1. Artiesten in komende line-ups. Hoofdacts (de eerste naam) eerst: dat
  // is wie het genre van de avond bepaalt, en wie op Last.fm getagd is. De
  // begeleiders van een orkest komen daarna.
  const artists = await db.execute<{ id: string; name: string; mbid: string | null }>(sql`
    SELECT a.id, a.name, a.mbid
    FROM artists a
    JOIN (
      SELECT le.v->>'artistId' AS id, count(*) AS n, bool_or(le.pos = 1) AS headliner
      FROM occurrences o
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(o.lineup) = 'array' THEN o.lineup ELSE '[]'::jsonb END) WITH ORDINALITY AS le(v, pos)
      WHERE o.starts_at > NOW() AND le.v->>'artistId' IS NOT NULL
      GROUP BY 1
    ) u ON u.id = a.id
    WHERE (a.genres_tried_at IS NULL OR a.genres_tried_at < NOW() - make_interval(days => ${RETRY_DAYS}))
    ORDER BY a.genres_tried_at NULLS FIRST, u.headliner DESC, cardinality(a.genres) = 0 DESC, u.n DESC
    LIMIT ${limit - titleShare}
  `);
  for (const a of artists.rows) {
    let hit = a.mbid ? await lastfmArtist(a.name, a.mbid) : undefined;
    if (hit === undefined && distinct(a.name)) {
      await sleep(THROTTLE_MS);
      const byName = await lastfmArtist(a.name);
      hit = byName && same(byName.name, a.name) && byName.listeners >= NAME_MIN_LISTENERS ? byName : byName === null ? null : undefined;
    }
    // Bron eruit: stoppen, niets markeren.
    if (hit === null) return { looked, filled, fromTitles, stopped: true };
    looked++;
    const tags = hit?.tags.slice(0, MAX_TAGS) ?? [];
    await db.execute(sql`
      UPDATE artists SET genres_tried_at = NOW()
        ${tags.length ? sql`, genres = ${sql`ARRAY[${sql.join(tags.map((t) => sql`${t}`), sql`, `)}]::text[]`}` : sql``}
      WHERE id = ${a.id}
    `);
    if (tags.length) filled++;
    await sleep(THROTTLE_MS);
  }

  // 2. Concerten zonder line-up waarvan de titel een artiestnaam kan zijn:
  // kort, zonder "presents", "+", ":" en dergelijke.
  const titles = await db.execute<{ title: string }>(sql`
    SELECT e.title
    FROM events e
    WHERE e.published AND e.category = 'Muziek'
      AND EXISTS (SELECT 1 FROM occurrences o WHERE o.event_id = e.id AND o.starts_at > NOW())
      AND NOT EXISTS (
        SELECT 1 FROM occurrences o2
        WHERE o2.event_id = e.id AND jsonb_typeof(o2.lineup) = 'array' AND jsonb_array_length(o2.lineup) > 0)
      AND length(e.title) BETWEEN 2 AND 40
      AND e.title !~* '(presents|present|feat\\.?|ft\\.|w/|:|\\||\\+| x | & friends|tribute|festival|party|night|nacht|live|tour|b2b|\\()'
      AND NOT EXISTS (SELECT 1 FROM artists ar WHERE lower(ar.name) = lower(e.title))
    -- ponytail: elke keer een willekeurige greep, zonder bij te houden wat
    -- al mislukte. Een gevonden titel valt eruit (er is dan een artiest);
    -- een mislukte kan later nog eens langskomen. Kost wat dubbele
    -- opzoekingen; een eigen tabel met pogingen als dat gaat knellen.
    GROUP BY e.title
    ORDER BY md5(e.title || ${String(Date.now())})
    LIMIT ${titleShare}
  `);
  for (const { title } of titles.rows) {
    if (!distinct(title)) continue;
    const hit = await lastfmArtist(title);
    if (hit === null) return { looked, filled, fromTitles, stopped: true };
    looked++;
    await sleep(THROTTLE_MS);
    if (!hit || !same(hit.name, title) || hit.listeners < TITLE_MIN_LISTENERS || hit.tags.length === 0) continue;
    await db
      .insert(schema.artists)
      .values({
        id: `${slugify(hit.name)}-lfm`,
        name: hit.name,
        mbid: null,
        genres: hit.tags.slice(0, MAX_TAGS),
        genresTriedAt: new Date(),
      })
      .onConflictDoNothing();
    fromTitles++;
  }
  return { looked, filled, fromTitles, stopped: false };
}
