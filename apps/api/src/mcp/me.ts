/**
 * MCP-tools over de gebruiker zelf: `my_plans` (de agenda), `friends_plans`
 * (wat vrienden gered hebben en waar ze heen gaan), en de acties die in de
 * app hetzelfde doen: `save_event` (hartje), `set_going` ("ik ga"),
 * `set_venue` (volgen/blokkeren), `set_genre_taste` en `my_taste`.
 *
 * Eén overzicht van wat er voor je klaarstaat: waar je heen gaat (zelf
 * "ik ga" of ja op een uitnodiging, zelfde bronnen als `routes/going.ts`),
 * uitnodigingen waar je nog op moet reageren, wat je gered hebt, en je
 * eigen aanmeldingen die nog geen event zijn. Per avond welke vrienden er
 * ook gaan of 'm gered hebben.
 *
 * Privacy zoals in de app (`routes/social.ts`): een vriend telt alleen mee
 * als diens `going_visibility` of `saves_visibility` het toelaat. Op
 * `favorites` alleen als die vriend jou als favoriet heeft.
 *
 * Tickets staan hier bewust niet in: die verlaten het toestel nooit.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { GENRES, GENRE_KEYS, type GenreKey } from '../alerts/genres.js';
import { ALERT_MATCH, GENRE_ALIAS_CTE, alertSource } from '../alerts/match.js';
import { recommendEvents } from '../alerts/recommend.js';
import { db, schema } from '../db/index.js';
import { parseAmsterdamLocal } from '../scrapers/_amsterdam-tz.js';
import { resolveVenues } from './alerts.js';
import { PUBLIC_BASE_URL } from './events.js';

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const whenFmt = new Intl.DateTimeFormat('nl-NL', {
  timeZone: 'Europe/Amsterdam',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * CTE's `friends` en `visible`: mijn geaccepteerde vrienden, en per vriend
 * of ik diens "ik ga" (`going_ok`) en likes (`saves_ok`) mag zien. Zelfde
 * regels als `routes/social.ts`; op `favorites` alleen als die vriend mij
 * als favoriet heeft.
 */
export function visibleFriendsCte(userId: string) {
  return sql`friends AS (
      SELECT CASE WHEN f.from_user_id = ${userId} THEN f.to_user_id ELSE f.from_user_id END AS id
      FROM friendships f
      WHERE f.status = 'accepted' AND ${userId} IN (f.from_user_id, f.to_user_id)
    ),
    visible AS (
      SELECT u.id, u.name, u.handle,
        (u.going_visibility = 'friends' OR (u.going_visibility = 'favorites' AND fav.user_id IS NOT NULL)) AS going_ok,
        (u.saves_visibility = 'friends' OR (u.saves_visibility = 'favorites' AND fav.user_id IS NOT NULL)) AS saves_ok
      FROM friends fr
      JOIN users u ON u.id = fr.id
      LEFT JOIN friend_favorites fav ON fav.user_id = u.id AND fav.friend_id = ${userId}
    )`;
}

type Occ = { id: string; title: string; venue: string; startsAt: Date; others: number };

/** De voorstelling waar een actie over gaat. `eventId` mag ook de hele
    link zijn (…/e/<id>). Zonder datum de eerstvolgende. */
