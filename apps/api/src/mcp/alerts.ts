/**
 * MCP-tools voor meldingsregels: `create_alert`, `list_alerts`, `delete_alert`,
 * `update_alert` en `alert_hits` (wat een melding recent vond).
 *
 * De vertaling van gewone taal naar een regel doet het model van de client
 * (Claude, ChatGPT); wij nemen alleen gestructureerde velden aan en matchen
 * zonder eigen model. Smaak ("zoals Afghan Whigs") wordt genres, verwante
 * artiesten en trefwoorden. Genres komen uit de
 * vaste lijst, venues en artiesten op naam — die zoeken wij op, zodat een
 * typfout of dubbelzinnige naam terugkomt als vraag in plaats van als een
 * regel die nooit iets vindt.
 *
 * Bevestigen zit in de tool zelf: zonder `confirm: true` slaat `create_alert`
 * niets op en geeft hij de samenvatting plus wat er nú al zou passen. Pas
 * na een ja van de gebruiker volgt de tweede aanroep.
 */
import { randomUUID } from 'node:crypto';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { GENRES, GENRE_KEYS, type GenreKey } from '../alerts/genres.js';
import { previewAlert, type AlertFilters } from '../alerts/match.js';
import { describeAlert as describe } from '../alerts/service.js';
import { db, schema } from '../db/index.js';
import { parseAmsterdamLocal } from '../scrapers/_amsterdam-tz.js';
import { CATEGORY_VALUES, PUBLIC_BASE_URL } from './events.js';

const CITY_VALUES = schema.city.enumValues;
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

type ToolText = { content: { type: 'text'; text: string }[]; isError?: boolean };
const text = (t: string, isError = false): ToolText => ({
  content: [{ type: 'text' as const, text: t }],
  ...(isError ? { isError: true } : {}),
});

/** Venues op naam: exact eerst, anders een unieke deeltreffer. Geen of
    meerdere treffers → een vraag terug met kandidaten. */
export async function resolveVenues(
  names: string[]
): Promise<{ ids: string[]; names: string[] } | { error: string }> {
  const ids: string[] = [];
  const found: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    const exact = await db
      .select({ id: schema.venues.id, name: schema.venues.name })
      .from(schema.venues)
      .where(and(eq(schema.venues.published, true), sql`lower(${schema.venues.name}) = lower(${name})`));
    const hits = exact.length > 0
      ? exact
      : await db
          .select({ id: schema.venues.id, name: schema.venues.name })
          .from(schema.venues)
          .where(and(eq(schema.venues.published, true), sql`${schema.venues.name} ILIKE ${'%' + name + '%'}`))
          .limit(9);
    if (hits.length === 1) {
      ids.push(hits[0].id);
      found.push(hits[0].name);
    } else if (hits.length === 0) {
      return { error: `Venue "${name}" ken ik niet. Vraag de gebruiker hoe de zaal precies heet.` };
    } else {
      return {
        error: `"${name}" is niet eenduidig: ${hits.map((h) => h.name).join(', ')}. Vraag welke bedoeld wordt.`,
      };
    }
  }
  return { ids, names: found };
}

/** Artiesten blijven namen. Kennen we ze, dan nemen we onze spelling over;
    zo niet, dan zoeken we op de naam zoals gegeven. */
async function resolveArtists(names: string[]): Promise<{ names: string[]; unknown: string[] }> {
  const out: string[] = [];
  const unknown: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    const [hit] = await db
      .select({ name: schema.artists.name })
      .from(schema.artists)
      .where(sql`lower(${schema.artists.name}) = lower(${name})`)
      .limit(1);
    out.push(hit?.name ?? name);
    if (!hit) unknown.push(name);
  }
  return { names: out, unknown };
}

const dayFmt = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', day: 'numeric', month: 'long' });
/** Een dag loopt van 06:00 tot 06:00: de clubnacht van 31 oktober die om
    01:00 begint hoort nog bij oktober, net als overal in de app. */
