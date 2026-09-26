/**
 * MCP-tools voor artiesten volgen: `list_followed_artists`, `follow_artists`,
 * `unfollow_artists` en `artists_playing`.
 *
 * Voorstellen doen we bewust niet zelf. `artists_playing` levert wie er
 * binnenkort speelt; het model van de client kent muziek beter dan welke
 * lijst dan ook en kiest daaruit wie lijkt op wie je volgt. Pas na een ja
 * volgt `follow_artists`.
 *
 * Volgen gaat op naam en werkt ook voor wie hier nog nooit speelde: de rij
 * wordt aangemaakt en gaat af zodra een zaal de artiest aankondigt (zie
 * `followArtistByName`).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { GENRE_KEYS } from '../alerts/genres.js';
import { ALERT_MATCH, GENRE_ALIAS_CTE, alertSource, titleHasName } from '../alerts/match.js';
import { db, schema } from '../db/index.js';
import { followArtistByName } from '../routes/artist-follows.js';
import { parseAmsterdamLocal } from '../scrapers/_amsterdam-tz.js';
import { resolveVenues } from './alerts.js';
import { CATEGORY_VALUES, PUBLIC_BASE_URL } from './events.js';

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const text = (t: string, isError = false) => ({
  content: [{ type: 'text' as const, text: t }],
  ...(isError ? { isError: true } : {}),
});
const dayFmt = new Intl.DateTimeFormat('nl-NL', {
  timeZone: 'Europe/Amsterdam',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const link = (id: string, title: string) => `[${title.replace(/[[\]]/g, '')}](${PUBLIC_BASE_URL}/e/${id})`;

/** Gevolgde artiesten met hun eerstvolgende avond, als die er is. Zelfde
    herkenning als de melding: in de line-up, of de naam in de titel. */
async function followedWithNextShow(userId: string, names?: string[]) {
  const filter = names?.length
    ? sql`AND lower(ar.name) IN (${sql.join(names.map((n) => sql`lower(${n})`), sql`, `)})`
    : sql``;
  const res = await db.execute<{
    name: string;
    event_id: string | null;
    title: string | null;
    venue: string | null;
    starts_at: string | null;
  }>(sql`
    SELECT ar.name, nx.event_id, nx.title, nx.venue, nx.starts_at
    FROM artist_follows f
    JOIN artists ar ON ar.id = f.artist_id
    LEFT JOIN LATERAL (
      SELECT e.id AS event_id, e.title, v.name AS venue, o.starts_at
      FROM occurrences o
      JOIN events e ON e.id = o.event_id AND e.published
      JOIN venues v ON v.id = COALESCE(o.venue_id, e.venue_id) AND v.published
      WHERE o.starts_at > NOW() AND o.status <> 'cancelled'
        AND (
          (jsonb_typeof(o.lineup) = 'array' AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(o.lineup) le WHERE le->>'artistId' = ar.id
          ))
          OR ${sql.raw(titleHasName('ar.name'))}
        )
      ORDER BY o.starts_at
      LIMIT 1
    ) nx ON TRUE
    WHERE f.user_id = ${userId} ${filter}
    ORDER BY lower(ar.name)
  `);
  return res.rows;
}

function showLine(r: { name: string; event_id: string | null; title: string | null; venue: string | null; starts_at: string | null }) {
  return r.event_id
    ? `- ${r.name} — speelt: ${link(r.event_id, r.title!)}, ${r.venue}, ${dayFmt.format(new Date(r.starts_at!))}`
    : `- ${r.name} — nog niets aangekondigd`;
}

