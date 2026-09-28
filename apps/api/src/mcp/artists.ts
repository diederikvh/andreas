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

import { GENRE_KEYS, genresOf, type GenreKey } from '../alerts/genres.js';
import { ALERT_MATCH, GENRE_ALIAS_CTE, alertSource, titleHasName, titleTributeOf } from '../alerts/match.js';
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
const shortDay = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', day: 'numeric', month: 'short', year: '2-digit' });
const link = (id: string, title: string) => `[${title.replace(/[[\]]/g, '')}](${PUBLIC_BASE_URL}/e/${id})`;

/** Gevolgde artiesten met hun komende avonden (tot vijf), in alle steden.
    Zelfde herkenning als de melding: in de line-up, of de naam in de titel. */
async function followedWithNextShow(userId: string, names?: string[]) {
  const filter = names?.length
    ? sql`AND lower(ar.name) IN (${sql.join(names.map((n) => sql`lower(${n})`), sql`, `)})`
    : sql``;
  const res = await db.execute<{ name: string; shows: Show[] | null }>(sql`
    SELECT ar.name, nx.shows
    FROM artist_follows f
    JOIN artists ar ON ar.id = f.artist_id
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(s ORDER BY s.starts_at) AS shows FROM (
      SELECT DISTINCT ON (e.id) e.id AS event_id, e.title, v.name AS venue, v.city::text AS city, o.starts_at,
        ${sql.raw(titleTributeOf('ar.name'))} AS tribute
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
      ORDER BY e.id, o.starts_at
      ) s
    ) nx ON TRUE
    WHERE f.user_id = ${userId} ${filter}
    ORDER BY lower(ar.name)
  `);
  return res.rows;
}

type Show = { event_id: string; title: string; venue: string; city: string; starts_at: string; tribute: boolean };

const cityName = (c: string) => c.split('-').map((p) => p[0].toUpperCase() + p.slice(1)).join(' ');

function showLine(r: { name: string; shows: Show[] | null }) {
  const shows = (r.shows ?? []).slice(0, 5);
  if (shows.length === 0) return `- ${r.name} — nog niets aangekondigd`;
  const more = (r.shows?.length ?? 0) - shows.length;
  return (
    `- ${r.name}:\n` +
    shows
      .map((s) => `    ${s.tribute ? '(tribute) ' : ''}${link(s.event_id, s.title)} — ${s.venue} (${cityName(s.city)}), ${dayFmt.format(new Date(s.starts_at))}`)
      .join('\n') +
    (more > 0 ? `\n    …en nog ${more}` : '')
  );
}