function dayStart(d: string): Date {
  return parseAmsterdamLocal(`${d}T06:00:00`);
}
function dayAfter(d: string): string {
  return new Date(new Date(`${d}T12:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
}

/** Breder dan dit in de komende maanden is eerder een feed dan een melding. */
const BROAD_RULE = 60;


const eventLink = (id: string, title: string) =>
  `[${title.replace(/[[\]]/g, '')}](${PUBLIC_BASE_URL}/e/${id})`;

export function registerAlertTools(server: McpServer, userId: string): void {
  server.registerTool(
    'create_alert',
    {
      title: 'Melding instellen',
      description:
        'Stel een melding in: de gebruiker krijgt een push (om 10:00, gebundeld) zodra er in Andreas ' +
        'NIEUW aanbod bijkomt dat past, ongeacht wanneer het speelt: een show die nu wordt aangekondigd ' +
        'voor mei volgend jaar telt ook. Laat `from`/`to` dus weg, tenzij de gebruiker expliciet de ' +
        'speeldatum wil beperken ("alleen als het in december speelt"); reken zo\'n periode dan om naar ' +
        'absolute datums. Vraagt de gebruiker wat er nu al is ("wat is er deze maand?"), gebruik dan ' +
        '`search_events` en geen melding. Geef minstens ' +
        'één van `genres`, `artists` of `venues`. ' +
        'Smaak in eigen woorden ("gitaarbands met een jaren-90-randje, zoals Afghan Whigs") vertaal je zelf naar ' +
        'velden; er draait geen model aan onze kant. Een event past als het een van de `artists` heeft, óf als ' +
        'het een van de `genres` heeft én een van de `keywords` in titel of beschrijving (ontbreekt een van die ' +
        'twee, dan telt alleen de ander). Gebruik je kennis: zet de genoemde artiesten én 5 tot 15 verwante ' +
        'artiesten in `artists`, de passende genres in `genres`, en woorden die in aankondigingen staan in ' +
        '`keywords` ("90s", "grunge", "shoegaze"). Genres zonder trefwoord kunnen breed zijn; geef dan een grens ' +
        '(`venues`, `cities` of `categories`). Past geen genre uit de lijst, zeg dat dan eerlijk in plaats van het ' +
        'dichtstbijzijnde te kiezen. Roep eerst aan ZONDER `confirm`: je krijgt dan ' +
        'een samenvatting en wat er nu al past. Leg die voor aan de gebruiker ("Klopt dat?") en roep ' +
        'pas na een ja opnieuw aan met dezelfde velden en `confirm: true`.',
      inputSchema: {
        genres: z
          .array(z.enum(GENRE_KEYS))
          .optional()
          .describe(
            'Vaste genres (OF). ' + GENRE_KEYS.map((k) => `${k} = ${GENRES[k].label}`).join('; ') +
              '. Kinder- en workshopaanbod valt standaard buiten een regel, tenzij je familie/workshop kiest.'
          ),
        artists: z
          .array(z.string().min(2))
          .optional()
          .describe('Artiestnamen (OF): de genoemde en verwante artiesten. Een artiest past los van genres en trefwoorden.'),
        keywords: z
          .array(z.string().min(2).max(40))
          .max(10)
          .optional()
          .describe('Hele woorden in titel of beschrijving (OF), bv. "90s", "grunge". Samen met genres: beide moeten passen.'),
        venues: z.array(z.string().min(2)).optional().describe('Zaalnamen (OF), bv. "Paradiso".'),
        cities: z.array(z.enum(CITY_VALUES)).optional().describe('Steden (OF).'),
        categories: z.array(z.enum(CATEGORY_VALUES)).optional().describe('Categorieën (OF).'),
        from: DATE.optional().describe('Alleen events die op of na deze dag (YYYY-MM-DD) spelen. Meestal weglaten.'),
        to: DATE.optional().describe('Alleen events die uiterlijk op deze dag (YYYY-MM-DD) spelen; daarna verloopt de regel. Meestal weglaten.'),
        priceMaxEuro: z.number().min(0).optional().describe('Maximale prijs in euro. Onbekende prijs telt als passend.'),
        confirm: z.boolean().optional().describe('Pas op true zetten nadat de gebruiker de samenvatting heeft bevestigd.'),
      },
    },
    async (args) => {
      if (!args.genres?.length && !args.artists?.length && !args.keywords?.length && !args.venues?.length) {
        return text('Een melding heeft minstens een genre, artiest, trefwoord of venue nodig; anders wordt het een stroom pushes.', true);
      }
      const today = new Date().toISOString().slice(0, 10);
      if (args.to && args.to < today) return text(`De einddatum ${args.to} ligt al achter ons.`, true);
      if (args.from && args.to && args.to < args.from) return text('`to` ligt vóór `from`.', true);

      const venues = args.venues?.length ? await resolveVenues(args.venues) : { ids: [], names: [] };
      if ('error' in venues) return text(venues.error, true);
      const artists = args.artists?.length ? await resolveArtists(args.artists) : { names: [], unknown: [] };

      const filters: AlertFilters = {
        userId,
        venueIds: venues.ids.length ? venues.ids : null,
        cities: args.cities?.length ? args.cities : null,
        categories: args.categories?.length ? args.categories : null,
        genres: args.genres?.length ? args.genres : null,
        artistNames: artists.names.length ? artists.names : null,
        keywords: args.keywords?.length ? args.keywords.map((k) => k.trim()) : null,
        priceMaxCents: args.priceMaxEuro != null ? Math.round(args.priceMaxEuro * 100) : null,
        startsFrom: args.from ? dayStart(args.from) : null,
        startsUntil: args.to ? dayStart(dayAfter(args.to)) : null,
      };
      const label = describe({
        genres: args.genres,
        keywords: filters.keywords ?? undefined,
        artists: artists.names,
        venues: venues.names,
        cities: args.cities,
        categories: args.categories,
        from: args.from,
        to: args.to,
        priceMaxEuro: args.priceMaxEuro,
      });

      if (args.confirm) {
        const id = randomUUID();
        await db.insert(schema.alerts).values({
          id,
          userId,
          label,
          venueIds: filters.venueIds,
          cities: filters.cities as (typeof CITY_VALUES)[number][] | null,
          categories: filters.categories as (typeof CATEGORY_VALUES)[number][] | null,
          genres: filters.genres,
          artistNames: filters.artistNames,
          keywords: filters.keywords,
          priceMaxCents: filters.priceMaxCents,
          startsFrom: filters.startsFrom,
          startsUntil: filters.startsUntil,
        });
        return text(
          `Opgeslagen: ${label}.\nDe gebruiker krijgt om 10:00 een push zodra er nieuw aanbod bijkomt dat past. ` +
            `Id: ${id} (voor delete_alert).`
        );
      }

      const lines = [`Voorstel, nog NIET opgeslagen. Melding bij nieuw aanbod: ${label}.`];
      const { total, events } = await previewAlert(filters);
      if (artists.unknown.length) {
        lines.push(
          `${artists.unknown.join(', ')} speelde nog niet eerder bij ons; ik zoek op die naam in titels en line-ups.`
        );
      }
      if (total === 0) {
        lines.push('Er staat nu niets dat past. Prima: dan hoort de gebruiker het zodra er iets komt.');
      } else {
        lines.push(`Nu al passend: ${total} events. Daarover komt géén melding, alleen over wat er vanaf nu bijkomt. De eerste:`);
        for (const e of events) {
          const day = dayFmt.format(e.startsAt);
          lines.push(`- ${eventLink(e.id, e.title)} — ${e.venue}, ${day}`);
        }
        if (total > BROAD_RULE) {
          lines.push(`Let op: dit is een brede regel. Stel voor om een venue, stad of periode toe te voegen.`);
        }
      }
      lines.push('Vraag de gebruiker of dit klopt. Zo ja: roep create_alert opnieuw aan met dezelfde velden en confirm: true.');
      return text(lines.join('\n'));
    }
  );

  server.registerTool(
    'list_alerts',
    {
      title: 'Mijn meldingen',
      description: 'Toon de meldingsregels van de gebruiker, met id (nodig voor delete_alert).',
      inputSchema: {},
    },
    async () => {
      const rows = await db
        .select()
        .from(schema.alerts)
        .where(eq(schema.alerts.userId, userId))
        .orderBy(desc(schema.alerts.createdAt));
      if (rows.length === 0) return text('Nog geen meldingen ingesteld.');
      const now = Date.now();
      return text(
        rows
          .map((r) => {
            const state = !r.active
              ? ' (uit)'
              : r.startsUntil && r.startsUntil.getTime() < now
                ? ' (verlopen)'
                : '';
            return `- ${r.label}${state} — id ${r.id}`;
          })
          .join('\n')
      );
    }
  );

  server.registerTool(
    'delete_alert',
    {
      title: 'Melding verwijderen',
      description: 'Verwijder een meldingsregel van de gebruiker. Haal het id op met list_alerts.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const [gone] = await db
        .delete(schema.alerts)
        .where(and(eq(schema.alerts.id, id), eq(schema.alerts.userId, userId)))
        .returning({ label: schema.alerts.label });
      return gone ? text(`Verwijderd: ${gone.label}.`) : text('Die melding bestaat niet (meer).', true);
    }
  );

  server.registerTool(
    'update_alert',
    {
      title: 'Melding aanpassen',
      description:
        'Zet een melding aan of uit (`active`). Om te veranderen wat hij zoekt: maak een nieuwe met ' +
        'create_alert en verwijder de oude. Haal het id op met list_alerts.',
      inputSchema: {
        id: z.string(),
        active: z.boolean(),
      },
    },
    async ({ id, active }) => {
      const [row] = await db
        .update(schema.alerts)
        .set({ active })
        .where(and(eq(schema.alerts.id, id), eq(schema.alerts.userId, userId)))
        .returning({ label: schema.alerts.label, taste: schema.alerts.taste });
      if (!row) return text('Die melding bestaat niet (meer).', true);
      return text(
        `${row.label}: ${active ? 'aan' : 'uit'}.` +
          (row.taste ? ' Let op: dit is een oude smaakmelding die niets meer doet. Stel hem opnieuw in met create_alert.' : '')
      );
    }
  );

  server.registerTool(
    'alert_hits',
    {
      title: 'Wat vonden mijn meldingen',
      description:
        'Per melding van de gebruiker: wat er recent is klaargezet of als push verstuurd. Gebruik dit om te ' +
        'vinden over welke push de gebruiker het heeft. Klopt een melding niet, stel dan een scherpere voor ' +
        '(andere genres, artiesten of trefwoorden) met create_alert en verwijder de oude.',
      inputSchema: {
        alert_id: z.string().optional().describe('Alleen deze melding. Default: allemaal.'),
        days: z.number().int().min(1).max(60).optional().describe('Hoeveel dagen terug. Default 14.'),
      },
    },
    async ({ alert_id, days = 14 }) => {
      const onlyAlert = alert_id ? sql`AND a.id = ${alert_id}` : sql``;
      const rows = await db.execute<{ alert_id: string; label: string; event_id: string; title: string; venue: string; sent: boolean }>(sql`
        SELECT DISTINCT ON (a.id, o.event_id) a.id AS alert_id, a.label, o.event_id, e.title, v.name AS venue,
               r.sent_at IS NOT NULL AS sent
        FROM reminders r
        JOIN alerts a ON a.id = r.alert_id AND a.user_id = ${userId}
        JOIN occurrences o ON o.id = r.occurrence_id
        JOIN events e ON e.id = o.event_id
        JOIN venues v ON v.id = COALESCE(o.venue_id, e.venue_id)
        WHERE r.created_at > NOW() - make_interval(days => ${days}) ${onlyAlert}
        ORDER BY a.id, o.event_id
      `);
      if (rows.rows.length === 0) return text(`Nog niets gemeld in de afgelopen ${days} dagen.`);
      const byAlert = new Map<string, { label: string; lines: string[] }>();
      for (const r of rows.rows) {
        if (!byAlert.has(r.alert_id)) byAlert.set(r.alert_id, { label: r.label, lines: [] });
        byAlert.get(r.alert_id)!.lines.push(
          `- ${r.sent ? 'GEMELD' : 'klaargezet'} ${eventLink(r.event_id, r.title)} — ${r.venue}`
        );
      }
      return text(
        [...byAlert.entries()].map(([id, g]) => `${g.label} (id ${id})\n${g.lines.join('\n')}`).join('\n\n')
      );
    }
  );
}
