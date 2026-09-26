/**
 * Zoeken op vaste velden: de motor onder `search_events` (MCP) en de gids in
 * de app (`POST /zoek`).
 *
 * Geen model aan onze kant. De vraag is al vertaald naar velden (door de AI
 * van de gebruiker, of één Haiku-vertaling in de app); wij zoeken precies
 * dat, met dezelfde regels als de meldingen (`ALERT_MATCH`): geblokkeerde
 * zalen, niet-leuk-genres, kinder- en workshopaanbod vallen weg. Terug komt
 * rijke data (beschrijving, line-up met de genres van de artiesten) zodat
 * wie het antwoord leest zelf de smaak kan beoordelen.
 */
import { randomUUID } from 'node:crypto';

import { and, eq, inArray, sql } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { GENRES, mainGenresOf, type Category, type GenreKey } from './genres.js';
import { ALERT_MATCH, GENRE_ALIAS_CTE, alertSource } from './match.js';
import { parseAmsterdamLocal } from '../scrapers/_amsterdam-tz.js';

export const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? 'https://andreas.amsterdam';

export type StructuredQuery = {
  from?: Date;
  to?: Date;
  cities?: string[];
  categories?: string[];
  genres?: GenreKey[];
  venueIds?: string[];
  artists?: string[];
  /** Hele woorden in titel of beschrijving ("90s"). */
  keywords?: string[];
  /** Woord uit de titel of een naam in de line-up. */
  text?: string;
  priceMaxCents?: number;
  limit?: number;
};

export type FoundEvent = {
  id: string;
  title: string;
  category: string;
  genres: string[];
  venue: string;
  city: string;
  wijk: string | null;
  start: string;
  end: string | null;
  priceCents: number | null;
  ticketUrl: string | null;
  imageUrl: string | null;
  url: string;
  description: string | null;
  lineup: { name: string; genres: string[] }[];
  /** Waarom het erbij zit, feitelijk: welk veld matchte. */
  why: string;
};

export type StructuredResult = {
  events: FoundEvent[];
  /** Hoeveel events er in totaal passen (vóór `limit`). */
  total: number;
  window: { from: Date; to: Date };
};

const DAY = 86_400_000;

