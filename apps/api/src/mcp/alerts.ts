/**
 * MCP-tools voor meldingsregels: `create_alert`, `list_alerts`, `delete_alert`.
 *
 * De vertaling van gewone taal naar een regel doet het model van de client
 * (Claude); wij nemen alleen gestructureerde velden aan. Genres komen uit de
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
import { judgeMany, loadEventInfo } from '../alerts/judge.js';
import { previewAlert, recentCandidates, type AlertFilters } from '../alerts/match.js';
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
const dateLabel = (d: string) => dayFmt.format(new Date(`${d}T12:00:00Z`));
const cityLabel = (c: string) => c.split('-').map((p) => p[0].toUpperCase() + p.slice(1)).join(' ');

function describe(p: {
  taste?: string;
  genres?: GenreKey[];
  artists?: string[];
  venues?: string[];
  cities?: string[];
  categories?: string[];
  from?: string;
  to?: string;
  priceMaxEuro?: number;
}): string {
  const parts: string[] = [];
  if (p.taste) parts.push(`smaak: "${p.taste}"`);
  if (p.genres?.length) parts.push(p.genres.map((g) => GENRES[g].label).join(' of '));
  if (p.categories?.length) parts.push(p.categories.map((c) => c.toLowerCase()).join(' of '));
  if (p.artists?.length) parts.push(p.artists.join(' of '));
  if (p.venues?.length) parts.push(`bij ${p.venues.join(' of ')}`);
  if (p.cities?.length) parts.push(`in ${p.cities.map(cityLabel).join(' of ')}`);
  if (p.from && p.to) parts.push(`${dateLabel(p.from)} t/m ${dateLabel(p.to)}`);
  else if (p.from) parts.push(`vanaf ${dateLabel(p.from)}`);
  else if (p.to) parts.push(`t/m ${dateLabel(p.to)}`);
  if (p.priceMaxEuro != null) parts.push(`tot €${p.priceMaxEuro}`);
  return parts.join(' · ');
}

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

/** Hoeveel recente kandidaten de preview van een smaakregel laat keuren. */
const TASTE_SAMPLE = 25;

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
        'Gaat het om smaak die niet in een genre past ("gitaarbands met een jaren-90-randje, zoals ' +
        'Afghan Whigs"), zet die dan in `taste`, in de woorden van de gebruiker en met de genoemde ' +
        'voorbeeldartiesten; laat `genres` dan meestal weg. Elk nieuw event binnen de harde filters ' +
        '(`venues`, `cities`, `categories`, minstens één daarvan) wordt dan door een model gekeurd tegen ' +
        'die smaak, en de reden komt in de push. Past geen genre uit de lijst en is er geen smaak, zeg ' +
        'dat dan eerlijk in plaats van het dichtstbijzijnde te kiezen. Roep eerst aan ZONDER `confirm`: je krijgt dan ' +
        'een samenvatting en wat er nu al past. Leg die voor aan de gebruiker ("Klopt dat?") en roep ' +
        'pas na een ja opnieuw aan met dezelfde velden en `confirm: true`.',
      inputSchema: {
        taste: z
          .string()
          .min(3)
          .max(500)
          .optional()
          .describe('Smaak in de woorden van de gebruiker, met voorbeeldartiesten. Wordt per nieuw event gekeurd.'),
        genres: z
          .array(z.enum(GENRE_KEYS))
          .optional()
          .describe(
            'Vaste genres (OF). ' + GENRE_KEYS.map((k) => `${k} = ${GENRES[k].label}`).join('; ') +
              '. Kinder- en workshopaanbod valt standaard buiten een regel, tenzij je familie/workshop kiest.'
          ),
        artists: z.array(z.string().min(2)).optional().describe('Artiestnamen (OF), zoals de gebruiker ze noemt.'),
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
      if (args.taste) {
        if (!args.venues?.length && !args.cities?.length && !args.categories?.length) {
          return text('Een smaakmelding heeft een grens nodig: een venue, stad of categorie (bv. Muziek).', true);
        }
      } else if (!args.genres?.length && !args.artists?.length && !args.venues?.length) {
        return text('Een melding heeft minstens een genre, artiest of venue nodig; anders wordt het een stroom pushes.', true);
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
        priceMaxCents: args.priceMaxEuro != null ? Math.round(args.priceMaxEuro * 100) : null,
        startsFrom: args.from ? dayStart(args.from) : null,
        startsUntil: args.to ? dayStart(dayAfter(args.to)) : null,
      };
      const taste = args.taste?.trim() || null;
      const label = describe({
        taste: taste ?? undefined,
        genres: args.genres,
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
          priceMaxCents: filters.priceMaxCents,
          startsFrom: filters.startsFrom,
          startsUntil: filters.startsUntil,
          taste,
        });
        return text(
          `Opgeslagen: ${label}.\nDe gebruiker krijgt om 10:00 een push zodra er nieuw aanbod bijkomt dat past. ` +
            `Id: ${id} (voor delete_alert).`
        );
      }

      const lines = [`Voorstel, nog NIET opgeslagen. Melding bij nieuw aanbod: ${label}.`];
      if (taste) {
        // Voorproeven op wat er het laatst binnenkwam: zo ziet de gebruiker
        // hoe de keurder de smaak opvat, met de redenen erbij.
        const ids = await recentCandidates(filters, TASTE_SAMPLE);
        const info = await loadEventInfo(ids);
        const verdicts = await judgeMany(taste, [...info.values()]);
        const yes = ids.filter((id) => verdicts.get(id)?.match);
        const no = ids.filter((id) => verdicts.get(id) && !verdicts.get(id)!.match);
        lines.push(
          `Proef op de ${ids.length} laatst toegevoegde events binnen de grenzen: ${yes.length} zou ik melden. ` +
            'Over wat er al staat komt géén melding; dit laat zien hoe ik de smaak opvat.'
        );
        for (const id of yes) {
          lines.push(`- JA ${eventLink(id, info.get(id)!.title)} — ${info.get(id)!.venue}: ${verdicts.get(id)!.reason}`);
        }
        for (const id of no.slice(0, 4)) {
          lines.push(`- nee ${eventLink(id, info.get(id)!.title)}: ${verdicts.get(id)!.reason}`);
        }
        lines.push('Vraag de gebruiker of dit klopt, of de smaak scherper moet. Zo ja: roep create_alert opnieuw aan met dezelfde velden en confirm: true.');
        return text(lines.join('\n'));
      }
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
}