export function registerArtistTools(server: McpServer, userId: string): void {
  server.registerTool(
    'list_followed_artists',
    {
      title: 'Artiesten die ik volg',
      description:
        'De artiesten die de gebruiker volgt, met hun komende avonden in alle steden. Volgen = een push ' +
        'om 10:00 zodra er een nieuwe avond met die artiest bijkomt, waar dan ook.',
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
        'Acts met komende avonden in Andreas, één regel per event: act(s) met hun genres, datum, zaal en ' +
        'event-id. Bedoeld om artiesten voor te stellen. Wie de gebruiker al volgt, laten we standaard weg ' +
        '(exclude_followed). similar_to_followed houdt alleen acts over die een genre delen met wie de ' +
        'gebruiker volgt; kies daaruit met je eigen muziekkennis. Staat er onderaan een cursor, dan is er ' +
        'meer: vraag dezelfde filters op met die cursor. Wees kritisch; noem alleen acts die hier staan.',
      inputSchema: {
        venues: z.array(z.string().min(2)).optional(),
        cities: z.array(z.enum(schema.city.enumValues)).optional(),
        categories: z.array(z.enum(CATEGORY_VALUES)).optional().describe('Default: Muziek.'),
        genres: z.array(z.enum(GENRE_KEYS)).optional().describe('Ruwe voorselectie; de labels zijn grof.'),
        from: DATE.optional(),
        to: DATE.optional(),
        exclude_followed: z.boolean().optional().describe('Acts die de gebruiker al volgt weglaten. Default: true.'),
        similar_to_followed: z
          .boolean()
          .optional()
          .describe('Alleen acts met een genre dat ook bij gevolgde artiesten voorkomt. Default: false.'),
        limit: z.number().int().min(1).max(300).optional().describe('Aantal events per pagina, default 150.'),
        cursor: z.string().optional().describe('Van de vorige pagina, om verder te lezen.'),
      },
    },
    async (args) => {
      const venues = args.venues?.length ? await resolveVenues(args.venues) : { ids: [], names: [] };
      if ('error' in venues) return text(venues.error, true);
      const source = alertSource({
        userId,
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
      // Wie je volgt, en welke genres die hebben (de eerste twee labels,
      // net als bij de meldingen).
      const followed = await db.execute<{ name: string; genres: string[] | null }>(sql`
        SELECT ar.name, ar.genres[1:2] AS genres FROM artist_follows f
        JOIN artists ar ON ar.id = f.artist_id WHERE f.user_id = ${userId}`);
      const followedNames = new Set(followed.rows.map((r) => r.name.toLowerCase()));
      const followedKeys = new Set(followed.rows.flatMap((r) => genresOf('Muziek', r.genres ?? [])));
      const keysOf = (tags: string[]) => genresOf('Muziek', tags.slice(0, 2));
      const wanted = new Set<GenreKey>(args.genres ?? []);

      const kept = res.rows
        .map((r) => {
          let acts = r.acts ?? [];
          if (args.exclude_followed ?? true) acts = acts.filter((a) => !followedNames.has(a.name.toLowerCase()));
          if (args.similar_to_followed) acts = acts.filter((a) => keysOf(a.genres).some((k) => followedKeys.has(k)));
          return { ...r, acts, hadLineup: (r.acts?.length ?? 0) > 0 };
        })
        .filter((r) => {
          // Zonder line-up is de titel de act. Die kunnen we niet op smaak
          // toetsen, dus bij similar_to_followed valt hij af.
          if (r.acts.length === 0) {
            return !r.hadLineup && !args.similar_to_followed && !followedNames.has(r.title.toLowerCase());
          }
          // Scherper op genre: kennen we de genres van een act, dan moet
          // die zelf passen. Het zaallabel alleen is te grof ("folk" bij
          // een kinderconcert).
          if (!wanted.size) return true;
          const known = r.acts.filter((a) => a.genres.length > 0);
          return known.length === 0 || known.some((a) => keysOf(a.genres).some((k) => wanted.has(k)));
        })
        .sort((x, y) => new Date(x.starts_at).getTime() - new Date(y.starts_at).getTime());

      const offset = Number(args.cursor ?? 0) || 0;
      const limit = args.limit ?? 150;
      const rows = kept.slice(offset, offset + limit);
      if (rows.length === 0) return text(offset ? 'Geen verdere resultaten.' : 'Niets gevonden binnen deze filters.');
      // Eén regel per event, kort: hooguit drie acts met twee genres elk.
      const lines = rows.map((r) => {
        const acts = r.acts.length
          ? r.acts
              .slice(0, 3)
              .map((a) => (a.genres.length ? `${a.name} (${a.genres.slice(0, 2).join(', ')})` : a.name))
              .join('; ') + (r.acts.length > 3 ? ` +${r.acts.length - 3}` : '')
          : r.title;
        return `- ${acts} — ${shortDay.format(new Date(r.starts_at))}, ${r.venue} [${r.id}]`;
      });
      const next = offset + rows.length < kept.length ? `\nMeer: cursor "${offset + rows.length}" (nog ${kept.length - offset - rows.length}).` : '';
      return text(`${offset + 1}–${offset + rows.length} van ${kept.length} events:\n${lines.join('\n')}${next}`);
    }
  );
}
