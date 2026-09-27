/**
 * Concerten zonder artiest: de handmatige kant van de genreklus.
 *
 * Hier staan de komende concerten waar we geen genre bij hebben: de zaal
 * geeft geen bruikbaar label ("Pop / Rock", of niets) én we kennen geen
 * hoofdact met genres. Per concert vul je de artiest(en) in, of zeg je
 * "geen artiest" (een feest, quiz of jamsessie).
 *
 * Invullen zet de line-up op alle komende data van het event en haalt de
 * genres van die artiesten meteen bij Last.fm op; zo telt het concert
 * vanaf dat moment mee in meldingen, de gids en de MCP.
 */
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';

import { GENRES, GENRE_KEYS, type GenreKey } from '../../alerts/genres.js';
import { EVENT_HAS_TASTE_GENRE, GENRE_ALIAS_CTE } from '../../alerts/match.js';
import { db } from '../../db/index.js';
import { lastfmArtist } from '../../lastfm.js';
import { ensureArtistByName } from '../artist-follows.js';
import { requireAdminCookie } from './auth.js';
import { Layout, fmtDate } from './layout.js';

export const artiestenUi = new Hono();
artiestenUi.use('*', requireAdminCookie);

const DAYS = 90;

/** De genres om zelf te kiezen: muziek, zonder de soorten om uit te sluiten. */
const PICKABLE = GENRE_KEYS.filter(
  (k) => (GENRES[k].categories as string[]).includes('Muziek') && !['familie', 'workshop', 'tribute'].includes(k)
);

/** Het label dat we bij een artiest opslaan voor een gekozen genre: een
    patroon uit de lijst zonder %, zodat de matching het exact herkent
    ("wave" wordt "newwave"). */
const tagFor = (k: GenreKey) => GENRES[k].match.find((p) => !p.includes('%')) ?? k;

/**
 * Opslaan en "geen artiest" gaan via fetch, zonder de pagina te herladen:
 * je blijft op je plek in de lijst en de rij toont meteen wat eruit kwam.
 * Kent Last.fm de artiest niet, dan verschijnt het genre-menu met de vraag
 * om er zelf een te kiezen.
 */
const ROW_SCRIPT = `
document.querySelectorAll('form[data-row]').forEach(function (form) {
  form.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var row = form.closest('tr');
    var out = row.querySelector('[data-out]');
    var btn = ev.submitter || form.querySelector('button');
    btn.disabled = true;
    out.textContent = 'Bezig…';
    try {
      var res = await fetch(form.action, { method: 'POST', body: new FormData(form), headers: { Accept: 'application/json' } });
      var data = await res.json();
      out.textContent = data.message;
      if (data.done) {
        row.style.opacity = '0.45';
        row.querySelectorAll('input,select,button').forEach(function (el) { el.disabled = true; });
      } else {
        btn.disabled = false;
        var pick = row.querySelector('input[name=genre]');
        if (data.needGenre && pick) { pick.focus(); pick.style.outline = '2px solid var(--andreas-acid, #d4ff3f)'; }
      }
    } catch (e) {
      out.textContent = 'Dat lukte niet, probeer het nog eens.';
      btn.disabled = false;
    }
  });
});
`;

/** Het concert heeft geen genre: niet van de zaal, niet via een artiest. */
const NO_GENRE = sql`
  e.published AND e.category = 'Muziek' AND NOT e.no_artist
  AND NOT ${EVENT_HAS_TASTE_GENRE}
  AND NOT EXISTS (
    SELECT 1 FROM artists ar
    WHERE cardinality(ar.genres) > 0 AND (
      lower(ar.name) = lower(e.title)
      OR ar.id IN (
        SELECT o3.lineup->0->>'artistId' FROM occurrences o3
        WHERE o3.event_id = e.id AND jsonb_typeof(o3.lineup) = 'array'
      )
    )
  )`;

