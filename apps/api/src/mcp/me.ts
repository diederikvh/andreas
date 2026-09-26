/**
 * MCP-tools over de gebruiker zelf. Nu: `my_plans`, de agenda.
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
        WITH friends AS (
          SELECT CASE WHEN f.from_user_id = ${userId} THEN f.to_user_id ELSE f.from_user_id END AS id
          FROM friendships f
          WHERE f.status = 'accepted' AND ${userId} IN (f.from_user_id, f.to_user_id)
        ),
        -- Welke vrienden mogen mij wat laten zien.
        visible AS (
          SELECT u.id, u.name,
            (u.going_visibility = 'friends' OR (u.going_visibility = 'favorites' AND fav.user_id IS NOT NULL)) AS going_ok,
            (u.saves_visibility = 'friends' OR (u.saves_visibility = 'favorites' AND fav.user_id IS NOT NULL)) AS saves_ok
          FROM friends fr
          JOIN users u ON u.id = fr.id
          LEFT JOIN friend_favorites fav ON fav.user_id = u.id AND fav.friend_id = ${userId}
        ),
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
}