export function registerArtistTools(server: McpServer, userId: string): void {
  server.registerTool(
    'list_followed_artists',
    {
      title: 'Artiesten die ik volg',
      description:
        'De artiesten die de gebruiker volgt, met de eerstvolgende avond als die er is. Volgen = een push ' +
        'om 10:00 zodra er een nieuwe avond met die artiest bijkomt.',
      inputSchema: {},
    },
    async () => {
      const rows = await followedWithNextShow(userId);
      if (rows.length === 0) return text('De gebruiker volgt nog geen artiesten.');
      return text(`${rows.length} artiesten gevolgd:\n${rows.map(showLine).join('\n')}`);
    }
  );

  server.registerTool(
    'follow_artists',
    {
      title: 'Artiesten volgen',
      description:
        'Volg artiesten op naam. Werkt ook voor wie nog nooit in Andreas stond: de melding gaat af zodra ' +
        'een zaal de artiest aankondigt. Gebruik de officiële spelling ("The Afghan Whigs"). Stel je zelf ' +
        'artiesten voor, volg ze dan pas nadat de gebruiker ja zei.',
      inputSchema: { names: z.array(z.string().min(2).max(120)).min(1).max(50) },
    },
    async ({ names }) => {
      const failed: string[] = [];
      for (const raw of names) {
        if (!(await followArtistByName(userId, raw.trim()))) failed.push(raw);
      }
      const rows = await followedWithNextShow(userId, names.map((n) => n.trim()));
      const lines = [`Gevolgd:\n${rows.map(showLine).join('\n')}`];
      if (failed.length) lines.push(`Niet gelukt: ${failed.join(', ')}.`);
      return text(lines.join('\n'));
    }
  );

  server.registerTool(
    'unfollow_artists',
    {
      title: 'Artiesten ontvolgen',
      description: 'Stop met het volgen van artiesten, op naam.',
      inputSchema: { names: z.array(z.string().min(2)).min(1).max(50) },
    },
    async ({ names }) => {
      const res = await db.execute<{ name: string }>(sql`
        DELETE FROM artist_follows f
        USING artists ar
        WHERE ar.id = f.artist_id AND f.user_id = ${userId}
          AND lower(ar.name) IN (${sql.join(names.map((n) => sql`lower(${n.trim()})`), sql`, `)})
        RETURNING ar.name
      `);
      const gone = res.rows.map((r) => r.name);
      return gone.length
        ? text(`Niet meer gevolgd: ${gone.join(', ')}.`)
        : text('Geen van deze artiesten werd gevolgd.', true);
    }
  );

  server.registerTool(
    'artists_playing',
    {
      title: 'Wie speelt er binnenkort',
      description:
        'Acts met komende avonden in Andreas, met de genres die we van ze kennen. Bedoeld om artiesten voor ' +
        'te stellen: haal list_followed_artists op, filter hier op zaal/stad/periode, en kies met je eigen ' +
        'muziekkennis welke acts lijken op wie de gebruiker volgt of wat de gebruiker omschrijft. Wees ' +
        'kritisch; noem alleen acts die hier staan.',
      inputSchema: {
        venues: z.array(z.string().min(2)).optional(),
        cities: z.array(z.enum(schema.city.enumValues)).optional(),
        categories: z.array(z.enum(CATEGORY_VALUES)).optional().describe('Default: Muziek.'),
        genres: z.array(z.enum(GENRE_KEYS)).optional().describe('Ruwe voorselectie; de labels zijn grof.'),
        from: DATE.optional(),
        to: DATE.optional(),
        limit: z.number().int().min(1).max(300).optional().describe('Aantal events, default 150.'),
      },
    },
    async (args) => {
      const venues = args.venues?.length ? await resolveVenues(args.venues) : { ids: [], names: [] };
      if ('error' in venues) return text(venues.error, true);
      const source = alertSource({
        venueIds: venues.ids.length ? venues.ids : null,
        cities: args.cities?.length ? args.cities : null,
        categories: args.categories?.length ? args.categories : ['Muziek'],
        genres: args.genres?.length ? args.genres : null,
        artistNames: null,
        priceMaxCents: null,
        startsFrom: args.from ? parseAmsterdamLocal(`${args.from}T06:00:00`) : null,
        startsUntil: args.to ? parseAmsterdamLocal(`${args.to}T23:59:00`) : null,
      });
      const res = await db.execute<{
        id: string;
        title: string;
        venue: string;
        starts_at: string;
        acts: { name: string; genres: string[] }[] | null;
      }>(sql`
        WITH ${GENRE_ALIAS_CTE}
        SELECT DISTINCT ON (e.id) e.id, e.title, v.name AS venue, o.starts_at,
          (
            SELECT jsonb_agg(DISTINCT jsonb_build_object('name', le->>'name', 'genres', COALESCE(to_jsonb(ar.genres), '[]'::jsonb)))
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(o.lineup) = 'array' THEN o.lineup ELSE '[]'::jsonb END) le
            LEFT JOIN artists ar ON ar.id = le->>'artistId'
          ) AS acts
        FROM ${source} a
        JOIN occurrences o ON o.starts_at > NOW() AND o.status <> 'cancelled'
        JOIN events e ON e.id = o.event_id AND e.published
        JOIN venues v ON v.id = COALESCE(o.venue_id, e.venue_id) AND v.published
        WHERE ${ALERT_MATCH}
        ORDER BY e.id, o.starts_at
      `);
      const rows = res.rows
        .sort((x, y) => new Date(x.starts_at).getTime() - new Date(y.starts_at).getTime())
        .slice(0, args.limit ?? 150);
      if (rows.length === 0) return text('Niets gevonden binnen deze filters.');
      // Eén regel per event: de line-up als die er is, anders de titel (bij
      // concerten is dat meestal de act).
      const lines = rows.map((r) => {
        const acts = r.acts?.length
          ? r.acts.map((a) => (a.genres.length ? `${a.name} (${a.genres.slice(0, 4).join(', ')})` : a.name)).join('; ')
          : r.title;
        return `- ${acts} — ${link(r.id, r.title)}, ${r.venue}, ${dayFmt.format(new Date(r.starts_at))}`;
      });
      return text(`${rows.length} events:\n${lines.join('\n')}`);
    }
  );
}
