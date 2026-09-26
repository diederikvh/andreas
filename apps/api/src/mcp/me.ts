/**
 * MCP-tools over de gebruiker zelf: `my_plans` (de agenda) en
 * `friends_plans` (wat vrienden gered hebben en waar ze heen gaan).
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
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../db/index.js';
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
}