artiestenUi.get('/', async (c) => {
  const rows = await db.execute<{
    id: string;
    title: string;
    venue: string;
    city: string;
    starts_at: string;
    genres: string[];
    lineup: string[] | null;
  }>(sql`
    WITH ${GENRE_ALIAS_CTE}
    SELECT e.id, e.title, v.name AS venue, v.city::text AS city, MIN(o.starts_at) AS starts_at, e.genres,
      (SELECT array_agg(le->>'name')
       FROM occurrences o2
       CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(o2.lineup) = 'array' THEN o2.lineup ELSE '[]'::jsonb END) le
       WHERE o2.id = (SELECT id FROM occurrences WHERE event_id = e.id AND starts_at > NOW() ORDER BY starts_at LIMIT 1)
      ) AS lineup
    FROM events e
    JOIN occurrences o ON o.event_id = e.id AND o.status <> 'cancelled'
      AND o.starts_at > NOW() AND o.starts_at < NOW() + make_interval(days => ${DAYS})
    JOIN venues v ON v.id = e.venue_id AND v.published
    WHERE ${NO_GENRE}
    GROUP BY e.id, v.name, v.city
    ORDER BY MIN(o.starts_at)
    LIMIT 40
  `);
  const [{ n }] = (
    await db.execute<{ n: number }>(sql`
      WITH ${GENRE_ALIAS_CTE}
      SELECT count(DISTINCT e.id)::int AS n FROM events e
      JOIN occurrences o ON o.event_id = e.id AND o.status <> 'cancelled'
        AND o.starts_at > NOW() AND o.starts_at < NOW() + make_interval(days => ${DAYS})
      JOIN venues v ON v.id = e.venue_id AND v.published
      WHERE ${NO_GENRE}
    `)
  ).rows;
  const done = c.req.query('done');

  return c.html(
    <Layout title="Artiesten" active="artiesten">
      <h2>Concerten zonder artiest</h2>
      <p style="opacity:0.7;font-size:14px;margin-top:-8px;">
        {n} concerten in de komende {DAYS} dagen waar we geen genre bij hebben: de zaal geeft geen
        bruikbaar label en we kennen de artiest niet. Vul de artiest in (meerdere met komma's, de
        hoofdact eerst), of zeg dat er geen artiest bij hoort. De genres komen dan meteen van Last.fm.
      </p>
      {done ? (
        <article style="padding:12px 16px;">
          <strong>{done}</strong>
        </article>
      ) : null}
      <table>
        <thead>
          <tr>
            <th>Concert</th>
            <th>Wanneer</th>
            <th>Artiest(en)</th>
          </tr>
        </thead>
        <tbody>
          {rows.rows.map((r) => (
            <tr>
              <td>
                <a href={`/admin/events/${r.id}`}>{r.title}</a>
                <div style="font-size:12px;opacity:0.6;">
                  {r.venue}
                  {r.city !== 'amsterdam' ? ` (${r.city})` : ''}
                  {r.genres?.length ? ` · ${r.genres.slice(0, 3).join(', ')}` : ''}
                  {r.lineup?.length ? ` · line-up: ${r.lineup.slice(0, 3).join(', ')}` : ''}
                </div>
              </td>
              <td style="white-space:nowrap;font-size:13px;">{fmtDate(r.starts_at)}</td>
              <td class="actions">
                {/* De titel staat er al in: meestal is dat gewoon de band. */}
                <form data-row method="post" action={`/admin/artiesten/${r.id}`} style="display:flex;gap:6px;margin:0;flex-wrap:wrap;">
                  <input
                    type="text"
                    name="names"
                    value={r.lineup?.[0] ?? r.title}
                    style="margin:0;min-width:12rem;flex:1;"
                  />
                  <input
                    type="text"
                    name="genre"
                    list="genres"
                    placeholder="genre (optioneel)"
                    aria-label="Genre (optioneel), meerdere met komma's"
                    style="margin:0;width:11rem;"
                  />
                  <button type="submit" style="width:auto;margin:0;">Opslaan</button>
                </form>
                <form data-row method="post" action={`/admin/artiesten/${r.id}/geen`} style="margin:6px 0 0;">
                  <button type="submit" class="secondary outline" style="width:auto;margin:0;font-size:13px;">
                    Geen artiest
                  </button>
                </form>
                <div data-out style="font-size:13px;margin-top:6px;opacity:0.8;"></div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <datalist id="genres">
        {PICKABLE.map((k) => (
          <option value={GENRES[k].label} />
        ))}
      </datalist>
      <script dangerouslySetInnerHTML={{ __html: ROW_SCRIPT }} />
    </Layout>
  );
});

/** Antwoord als JSON (vanuit de pagina) of als redirect (zonder script). */
function reply(c: any, body: { message: string; done: boolean; needGenre?: boolean }) {
  if ((c.req.header('accept') ?? '').includes('application/json')) return c.json(body);
  return c.redirect('/admin/artiesten?done=' + encodeURIComponent(body.message));
}

artiestenUi.post('/:id', async (c) => {
  const eventId = c.req.param('id');
  const form = await c.req.parseBody();
  const names = String(form.names ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n.length >= 2 && n.length <= 120)
    .slice(0, 12);
  // Zelf ingevulde genres, met komma's. Een genre uit de lijst (label of
  // sleutel) wordt het label dat de matching herkent; iets anders bewaren we
  // zoals het is: "shoegaze" wordt dan indie.
  const picked = String(form.genre ?? '')
    .split(',')
    .map((g) => g.trim().toLowerCase())
    .filter((g) => g.length >= 2 && g.length <= 40)
    .slice(0, 5)
    .map((g) => {
      const key = PICKABLE.find((k) => k === g || GENRES[k].label.toLowerCase() === g);
      return key ? tagFor(key) : g;
    });
  if (names.length === 0) return reply(c, { message: 'Geen naam ingevuld.', done: false });

  const lineup: { name: string; artistId: string }[] = [];
  const found: string[] = [];
  let headlinerGenres: string[] = [];
  for (const [i, name] of names.entries()) {
    const artistId = await ensureArtistByName(name);
    if (!artistId) continue;
    lineup.push({ name, artistId });
    const [row] = (
      await db.execute<{ genres: string[] }>(sql`SELECT genres FROM artists WHERE id = ${artistId}`)
    ).rows;
    let genres = row?.genres ?? [];
    // Jij hebt bevestigd wie het is, dus Last.fm op naam.
    if (genres.length === 0) {
      const hit = await lastfmArtist(name);
      genres = hit?.tags.slice(0, 5) ?? [];
    }
    // Zelf ingevulde genres gaan voor, en gelden voor de hoofdact.
    if (i === 0 && picked.length) genres = [...picked, ...genres.filter((g) => !picked.includes(g))].slice(0, 5);
    await db.execute(sql`
      UPDATE artists SET genres_tried_at = NOW()
        ${genres.length ? sql`, genres = ${sql`ARRAY[${sql.join(genres.map((g) => sql`${g}`), sql`, `)}]::text[]`}` : sql``}
      WHERE id = ${artistId}
    `);
    if (i === 0) headlinerGenres = genres;
    found.push(`${name}: ${genres.length ? genres.join(', ') : 'geen genres'}`);
  }
  // De line-up op alle komende data; jij bent hier de bron.
  await db.execute(sql`
    UPDATE occurrences SET lineup = ${JSON.stringify(lineup)}::jsonb
    WHERE event_id = ${eventId} AND starts_at > NOW()
  `);
  if (headlinerGenres.length === 0) {
    return reply(c, {
      message: `Opgeslagen, maar Last.fm kent ${names[0]} niet. Vul een genre in (bv. hiphop, Nederlandstalig) en klik nog eens op Opslaan.`,
      done: false,
      needGenre: true,
    });
  }
  return reply(c, { message: `✓ ${found.join(' · ')}`, done: true });
});

artiestenUi.post('/:id/geen', async (c) => {
  await db.execute(sql`UPDATE events SET no_artist = true WHERE id = ${c.req.param('id')}`);
  return reply(c, { message: '✓ Geen artiest', done: true });
});
