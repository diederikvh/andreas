/**
 * Zoeklaag voor de MCP-server. Hergebruikt exact dezelfde deterministische
 * retrieval als de in-app gids (`apps/api/src/zoek/`) — tijd-venster,
 * categorie-hardfilter, genre/trefwoord-ranking — en levert compacte,
 * client-vriendelijke event-objecten terug.
 *
 * De klant z'n eigen AI voert het gesprek; deze laag is puur "wat is er
 * écht" + een deeplink terug naar Andreas.
 */
import { randomUUID } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import {
  findEventsWithOccurrencesInRange,
  headOccurrenceInWindow,
} from '../routes/_helpers.js';
import { gatherCandidates } from '../zoek/retrieval.js';
import { EMPTY_PROFILE } from '../zoek/types.js';
import type { PreferenceProfile, PriceTier, ZoekWhen } from '../zoek/types.js';

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? 'https://andreas.amsterdam';

/** Tijd-vensters die de tool accepteert (geen `specific` in v1). */
export const WHEN_VALUES = [
  'tonight',
  'this_weekend',
  'this_week',
  'this_month',
  'this_year',
  'next_weekend',
  'next_week',
  'next_month',
] as const;

export const CATEGORY_VALUES = [
  'Muziek',
  'Film',
  'Theater',
  'Kunst',
  'Lezing',
  'Literatuur',
] as const;

/** Compacte event-vorm voor MCP-clients. */
export type McpEvent = {
  id: string;
  title: string;
  category: string;
  genres: string[];
  venue: string;
  wijk: string | null;
  start: string; // ISO 8601
  end: string | null;
  priceCents: number | null;
  ticketUrl: string | null;
  imageUrl: string | null;
  /** Publieke event-pagina op Andreas (deeplink terug). */
  url: string;
};

export type SearchEventsArgs = {
  query?: string;
  when?: ZoekWhen;
  category?: (typeof CATEGORY_VALUES)[number];
  /** 0–3; gevalideerd door het tool-schema, hier als number aangenomen. */
  priceMax?: number;
  limit?: number;
};

export type SearchEventsResult = {
  events: McpEvent[];
  /** Periode waarop is gezocht (het opgeloste venster). */
  window: { from: string; to: string; when: ZoekWhen };
};

/**
 * Zoek events. Categorie (expliciet óf afgeleid uit `query`) is een harde
 * filter; genre/eigennaam uit `query` sorteert binnen die categorie.
 */
export async function searchEvents(args: SearchEventsArgs): Promise<SearchEventsResult> {
  const now = new Date();
  const explicitWhen = args.when != null;
  const limit = Math.min(Math.max(args.limit ?? 8, 1), 25);
  const query = (args.query ?? '').trim();

  const profile: PreferenceProfile = {
    ...EMPTY_PROFILE,
    // Alleen relevant op het expliciete-tijd-pad; bij browse stuurt
    // gatherCandidates de venster-ladder zelf.
    when: args.when ?? 'this_week',
    priceMax: (args.priceMax ?? null) as PriceTier | null,
  };

  // Gecentraliseerde verzameling: expliciete tijd hard, eigennaam → heel jaar,
  // genre/sfeer → progressief verbreden vanuit een kort venster.
  const { candidates, window, when } = await gatherCandidates(profile, now, {
    message: query,
    explicitCategories: args.category ? [args.category] : undefined,
    hasExplicitTime: explicitWhen,
  });
  const ids = candidates.slice(0, limit).map((c) => c.id);

  const events = await hydrate(ids, window);
  return {
    events,
    window: { from: window.from.toISOString(), to: window.to.toISOString(), when },
  };
}

/**
 * Log een MCP-zoekopdracht van een ingelogde gebruiker (OAuth) — zelfde
 * `zoek_logs`-tabel als de in-app gids, zodat MCP-zoekgedrag ook het
 * smaakprofiel in "Voor jou" voedt (en de cap/§10-telling). Niet-blokkerend.
 */
export async function logMcpSearch(
  userId: string,
  args: SearchEventsArgs,
  events: McpEvent[]
): Promise<void> {
  try {
    const tokens = (args.query ?? '')
      .toLowerCase()
      .split(/[^a-z0-9à-ÿ]+/)
      .filter((tok) => tok.length >= 3);
    await db.insert(schema.zoekLogs).values({
      id: randomUUID(),
      userId,
      message: args.query?.trim() || `(mcp:${args.category ?? args.when ?? 'all'})`,
      profile: {
        want: tokens,
        avoid: [],
        when: args.when ?? 'this_week',
        category: args.category ?? null,
      },
      shownEventIds: events.map((e) => e.id),
    });
  } catch (e) {
    console.warn('[mcp] kon zoekopdracht niet loggen:', (e as Error).message);
  }
}

async function hydrate(
  ids: string[],
  window: { from: Date; to: Date }
): Promise<McpEvent[]> {
  if (ids.length === 0) return [];

  const rows = await db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      category: schema.events.category,
      genres: schema.events.genres,
      imageUrl: schema.events.imageUrl,
      posterUrl: schema.events.posterUrl,
      venueName: schema.venues.name,
      venueImage: schema.venues.imageUrl,
      wijk: schema.venues.wijk,
    })
    .from(schema.events)
    .innerJoin(schema.venues, eq(schema.events.venueId, schema.venues.id))
    .where(and(inArray(schema.events.id, ids), eq(schema.events.published, true)));

  const byId = new Map(rows.map((r) => [r.id, r]));
  const { byEvent } = await findEventsWithOccurrencesInRange({
    from: window.from,
    to: window.to,
    eventIds: ids,
  });

  const out: McpEvent[] = [];
  for (const id of ids) {
    const ev = byId.get(id);
    const occ = byEvent.get(id);
    if (!ev || !occ) continue;
    const { head } = headOccurrenceInWindow(occ, window.from, window.to);
    if (!head) continue;
    out.push({
      id: ev.id,
      title: ev.title,
      category: ev.category,
      genres: ev.genres ?? [],
      venue: head.venue?.name ?? ev.venueName,
      wijk: ev.wijk ?? null,
      start: head.startsAt.toISOString(),
      end: head.endsAt ? head.endsAt.toISOString() : null,
      priceCents: head.priceCents ?? null,
      ticketUrl: head.ticketUrl ?? null,
      imageUrl: ev.posterUrl ?? ev.imageUrl ?? ev.venueImage ?? null,
      url: `${PUBLIC_BASE_URL}/e/${ev.id}`,
    });
  }
  return out;
}