export async function searchStructured(
  userId: string | null,
  q: StructuredQuery
): Promise<StructuredResult> {
  const text = q.text?.trim() || null;
  // Op naam of artiest zoek je "wanneer speelt X", niet "wat is er deze week".
  const byName = Boolean(text || q.artists?.length);
  const from = q.from ?? new Date();
  const to = q.to ?? new Date(from.getTime() + (byName ? 365 : 7) * DAY);
  const limit = Math.min(Math.max(q.limit ?? 15, 1), 50);
  const like = text ? `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;

  const source = alertSource({
    userId,
    venueIds: q.venueIds?.length ? q.venueIds : null,
    cities: q.cities?.length ? q.cities : null,
    categories: q.categories?.length ? q.categories : null,
    genres: q.genres?.length ? q.genres : null,
    artistNames: q.artists?.length ? q.artists : null,
    keywords: q.keywords?.length ? q.keywords : null,
    priceMaxCents: q.priceMaxCents ?? null,
    startsFrom: from,
    startsUntil: to,
  });
  const res = await db.execute<{
    id: string;
    title: string;
    category: Category;
    genres: string[];
    image: string | null;
    venue: string;
    city: string;
    wijk: string | null;
    starts_at: string;
    ends_at: string | null;
    price_cents: number | null;
    ticket_url: string | null;
    lineup_names: string[] | null;
  }>(sql`
    WITH ${GENRE_ALIAS_CTE}
    SELECT DISTINCT ON (e.id) e.id, e.title, e.category::text AS category, e.genres,
      COALESCE(e.poster_url, e.image_url, v.image_url) AS image,
      v.name AS venue, v.city::text AS city, v.wijk,
      o.starts_at, o.ends_at, o.price_cents, o.ticket_url,
      (SELECT array_agg(le->>'name') FROM jsonb_array_elements(
         CASE WHEN jsonb_typeof(o.lineup) = 'array' THEN o.lineup ELSE '[]'::jsonb END) le) AS lineup_names
    FROM ${source} a
    JOIN occurrences o ON o.starts_at > NOW() AND o.status <> 'cancelled'
    JOIN events e ON e.id = o.event_id AND e.published
    JOIN venues v ON v.id = COALESCE(o.venue_id, e.venue_id) AND v.published
    WHERE ${ALERT_MATCH}
      ${like ? sql`AND (e.title ILIKE ${like} OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(o.lineup) = 'array' THEN o.lineup ELSE '[]'::jsonb END) le
        WHERE le->>'name' ILIKE ${like}))` : sql``}
    ORDER BY e.id, o.starts_at
  `);
  const rows = res.rows.sort((x, y) => Date.parse(x.starts_at) - Date.parse(y.starts_at));
  const page = rows.slice(0, limit);
  const info = await loadEventInfo(page.map((r) => r.id));

  const events = page.map((r): FoundEvent => {
    const extra = info.get(r.id);
    return {
      id: r.id,
      title: r.title,
      category: r.category,
      genres: r.genres ?? [],
      venue: r.venue,
      city: r.city,
      wijk: r.wijk,
      start: new Date(r.starts_at).toISOString(),
      end: r.ends_at ? new Date(r.ends_at).toISOString() : null,
      priceCents: r.price_cents,
      ticketUrl: r.ticket_url,
      imageUrl: r.image,
      url: `${PUBLIC_BASE_URL}/e/${r.id}`,
      description: extra?.description?.replace(/\s+/g, ' ').trim().slice(0, 400) || null,
      lineup: extra?.lineup ?? [],
      why: whyOf(r, q, text),
    };
  });
  return { events, total: rows.length, window: { from, to } };
}

/** Welk gevraagd veld dit event binnenhaalde. Alleen feiten, geen smaak. */
function whyOf(
  r: { title: string; category: Category; genres: string[]; venue: string; lineup_names: string[] | null },
  q: StructuredQuery,
  text: string | null
): string {
  const parts: string[] = [];
  const lineup = (r.lineup_names ?? []).map((n) => n.toLowerCase());
  const artists = (q.artists ?? []).filter(
    (a) => lineup.includes(a.toLowerCase()) || r.title.toLowerCase().includes(a.toLowerCase())
  );
  if (artists.length) parts.push(`met ${artists.join(', ')}`);
  if (q.genres?.length) {
    const hit = mainGenresOf(r.category, r.genres ?? []).filter((k) => q.genres!.includes(k));
    if (hit.length) parts.push(hit.map((k) => GENRES[k].label).join(', '));
  }
  if (q.keywords?.length) parts.push(`met ${q.keywords.map((k) => `"${k}"`).join(' of ')}`);
  if (q.venueIds?.length) parts.push(`in ${r.venue}`);
  if (text) parts.push(`"${text}" in titel of line-up`);
  if (parts.length === 0) parts.push([r.category, r.genres?.[0]].filter(Boolean).join(' · '));
  return parts.join(' · ');
}

/** Zaal-ids bij namen, ruimhartig: exacte naam, anders alles wat de naam
    bevat. Onbekende namen vallen stil weg (`unknown`). */
export async function venueIdsByName(names: string[]): Promise<{ ids: string[]; unknown: string[] }> {
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const exact = await db
      .select({ id: schema.venues.id })
      .from(schema.venues)
      .where(and(eq(schema.venues.published, true), sql`lower(${schema.venues.name}) = lower(${name})`));
    const hits = exact.length
      ? exact
      : await db
          .select({ id: schema.venues.id })
          .from(schema.venues)
          .where(and(eq(schema.venues.published, true), sql`${schema.venues.name} ILIKE ${'%' + name + '%'}`))
          .limit(10);
    if (hits.length) ids.push(...hits.map((h) => h.id));
    else unknown.push(name);
  }
  return { ids: [...new Set(ids)], unknown };
}

// ─── Velden zoals een AI ze invult (MCP-tool, Haiku-vertaling in de app) ────

export type SearchEventsArgs = {
  from?: string;
  to?: string;
  cities?: string[];
  categories?: string[];
  genres?: GenreKey[];
  venues?: string[];
  artists?: string[];
  keywords?: string[];
  query?: string;
  priceMaxEuros?: number;
  limit?: number;
};

export type SearchEventsResult = {
  events: FoundEvent[];
  total: number;
  window: { from: string; to: string };
  /** Zaalnamen die we niet kennen. */
  unknownVenues: string[];
};

/** Een dag loopt van 06:00 tot 06:00: de nacht hoort bij de avond ervoor. */
export const dayStart = (date: string) => parseAmsterdamLocal(`${date}T06:00:00`);
export const dayEnd = (date: string) => new Date(dayStart(date).getTime() + 86_400_000);

export async function searchEvents(userId: string | null, args: SearchEventsArgs): Promise<SearchEventsResult> {
  const venues = args.venues?.length ? await venueIdsByName(args.venues) : null;
  if (venues && venues.ids.length === 0) {
    const now = new Date();
    return { events: [], total: 0, window: { from: now.toISOString(), to: now.toISOString() }, unknownVenues: venues.unknown };
  }
  const { events, total, window } = await searchStructured(userId, {
    from: args.from ? dayStart(args.from) : undefined,
    to: args.to ? dayEnd(args.to) : undefined,
    cities: args.cities,
    categories: args.categories,
    genres: args.genres,
    venueIds: venues?.ids,
    artists: args.artists,
    keywords: args.keywords,
    text: args.query,
    priceMaxCents: args.priceMaxEuros != null ? Math.round(args.priceMaxEuros * 100) : undefined,
    limit: args.limit,
  });
  return {
    events,
    total,
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    unknownVenues: venues?.unknown ?? [],
  };
}

/**
 * Log een MCP-zoekopdracht van een ingelogde gebruiker (OAuth) — zelfde
 * `zoek_logs`-tabel als de in-app gids, zodat MCP-zoekgedrag ook het
 * smaakprofiel in "Voor jou" voedt (en de cap/§10-telling). Niet-blokkerend.
 */
export async function logSearch(
  userId: string,
  message: string,
  args: SearchEventsArgs,
  events: FoundEvent[]
): Promise<void> {
  try {
    await db.insert(schema.zoekLogs).values({
      id: randomUUID(),
      userId,
      message,
      profile: {
        // "Voor jou" leest `want` als genre-termen.
        want: [
          ...(args.genres ?? []).map((k) => GENRES[k].label.toLowerCase()),
          ...(args.artists ?? []).map((a) => a.toLowerCase()),
        ],
        avoid: [],
        ...args,
      },
      shownEventIds: events.map((e) => e.id),
    });
  } catch (e) {
    console.warn('[zoek] kon zoekopdracht niet loggen:', (e as Error).message);
  }
}

// ─── Rijke event-data ────────────────────────────────────────────────────────

export type EventInfo = {
  id: string;
  title: string;
  category: string;
  venue: string;
  city: string;
  genres: string[];
  description: string | null;
  startsAt: Date;
  /** Line-up met de genres die we van die artiesten kennen. */
  lineup: { name: string; genres: string[] }[];
};

/** Beschrijving en line-up (met de genres van de artiesten) per event, in
    één query. */
export async function loadEventInfo(eventIds: string[]): Promise<Map<string, EventInfo>> {
  if (eventIds.length === 0) return new Map();
  const res = await db.execute<{
    id: string;
    title: string;
    category: string;
    venue: string;
    city: string;
    genres: string[];
    description: string | null;
    starts_at: string;
    lineup: { name: string; genres: string[] }[] | null;
  }>(sql`
    SELECT e.id, e.title, e.category::text AS category, v.name AS venue, v.city::text AS city,
           e.genres, e.description,
           (SELECT MIN(o.starts_at) FROM occurrences o WHERE o.event_id = e.id AND o.starts_at > NOW()) AS starts_at,
           (
             SELECT jsonb_agg(DISTINCT jsonb_build_object(
               'name', le->>'name',
               'genres', COALESCE(to_jsonb(ar.genres), '[]'::jsonb)
             ))
             FROM occurrences o
             CROSS JOIN LATERAL jsonb_array_elements(
               CASE WHEN jsonb_typeof(o.lineup) = 'array' THEN o.lineup ELSE '[]'::jsonb END
             ) le
             LEFT JOIN artists ar ON ar.id = le->>'artistId'
             WHERE o.event_id = e.id
           ) AS lineup
    FROM events e
    JOIN venues v ON v.id = e.venue_id
    WHERE ${inArray(sql`e.id`, eventIds)}
  `);
  return new Map(
    res.rows.map((r) => [
      r.id,
      {
        id: r.id,
        title: r.title,
        category: r.category,
        venue: r.venue,
        city: r.city,
        genres: r.genres,
        description: r.description,
        startsAt: new Date(r.starts_at),
        lineup: (r.lineup ?? []).slice(0, 12),
      },
    ])
  );
}