async function findOccurrence(eventIdOrUrl: string, date?: string): Promise<Occ | string> {
  const eventId = eventIdOrUrl.trim().split('/e/').pop()!.split(/[?#]/)[0];
  const res = await db.execute<{ id: string; title: string; venue: string; starts_at: string }>(sql`
    SELECT o.id, e.title, v.name AS venue, o.starts_at
    FROM occurrences o
    JOIN events e ON e.id = o.event_id AND e.published
    JOIN venues v ON v.id = COALESCE(o.venue_id, e.venue_id)
    WHERE o.event_id = ${eventId} AND o.starts_at > NOW() AND o.status <> 'cancelled'
    ORDER BY o.starts_at
  `);
  if (res.rows.length === 0) return `Geen komende voorstelling gevonden voor event "${eventId}".`;
  let rows = res.rows;
  if (date) {
    // Dag loopt van 06:00 tot 06:00.
    const from = parseAmsterdamLocal(`${date}T06:00:00`).getTime();
    rows = rows.filter((r) => {
      const t = new Date(r.starts_at).getTime();
      return t >= from && t < from + 86_400_000;
    });
    if (rows.length === 0) {
      return `Op ${date} speelt dit niet. Wel: ${res.rows.slice(0, 6).map((r) => whenFmt.format(new Date(r.starts_at))).join(', ')}.`;
    }
  }
  const r = rows[0];
  return { id: r.id, title: r.title, venue: r.venue, startsAt: new Date(r.starts_at), others: res.rows.length - 1 };
}

const occLabel = (o: Occ) =>
  `${o.title} — ${o.venue}, ${whenFmt.format(o.startsAt)}` +
  (o.others > 0 ? ` (er zijn nog ${o.others} andere data; geef \`date\` voor een andere)` : '');

type PlanRow = {
  event_id: string;
  title: string;
  venue: string;
  starts_at: string;
  status: string;
  how: 'going' | 'invited' | 'saved';
  invited_by: string | null;
  friends_going: string[] | null;
  friends_saved: string[] | null;
};

export function registerMeTools(server: McpServer, userId: string): void {
  server.registerTool(
    'my_plans',
    {
      title: 'Mijn agenda',
      description:
        'De agenda van de gebruiker: waar die heen gaat, openstaande uitnodigingen, wat die gered heeft, ' +
        'eigen aanmeldingen, en per avond welke vrienden ook gaan of het gered hebben. Standaard alles ' +
        'wat nog komt. Gebruik dit ook voor "wat doe ik dit weekend" of "botst er iets" (vergelijk de tijden). ' +
        'Kaartjes staan hier niet in: die blijven op de telefoon.',
      inputSchema: {
        from: DATE.optional().describe('Vanaf deze dag (YYYY-MM-DD). Default: nu.'),
        to: DATE.optional().describe('Tot en met deze dag (YYYY-MM-DD). Default: geen grens.'),
      },
    },
    async ({ from, to }) => {
      // Dag loopt van 06:00 tot 06:00, zoals overal in de app.
      const start = from ? parseAmsterdamLocal(`${from}T06:00:00`) : new Date();
      const end = to
        ? new Date(parseAmsterdamLocal(`${to}T06:00:00`).getTime() + 86_400_000)
        : null;

      const res = await db.execute<PlanRow>(sql`
        WITH ${visibleFriendsCte(userId)},
        mine AS (
          SELECT a.occurrence_id, 'going' AS how, NULL::text AS invited_by
          FROM attendance a WHERE a.user_id = ${userId}
          UNION ALL
          SELECT i.occurrence_id,
                 CASE WHEN ir.status = 'going' THEN 'going' ELSE 'invited' END,
                 -- Wie zelf uitnodigde heeft ook een antwoordrij; "uitgenodigd
                 -- door jezelf" is geen informatie.
                 CASE WHEN i.from_user_id = ${userId} THEN NULL ELSE inviter.name END
          FROM invitation_responses ir
          JOIN invitations i ON i.id = ir.invitation_id AND i.revoked_at IS NULL
          JOIN users inviter ON inviter.id = i.from_user_id
          WHERE ir.user_id = ${userId} AND ir.status IN ('going', 'pending', 'maybe')
          UNION ALL
          SELECT s.occurrence_id, 'saved', NULL FROM saves s WHERE s.user_id = ${userId}
        ),
        -- Per avond de sterkste reden: gaan > uitgenodigd > gered.
        ranked AS (
          SELECT DISTINCT ON (occurrence_id) occurrence_id, how, invited_by
          FROM mine
          ORDER BY occurrence_id, CASE how WHEN 'going' THEN 0 WHEN 'invited' THEN 1 ELSE 2 END
        )
        SELECT e.id AS event_id, e.title, v.name AS venue, o.starts_at, o.status::text AS status,
               r.how, r.invited_by,
               (
                 SELECT array_agg(DISTINCT vi.name ORDER BY vi.name) FROM visible vi
                 WHERE vi.going_ok AND (
                   EXISTS (SELECT 1 FROM attendance a WHERE a.user_id = vi.id AND a.occurrence_id = o.id)
                   OR EXISTS (
                     SELECT 1 FROM invitation_responses ir
                     JOIN invitations i ON i.id = ir.invitation_id AND i.revoked_at IS NULL
                     WHERE ir.user_id = vi.id AND ir.status = 'going' AND i.occurrence_id = o.id
                   )
                 )
               ) AS friends_going,
               (
                 SELECT array_agg(DISTINCT vi.name ORDER BY vi.name) FROM visible vi
                 WHERE vi.saves_ok
                   AND EXISTS (SELECT 1 FROM saves s WHERE s.user_id = vi.id AND s.occurrence_id = o.id)
               ) AS friends_saved
        FROM ranked r
        JOIN occurrences o ON o.id = r.occurrence_id
        JOIN events e ON e.id = o.event_id AND e.published
        JOIN venues v ON v.id = COALESCE(o.venue_id, e.venue_id)
        WHERE o.starts_at >= ${start.toISOString()}::timestamptz
          ${end ? sql`AND o.starts_at < ${end.toISOString()}::timestamptz` : sql``}
        ORDER BY o.starts_at
        LIMIT 200
      `);

      // Eigen aanmeldingen die (nog) geen event zijn, met "ik ga" erop.
      const subs = await db.execute<{ title: string | null; venue_name: string | null; date: string | null; time: string | null }>(sql`
        SELECT es.title, es.venue_name, es.date, es.time
        FROM submission_going sg
        JOIN event_submissions es ON es.id = sg.submission_id
        WHERE sg.user_id = ${userId} AND es.event_id IS NULL
          AND (es.date IS NULL OR es.date >= ${(from ?? new Date().toISOString().slice(0, 10))})
          ${to ? sql`AND (es.date IS NULL OR es.date <= ${to})` : sql``}
        ORDER BY es.date NULLS LAST
      `);

      const rows = res.rows;
      if (rows.length === 0 && subs.rows.length === 0) {
        return text('Niets gepland of gered in deze periode.');
      }

      const line = (r: PlanRow) => {
        const bits = [
          `[${r.title.replace(/[[\]]/g, '')}](${PUBLIC_BASE_URL}/e/${r.event_id})`,
          `${r.venue}, ${whenFmt.format(new Date(r.starts_at))}`,
        ];
        if (r.status === 'cancelled') bits.push('AFGELAST');
        if (r.status === 'sold_out') bits.push('uitverkocht');
        if (r.invited_by) bits.push(`uitgenodigd door ${r.invited_by}`);
        if (r.friends_going?.length) bits.push(`gaan ook: ${r.friends_going.join(', ')}`);
        if (r.friends_saved?.length) bits.push(`gered door: ${r.friends_saved.join(', ')}`);
        return `- ${bits.join(' — ')}`;
      };

      const sections: string[] = [];
      const going = rows.filter((r) => r.how === 'going');
      const invited = rows.filter((r) => r.how === 'invited');
      const saved = rows.filter((r) => r.how === 'saved');
      if (going.length) sections.push(`Ik ga (${going.length}):\n${going.map(line).join('\n')}`);
      if (invited.length) sections.push(`Uitgenodigd, nog niet gereageerd (${invited.length}):\n${invited.map(line).join('\n')}`);
      if (subs.rows.length) {
        sections.push(
          `Zelf aangemeld, nog niet in Andreas (${subs.rows.length}):\n` +
            subs.rows
              .map((s) => `- ${s.title ?? '(zonder titel)'} — ${s.venue_name ?? '?'}, ${s.date ?? 'datum onbekend'}${s.time ? ` ${s.time}` : ''}`)
              .join('\n')
        );
      }
      if (saved.length) sections.push(`Gered (${saved.length}):\n${saved.map(line).join('\n')}`);
      return text(sections.join('\n\n'));
    }
  );

  server.registerTool(
    'friends_plans',
    {
      title: 'Wat doen mijn vrienden',
      description:
        'Waar vrienden van de gebruiker heen gaan en wat ze gered hebben, per avond, met of de gebruiker ' +
        'zelf ook gaat. Alleen wat die vrienden delen (hun privacy-instellingen gelden). Filter op vriend ' +
        '(naam of handle), zaal, titel of periode; bv. "wie gaat er naar Paradiso" of "wat heeft Midas gered".',
      inputSchema: {
        friends: z.array(z.string().min(2)).optional().describe('Namen of handles van vrienden (deel van de naam mag).'),
        venues: z.array(z.string().min(2)).optional(),
        query: z.string().min(2).optional().describe('Deel van de titel, bv. een artiest.'),
        from: DATE.optional().describe('Vanaf deze dag (YYYY-MM-DD). Default: nu.'),
        to: DATE.optional().describe('Tot en met deze dag (YYYY-MM-DD).'),
      },
    },
    async (args) => {
      const venues = args.venues?.length ? await resolveVenues(args.venues) : { ids: [], names: [] };
      if ('error' in venues) return { ...text(venues.error), isError: true };
      const start = args.from ? parseAmsterdamLocal(`${args.from}T06:00:00`) : new Date();
      const end = args.to
        ? new Date(parseAmsterdamLocal(`${args.to}T06:00:00`).getTime() + 86_400_000)
        : null;
      const patterns = (args.friends ?? []).map((f) => `%${f.trim()}%`);

      const res = await db.execute<{
        event_id: string;
        title: string;
        venue: string;
        starts_at: string;
        status: string;
        going: string[] | null;
        saved: string[] | null;
        me_going: boolean;
        me_saved: boolean;
      }>(sql`
        WITH ${visibleFriendsCte(userId)},
        chosen AS (
          SELECT * FROM visible
          ${patterns.length
            ? sql`WHERE ${sql.join(patterns.map((p) => sql`(name ILIKE ${p} OR handle ILIKE ${p})`), sql` OR `)}`
            : sql``}
        ),
        acts AS (
          SELECT c.name, a.occurrence_id, 'going' AS how
          FROM chosen c JOIN attendance a ON a.user_id = c.id WHERE c.going_ok
          UNION
          SELECT c.name, i.occurrence_id, 'going'
          FROM chosen c
          JOIN invitation_responses ir ON ir.user_id = c.id AND ir.status = 'going'
          JOIN invitations i ON i.id = ir.invitation_id AND i.revoked_at IS NULL
          WHERE c.going_ok
          UNION
          SELECT c.name, s.occurrence_id, 'saved'
          FROM chosen c JOIN saves s ON s.user_id = c.id WHERE c.saves_ok
        )
        SELECT e.id AS event_id, e.title, v.name AS venue, o.starts_at, o.status::text AS status,
               array_agg(DISTINCT acts.name) FILTER (WHERE acts.how = 'going') AS going,
               array_agg(DISTINCT acts.name) FILTER (WHERE acts.how = 'saved') AS saved,
               (
                 EXISTS (SELECT 1 FROM attendance a WHERE a.user_id = ${userId} AND a.occurrence_id = o.id)
                 OR EXISTS (
                   SELECT 1 FROM invitation_responses ir
                   JOIN invitations i ON i.id = ir.invitation_id AND i.revoked_at IS NULL
                   WHERE ir.user_id = ${userId} AND ir.status = 'going' AND i.occurrence_id = o.id
                 )
               ) AS me_going,
               EXISTS (SELECT 1 FROM saves s WHERE s.user_id = ${userId} AND s.occurrence_id = o.id) AS me_saved
        FROM acts
        JOIN occurrences o ON o.id = acts.occurrence_id
        JOIN events e ON e.id = o.event_id AND e.published
        JOIN venues v ON v.id = COALESCE(o.venue_id, e.venue_id)
        WHERE o.starts_at >= ${start.toISOString()}::timestamptz
          ${end ? sql`AND o.starts_at < ${end.toISOString()}::timestamptz` : sql``}
          ${venues.ids.length ? sql`AND v.id IN (${sql.join(venues.ids.map((id) => sql`${id}`), sql`, `)})` : sql``}
          ${args.query ? sql`AND e.title ILIKE ${'%' + args.query.trim() + '%'}` : sql``}
        GROUP BY e.id, e.title, v.name, o.id, o.starts_at, o.status
        ORDER BY o.starts_at
        LIMIT 150
      `);

      if (res.rows.length === 0) {
        if (patterns.length) {
          const known = await db.execute<{ name: string }>(sql`
            WITH ${visibleFriendsCte(userId)} SELECT name FROM visible ORDER BY name
          `);
          return text(
            `Niets gevonden. Vrienden van de gebruiker: ${known.rows.map((r) => r.name).join(', ') || '(geen)'}. ` +
              'Wie z\'n likes of plannen op privé heeft, verschijnt hier niet.'
          );
        }
        return text('Geen gedeelde plannen of likes van vrienden in deze periode.');
      }

      const lines = res.rows.map((r) => {
        const going = r.going ?? [];
        // Wie gaat, heeft 'm meestal ook gered; dat hoeft niet twee keer.
        const saved = (r.saved ?? []).filter((n) => !going.includes(n));
        const bits = [
          `[${r.title.replace(/[[\]]/g, '')}](${PUBLIC_BASE_URL}/e/${r.event_id})`,
          `${r.venue}, ${whenFmt.format(new Date(r.starts_at))}`,
        ];
        if (r.status === 'cancelled') bits.push('AFGELAST');
        if (r.status === 'sold_out') bits.push('uitverkocht');
        if (going.length) bits.push(`gaan: ${going.join(', ')}`);
        if (saved.length) bits.push(`gered: ${saved.join(', ')}`);
        if (r.me_going) bits.push('jij gaat ook');
        else if (r.me_saved) bits.push('jij hebt het ook gered');
        return `- ${bits.join(' — ')}`;
      });
      return text(`${res.rows.length} avonden:\n${lines.join('\n')}`);
    }
  );

  const eventArgs = {
    event_id: z.string().min(3).describe('Event-id of de hele link (…/e/<id>) uit een eerder resultaat.'),
    date: DATE.optional().describe('Welke voorstelling (YYYY-MM-DD), bij events met meerdere data. Default: de eerstvolgende.'),
    on: z.boolean().optional().describe('true = aan (default), false = weer uit.'),
  };

  server.registerTool(
    'save_event',
    {
      title: 'Hartje',
      description:
        'Zet een hartje op een voorstelling (of haal het weg met on: false), precies zoals in de app. ' +
        'Een hartje is interesse, geen belofte om te gaan; het staat meteen in de app en telt mee voor ' +
        'herinneringen als die aanstaan.',
      inputSchema: eventArgs,
    },
    async ({ event_id, date, on = true }) => {
      const occ = await findOccurrence(event_id, date);
      if (typeof occ === 'string') return { ...text(occ), isError: true };
      if (on) {
        await db.insert(schema.saves).values({ userId, occurrenceId: occ.id, source: 'mcp' }).onConflictDoNothing();
        return text(`Hartje gezet: ${occLabel(occ)}.`);
      }
      await db.delete(schema.saves).where(and(eq(schema.saves.userId, userId), eq(schema.saves.occurrenceId, occ.id)));
      return text(`Hartje weggehaald: ${occLabel(occ)}.`);
    }
  );

  server.registerTool(
    'set_going',
    {
      title: 'Ik ga',
      description:
        'Zet "ik ga" op een voorstelling (of haal het weg met on: false), zoals in de app. Vrienden zien ' +
        'het als de gebruiker dat deelt. Bevestig eerst met de gebruiker als die het niet zelf zo vroeg.',
      inputSchema: eventArgs,
    },
    async ({ event_id, date, on = true }) => {
      const occ = await findOccurrence(event_id, date);
      if (typeof occ === 'string') return { ...text(occ), isError: true };
      if (on) {
        await db.insert(schema.attendance).values({ userId, occurrenceId: occ.id, source: 'mcp' }).onConflictDoNothing();
        return text(`Genoteerd, je gaat: ${occLabel(occ)}.`);
      }
      await db
        .delete(schema.attendance)
        .where(and(eq(schema.attendance.userId, userId), eq(schema.attendance.occurrenceId, occ.id)));
      // Een ja op een uitnodiging staat in een andere tabel en blijft staan;
      // die zet je om in de app bij de uitnodiging zelf.
      return text(
        `"Ik ga" weggehaald: ${occLabel(occ)}. Zei je ja op een uitnodiging voor deze avond, dan staat die nog; ` +
          'dat pas je aan bij de uitnodiging in de app.'
      );
    }
  );

  server.registerTool(
    'set_venue',
    {
      title: 'Venue volgen of blokkeren',
      description:
        'Volg een zaal (nieuw aanbod daar in de ochtendpush en bovenaan), blokkeer er een (verdwijnt overal ' +
        'in de app, ook uit /new en uit meldingen), of zet hem terug op normaal.',
      inputSchema: {
        venue: z.string().min(2).describe('Naam van de zaal.'),
        state: z.enum(['volgen', 'blokken', 'normaal']),
      },
    },
    async ({ venue, state }) => {
      const found = await resolveVenues([venue]);
      if ('error' in found) return { ...text(found.error), isError: true };
      const venueId = found.ids[0];
      if (state === 'normaal') {
        await db
          .delete(schema.venueFollows)
          .where(and(eq(schema.venueFollows.userId, userId), eq(schema.venueFollows.venueId, venueId)));
        return text(`${found.names[0]} staat weer op normaal.`);
      }
      await db
        .insert(schema.venueFollows)
        .values({ userId, venueId, state })
        .onConflictDoUpdate({ target: [schema.venueFollows.userId, schema.venueFollows.venueId], set: { state } });
      return text(state === 'volgen' ? `Je volgt nu ${found.names[0]}.` : `${found.names[0]} is geblokkeerd: je ziet er niets meer van.`);
    }
  );

  server.registerTool(
    'set_genre_taste',
    {
      title: 'Genres leuk of niet leuk',
      description:
        'Leg vast welke genres de gebruiker leuk of niet leuk vindt. Niet leuk = weg uit /new en uit alle ' +
        'meldingen (bv. "geen tributebands" = tribute). Leuk = wordt meegewogen bij aanbevelingen. ' +
        '"neutraal" haalt de voorkeur weg. Alleen genres uit de vaste lijst.',
      inputSchema: {
        genres: z
          .array(z.enum(GENRE_KEYS))
          .min(1)
          .describe(GENRE_KEYS.map((k) => `${k} = ${GENRES[k].label}`).join('; ')),
        sentiment: z.enum(['like', 'dislike', 'neutraal']),
      },
    },
    async ({ genres, sentiment }) => {
      for (const genre of genres) {
        if (sentiment === 'neutraal') {
          await db
            .delete(schema.genrePrefs)
            .where(and(eq(schema.genrePrefs.userId, userId), eq(schema.genrePrefs.genre, genre)));
        } else {
          await db
            .insert(schema.genrePrefs)
            .values({ userId, genre, sentiment })
            .onConflictDoUpdate({ target: [schema.genrePrefs.userId, schema.genrePrefs.genre], set: { sentiment } });
        }
      }
      const labels = genres.map((g) => GENRES[g].label).join(', ');
      return text(
        sentiment === 'dislike'
          ? `Niet leuk: ${labels}. Die zie je niet meer op /new en ze komen niet meer in meldingen.`
          : sentiment === 'like'
            ? `Leuk: ${labels}. Wordt meegewogen bij aanbevelingen.`
            : `Voorkeur weggehaald voor: ${labels}.`
      );
    }
  );

  server.registerTool(
    'my_taste',
    {
      title: 'Mijn smaak-instellingen',
      description:
        'Alles wat de gebruiker heeft ingesteld: gevolgde en geblokkeerde zalen, genres leuk/niet leuk, ' +
        'gevolgde artiesten en meldingen.',
      inputSchema: {},
    },
    async () => {
      const [venues, prefs, artists, alerts] = await Promise.all([
        db.execute<{ name: string; state: string }>(sql`
          SELECT v.name, vf.state::text AS state FROM venue_follows vf JOIN venues v ON v.id = vf.venue_id
          WHERE vf.user_id = ${userId} ORDER BY v.name`),
        db.select().from(schema.genrePrefs).where(eq(schema.genrePrefs.userId, userId)),
        db.execute<{ name: string }>(sql`
          SELECT ar.name FROM artist_follows f JOIN artists ar ON ar.id = f.artist_id
          WHERE f.user_id = ${userId} ORDER BY lower(ar.name)`),
        db.select({ label: schema.alerts.label }).from(schema.alerts).where(eq(schema.alerts.userId, userId)),
      ]);
      const label = (g: string) => (g in GENRES ? GENRES[g as GenreKey].label : g);
      const list = (xs: string[]) => (xs.length ? xs.join(', ') : '(geen)');
      return text(
        [
          `Zalen gevolgd: ${list(venues.rows.filter((v) => v.state === 'volgen').map((v) => v.name))}`,
          `Zalen geblokkeerd: ${list(venues.rows.filter((v) => v.state === 'blokken').map((v) => v.name))}`,
          `Genres leuk: ${list(prefs.filter((p) => p.sentiment === 'like').map((p) => label(p.genre)))}`,
          `Genres niet leuk: ${list(prefs.filter((p) => p.sentiment === 'dislike').map((p) => label(p.genre)))}`,
          `Artiesten gevolgd: ${list(artists.rows.map((a) => a.name))}`,
          `Meldingen: ${list(alerts.map((a) => a.label))}`,
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'recommend_events',
    {
      title: 'Meer zoals wat je doet',
      description:
        'Materiaal voor aanbevelingen: het smaakprofiel van de gebruiker (waar die heen gaat, wat die gered ' +
        'en weggeveegd heeft, gevolgde artiesten, genres leuk/niet leuk, omschrijvingen van meldingen) en een ' +
        'voorselectie van kandidaten met beschrijving en line-up. Kies zelf wat past en geef per keuze een ' +
        'korte, concrete reden; verzin niets over de gebruiker dat niet in het profiel staat. Weggelaten is al ' +
        'wat in de agenda staat, gered of weggeveegd is, geblokkeerde zalen, niet-leuk-genres en avonden van ' +
        'artiesten die de gebruiker al volgt. Zonder stad: de steden waar de gebruiker zelf heen gaat; zonder ' +
        'periode: de komende 60 dagen. Bied daarna aan om iets een hartje te geven (save_event) of er een ' +
        'melding van te maken.',
      inputSchema: {
        cities: z.array(z.enum(schema.city.enumValues)).optional(),
        categories: z.array(z.enum(['Muziek', 'Film', 'Theater', 'Kunst', 'Lezing', 'Literatuur', 'Activiteit'])).optional(),
        from: DATE.optional(),
        to: DATE.optional(),
        limit: z.number().int().min(1).max(50).optional().describe('Aantal kandidaten, default 30.'),
      },
    },
    async ({ cities, categories, from, to, limit }) => {
      const { taste, examples, candidates, cities: usedCities } = await recommendEvents(userId, {
        cities,
        categories,
        from: from ? parseAmsterdamLocal(`${from}T06:00:00`) : undefined,
        to: to ? new Date(parseAmsterdamLocal(`${to}T06:00:00`).getTime() + 86_400_000) : undefined,
        limit,
      });
      const profile = [
        `Smaak: ${taste}`,
        examples.length
          ? `Eerdere keuzes:\n${examples.map((x) => `- ${x.title} (${x.venue}): ${x.note}`).join('\n')}`
          : '',
      ].filter(Boolean).join('\n');
      if (candidates.length === 0) {
        return text(`${profile}\n\nGeen kandidaten gevonden${usedCities.length ? ` in ${usedCities.join(', ')}` : ''}. Probeer een andere stad of periode.`);
      }
      const lines = candidates.map((e) => {
        const lineup = e.lineup.length
          ? `\n  Line-up: ${e.lineup.map((l) => (l.genres.length ? `${l.name} (${l.genres.slice(0, 4).join(', ')})` : l.name)).join('; ')}`
          : '';
        const about = e.description ? `\n  ${e.description.replace(/\s+/g, ' ').trim().slice(0, 400)}` : '';
        return (
          `- [${e.title.replace(/[[\]]/g, '')}](${PUBLIC_BASE_URL}/e/${e.id}) — ${e.venue}` +
          `${e.city !== 'amsterdam' ? ` (${e.city})` : ''}, ${whenFmt.format(e.startsAt)} · ${e.category}` +
          `${e.genres.length ? ` · ${e.genres.slice(0, 3).join(', ')}` : ''}${lineup}${about}`
        );
      });
      return text(
        `${profile}\n\n${candidates.length} kandidaten${usedCities.length ? ` in ${usedCities.join(', ')}` : ''}. ` +
          `Kies er de beste uit voor deze persoon, met een reden per keuze:\n${lines.join('\n')}`
      );
    }
  );

  server.registerTool(
    'around_evening',
    {
      title: 'Rond je avond',
      description:
        'Wat er vóór en na een avond te doen is in de buurt (binnen 2 km, met looptijd): een film of expo ' +
        'ervoor, een club of concert erna. Standaard de eerstvolgende avond waar de gebruiker heen gaat; of ' +
        'geef event_id (+ date bij meerdere data). Geblokkeerde zalen en niet-leuk-genres vallen weg. Kies ' +
        'zelf met de smaak van de gebruiker wat je aanraadt, en houd rekening met de looptijd.',
      inputSchema: {
        event_id: z.string().optional().describe('Event-id of link. Default: eerstvolgende "ik ga".'),
        date: DATE.optional(),
        radius_km: z.number().min(0.3).max(10).optional().describe('Default 2.'),
      },
    },
    async ({ event_id, date, radius_km = 2 }) => {
      // De avond zelf: gegeven, of de eerstvolgende waar je heen gaat.
      let occId: string | null = null;
      if (event_id) {
        const occ = await findOccurrence(event_id, date);
        if (typeof occ === 'string') return { ...text(occ), isError: true };
        occId = occ.id;
      } else {
        const next = await db.execute<{ id: string }>(sql`
          SELECT o.id FROM occurrences o
          WHERE o.starts_at > NOW() AND o.status <> 'cancelled' AND (
            EXISTS (SELECT 1 FROM attendance a WHERE a.user_id = ${userId} AND a.occurrence_id = o.id)
            OR EXISTS (SELECT 1 FROM invitation_responses ir
                       JOIN invitations i ON i.id = ir.invitation_id AND i.revoked_at IS NULL
                       WHERE ir.user_id = ${userId} AND ir.status = 'going' AND i.occurrence_id = o.id)
          )
          ORDER BY o.starts_at LIMIT 1
        `);
        occId = next.rows[0]?.id ?? null;
        if (!occId) return text('Er staat geen avond in de agenda. Geef een event op.');
      }

      // Zonder eindtijd: gangbare duur per soort. Een concert loopt langer
      // dan een film; een tentoonstelling doet hier niet mee (hele dag).
      const END = (occ: string, ev: string) =>
        `COALESCE(${occ}.ends_at, ${occ}.starts_at + CASE ${ev}.category WHEN 'Muziek' THEN INTERVAL '3 hours' ELSE INTERVAL '2 hours' END)`;

      const base = await db.execute<{ title: string; venue: string; lat: number; lng: number; starts_at: string; ends_at: string }>(sql`
        SELECT e.title, v.name AS venue, v.lat, v.lng, o.starts_at, ${sql.raw(END('o', 'e'))} AS ends_at
        FROM occurrences o JOIN events e ON e.id = o.event_id
        JOIN venues v ON v.id = COALESCE(o.venue_id, e.venue_id)
        WHERE o.id = ${occId}
      `);
      const b = base.rows[0];
      if (!b) return { ...text('Die avond kon ik niet vinden.'), isError: true };

      const source = alertSource({
        userId, venueIds: null, cities: null, categories: null, genres: null,
        artistNames: null, priceMaxCents: null, startsFrom: null, startsUntil: null,
      });
      // Afstand in km (haversine) vanaf de zaal van je avond.
      const km = sql.raw(`(6371 * 2 * asin(sqrt(
        power(sin(radians(v.lat - ${Number(b.lat)}) / 2), 2) +
        cos(radians(${Number(b.lat)})) * cos(radians(v.lat)) * power(sin(radians(v.lng - ${Number(b.lng)}) / 2), 2)
      )))`);
      const res = await db.execute<{
        event_id: string; title: string; venue: string; category: string; genres: string[];
        starts_at: string; ends_at: string; km: number; slot: 'voor' | 'na';
      }>(sql`
        WITH ${GENRE_ALIAS_CTE}
        SELECT DISTINCT ON (e.id) e.id AS event_id, e.title, v.name AS venue, e.category::text AS category,
               e.genres, o.starts_at, ${sql.raw(END('o', 'e'))} AS ends_at, ${km} AS km,
               CASE WHEN o.starts_at < ${b.starts_at}::timestamptz THEN 'voor' ELSE 'na' END AS slot
        FROM ${source} a
        JOIN occurrences o ON o.status <> 'cancelled'
          AND o.starts_at BETWEEN ${b.starts_at}::timestamptz - INTERVAL '5 hours'
                              AND ${b.ends_at}::timestamptz + INTERVAL '3 hours'
        JOIN events e ON e.id = o.event_id AND e.published AND e.kind <> 'exhibition'
        JOIN venues v ON v.id = COALESCE(o.venue_id, e.venue_id) AND v.published
        WHERE ${ALERT_MATCH}
          AND (
            -- Ervoor: begint hooguit 5 uur eerder en is een kwartier voor
            -- de aanvang afgelopen.
            (o.starts_at < ${b.starts_at}::timestamptz
              AND ${sql.raw(END('o', 'e'))} <= ${b.starts_at}::timestamptz - INTERVAL '15 minutes')
            -- Erna: begint vanaf een half uur voor het einde tot 3 uur erna.
            OR o.starts_at >= ${b.ends_at}::timestamptz - INTERVAL '30 minutes'
          )
          AND o.id <> ${occId}
          AND ${km} <= ${radius_km}
        ORDER BY e.id, o.starts_at
      `);

      const walk = (d: number) => (d < 0.15 ? 'zelfde plek' : `${Math.max(1, Math.round(d * 12))} min lopen`);
      const t = (x: string) => new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' }).format(new Date(x));
      const line = (r: (typeof res.rows)[number]) =>
        `- ${t(r.starts_at)}–${t(r.ends_at)} [${r.title.replace(/[[\]]/g, '')}](${PUBLIC_BASE_URL}/e/${r.event_id}) — ` +
        `${r.venue} (${walk(Number(r.km))}) · ${r.category}${r.genres[0] ? `, ${r.genres.slice(0, 2).join(', ')}` : ''}`;
      const byTime = (x: (typeof res.rows)[number], y: (typeof res.rows)[number]) =>
        new Date(x.starts_at).getTime() - new Date(y.starts_at).getTime();
      // Ervoor: het dichtst bij je aanvang bovenaan (de film van 17:45 is
      // relevanter dan die van 15:00). Erna: gewoon op tijd.
      const before = res.rows.filter((r) => r.slot === 'voor').sort((x, y) => byTime(y, x)).slice(0, 12);
      const after = res.rows.filter((r) => r.slot === 'na').sort(byTime).slice(0, 12);

      const head = `Je avond: ${b.title} — ${b.venue}, ${whenFmt.format(new Date(b.starts_at))} (tot ~${t(b.ends_at)}).`;
      const parts = [head];
      parts.push(before.length ? `Ervoor (${before.length}):\n${before.map(line).join('\n')}` : 'Ervoor: niets in de buurt.');
      parts.push(after.length ? `Erna (${after.length}):\n${after.map(line).join('\n')}` : 'Erna: niets in de buurt.');
      return text(parts.join('\n\n'));
    }
  );
}
