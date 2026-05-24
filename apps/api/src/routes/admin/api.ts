import { randomBytes } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';

import { db, schema } from '../../db/index.js';
import {
  enrichGenresFromAI,
  enrichGenresFromKeywords,
} from '../../scrapers/_genre-enrich.js';
import { enrichLineupArtists } from '../../scrapers/_artists-enrich.js';
import { enrichFilmsFromOmdb } from '../../scrapers/_omdb-enrich.js';
import { enrichFilmsFromTmdb } from '../../scrapers/_tmdb-enrich.js';
import { extractFromUrl } from '../../scrapers/extract-from-url.js';
import { scrapers, type ScraperName } from '../../scrapers/index.js';
import { uploadToBunny } from '../../storage/bunny.js';
import { requireAdminAny } from './auth.js';
import { adminSocial } from './social.js';

/**
 * JSON API voor admin-acties — bedoeld voor n8n-agents en
 * scripts. Auth via cookie (browser) of `Authorization: Bearer
 * <ADMIN_API_KEY>` (server-to-server).
 *
 * Endpoints zijn idempotent waar het kan: id-collisies → 409,
 * onbekende ids → 404, validatie-fouten → 400.
 */

const CATEGORIES = ['Muziek', 'Theater', 'Literatuur', 'Film', 'Kunst', 'Lezing'] as const;
type Category = (typeof CATEGORIES)[number];

const VENUE_TYPES = [
  'galerie',
  'museum',
  'podium',
  'club',
  'film',
  'ruimte',
  'boekhandel-cafe',
] as const;
type VenueType = (typeof VENUE_TYPES)[number];

const DAY_NIGHT = ['day', 'night', 'both'] as const;
type DayNight = (typeof DAY_NIGHT)[number];

const WIJKEN = [
  'centrum',
  'noord',
  'oost',
  'west',
  'zuid',
  'zuidoost',
  'nieuw-west',
  'amstelveen',
  'zaandam',
  'haarlem',
] as const;
type Wijk = (typeof WIJKEN)[number];

const SCENES = ['mainstream', 'alternatief', 'underground', 'fringe'] as const;
type Scene = (typeof SCENES)[number];

const CAPACITIES = ['klein', 'middel', 'groot', 'xl'] as const;
type Capacity = (typeof CAPACITIES)[number];

function parseEnum<T extends string>(
  list: readonly T[],
  value: unknown
): T | null {
  if (typeof value !== 'string') return null;
  return (list as readonly string[]).includes(value) ? (value as T) : null;
}

/** Strip @ en whitespace, returnt alleen de bare handle. */
function normalizeInstagram(value: string): string {
  return value
    .trim()
    .replace(/^@+/, '')
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
    .replace(/\/.*$/, '')
    .trim();
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v) => typeof v === 'string')
    .map((v) => (v as string).trim())
    .filter((v) => v.length > 0);
}

function shortId(): string {
  return randomBytes(5).toString('hex');
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function parseDate(value: unknown): Date | null {
  if (value == null || value === '') return null;
  const d = new Date(String(value));
  return isNaN(d.getTime()) ? null : d;
}

function parseCategoryArr(value: unknown): Category[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is Category =>
    (CATEGORIES as readonly string[]).includes(String(v))
  );
}

function parseCategoryOne(value: unknown, fallback: Category = 'Muziek'): Category {
  return (CATEGORIES as readonly string[]).includes(String(value))
    ? (value as Category)
    : fallback;
}

const EVENT_KINDS = ['show', 'exhibition'] as const;
type EventKind = (typeof EVENT_KINDS)[number];

const OCCURRENCE_STATUSES = ['scheduled', 'cancelled', 'sold_out'] as const;
type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];

const LINEUP_ROLES = ['dj', 'support', 'headliner', 'act'] as const;
type LineupRole = (typeof LINEUP_ROLES)[number];

type LineupEntry = { name: string; role?: LineupRole };

function parseLineup(value: unknown): LineupEntry[] | null {
  if (!Array.isArray(value)) return null;
  const out: LineupEntry[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const name = String((entry as { name?: unknown }).name ?? '').trim();
    if (!name) continue;
    const role = parseEnum(LINEUP_ROLES, (entry as { role?: unknown }).role);
    out.push(role ? { name, role } : { name });
  }
  return out.length > 0 ? out : null;
}

type OccurrenceInput = {
  id?: string;
  startsAt: Date;
  endsAt: Date | null;
  priceCents: number | null;
  priceNote: string | null;
  ticketUrl: string | null;
  room: string | null;
  lineup: LineupEntry[] | null;
  status: OccurrenceStatus;
};

/**
 * Parseer een occurrence-payload uit het admin-form of n8n-call. Returnt
 * `null` als startsAt ontbreekt of ongeldig is — caller beslist wat met
 * de fout te doen.
 */
function parseOccurrence(input: unknown): OccurrenceInput | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const startsAt = parseDate(o.startsAt);
  if (!startsAt) return null;
  return {
    id: o.id ? String(o.id) : undefined,
    startsAt,
    endsAt: parseDate(o.endsAt),
    priceCents: o.priceCents != null && o.priceCents !== '' ? Number(o.priceCents) : null,
    priceNote: o.priceNote ? String(o.priceNote).trim() || null : null,
    ticketUrl: o.ticketUrl ? String(o.ticketUrl) : null,
    room: o.room ? String(o.room).trim() || null : null,
    lineup: parseLineup(o.lineup),
    status: parseEnum(OCCURRENCE_STATUSES, o.status) ?? 'scheduled',
  };
}

export const adminApi = new Hono();

adminApi.use('*', requireAdminAny);

// ─── Sociale automatisering (IG-posts) ──────────────────────────────────
//
// Selectie + (binnenkort) render + caption + publish. Onder /admin/api/social/*
// zodat de bestaande Bearer-auth voor n8n/cron-triggers gewoon werkt.

adminApi.route('/social', adminSocial);

// ─── Uploads ────────────────────────────────────────────────────────────
//
// Twee modi om een afbeelding op Bunny te zetten:
//
//   1. Multipart upload: POST /admin/api/uploads met form field `file`.
//      Optioneel `kind` (events|venues|series|misc) bepaalt het sub-pad.
//
//   2. Source-URL fetch: POST /admin/api/uploads met JSON
//      `{ sourceUrl: "...", kind?: "events" }`. Server fetcht de URL,
//      stuurt 'm door naar Bunny, returnt onze CDN-link. Handig voor
//      n8n-flows die alleen een externe foto-URL hebben en onze CDN
//      willen gebruiken (cache + EU-hosting).
//
// Beide retourneren `{ url: "https://andreas-x.b-cdn.net/<path>" }` —
// die URL kan direct in `imageUrl` op events/venues/series.

const ALLOWED_MIME_PREFIX = 'image/';
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB

function extFromMime(mime: string): string {
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('avif')) return 'avif';
  return 'jpg';
}

function uploadPath(kind: string, ext: string): string {
  const folder = ['events', 'venues', 'series'].includes(kind) ? kind : 'misc';
  const id = randomBytes(8).toString('hex');
  const ts = Date.now();
  return `media/${folder}/${ts}-${id}.${ext}`;
}

adminApi.post('/uploads', async (c) => {
  const ct = c.req.header('content-type') ?? '';

  if (ct.includes('application/json')) {
    const body = (await c.req.json()) as {
      sourceUrl?: string;
      kind?: string;
    };
    const sourceUrl = String(body.sourceUrl ?? '').trim();
    if (!sourceUrl) return c.json({ error: 'sourceUrl verplicht' }, 400);

    let upstream: Response;
    try {
      upstream = await fetch(sourceUrl);
    } catch (e) {
      return c.json({ error: `Kon ${sourceUrl} niet ophalen` }, 502);
    }
    if (!upstream.ok) {
      return c.json(
        { error: `Bron-URL gaf ${upstream.status}` },
        502
      );
    }
    const mime = upstream.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith(ALLOWED_MIME_PREFIX)) {
      return c.json({ error: `Bron is geen afbeelding (${mime})` }, 400);
    }
    const buf = await upstream.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) {
      return c.json({ error: `Bestand te groot (max ${MAX_BYTES} bytes)` }, 413);
    }
    const path = uploadPath(String(body.kind ?? ''), extFromMime(mime));
    const url = await uploadToBunny(path, buf, mime);
    return c.json({ url });
  }

  // Multipart fallback — n8n's HTTP Request node kan binary data
  // doorzetten als form field.
  const form = await c.req.parseBody();
  const file = form.file;
  const kind = String(form.kind ?? '');
  if (!file || typeof file === 'string') {
    return c.json({ error: 'file ontbreekt (form-data field)' }, 400);
  }
  const mime = file.type || 'image/jpeg';
  if (!mime.startsWith(ALLOWED_MIME_PREFIX)) {
    return c.json({ error: `Bestand is geen afbeelding (${mime})` }, 400);
  }
  if (file.size > MAX_BYTES) {
    return c.json({ error: `Bestand te groot (max ${MAX_BYTES} bytes)` }, 413);
  }
  const buf = await file.arrayBuffer();
  const path = uploadPath(kind, extFromMime(mime));
  const url = await uploadToBunny(path, buf, mime);
  return c.json({ url });
});

// ─── Events ─────────────────────────────────────────────────────────────
//
// Een event is een master-record (de "show", "film", "tentoonstelling")
// en bevat 1+ occurrences (= momenten). Voor films zijn dat alle
// voorstellingen, voor een wekelijks feest elke maandagavond, voor een
// eenmalig event één enkele rij. Voor `kind=exhibition` typisch één
// occurrence die de hele lopende periode dekt.

async function loadEventWithOccurrences(eventId: string) {
  const [event] = await db
    .select()
    .from(schema.events)
    .where(eq(schema.events.id, eventId))
    .limit(1);
  if (!event) return null;
  const occurrences = await db
    .select()
    .from(schema.occurrences)
    .where(eq(schema.occurrences.eventId, eventId))
    .orderBy(asc(schema.occurrences.startsAt));
  return { ...event, occurrences };
}

adminApi.get('/events', async (c) => {
  // Voor admin: alle events met de eerstvolgende (of meest recente)
  // occurrence inline, plus tellertje. Sorteerd op next-occurrence asc.
  const rows = await db.select().from(schema.events);
  if (rows.length === 0) return c.json({ events: [] });

  const allOcc = await db
    .select()
    .from(schema.occurrences)
    .where(inArray(schema.occurrences.eventId, rows.map((r) => r.id)))
    .orderBy(asc(schema.occurrences.startsAt));

  const occByEvent = new Map<
    string,
    { all: typeof allOcc; next: (typeof allOcc)[number] | null }
  >();
  for (const o of allOcc) {
    let entry = occByEvent.get(o.eventId);
    if (!entry) {
      entry = { all: [], next: null };
      occByEvent.set(o.eventId, entry);
    }
    entry.all.push(o);
    if (entry.next === null) entry.next = o;
  }

  const events = rows
    .map((r) => {
      const entry = occByEvent.get(r.id);
      return {
        ...r,
        occurrences: entry?.all ?? [],
        nextOccurrence: entry?.next ?? null,
        occurrenceCount: entry?.all.length ?? 0,
      };
    })
    .sort((a, b) => {
      const aT = a.nextOccurrence?.startsAt?.getTime() ?? Infinity;
      const bT = b.nextOccurrence?.startsAt?.getTime() ?? Infinity;
      return aT - bT;
    });
  return c.json({ events });
});

adminApi.post('/events', async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const title = String(body.title ?? '').trim();
  const venueId = String(body.venueId ?? '').trim();
  if (!title || !venueId) {
    return c.json({ error: 'title en venueId verplicht' }, 400);
  }

  // Occurrences kunnen op twee manieren binnenkomen:
  //  1. `body.occurrences: [{...}]` — expliciete array.
  //  2. Single-occurrence shorthand: top-level `startsAt` + optionele
  //     `endsAt/priceCents/priceNote/ticketUrl` (back-compat voor n8n
  //     flows die nog het oude schema sturen).
  let occurrenceInputs: OccurrenceInput[] = [];
  if (Array.isArray(body.occurrences)) {
    for (const raw of body.occurrences) {
      const occ = parseOccurrence(raw);
      if (!occ) {
        return c.json({ error: 'occurrence zonder geldige startsAt' }, 400);
      }
      occurrenceInputs.push(occ);
    }
  } else if (body.startsAt) {
    const occ = parseOccurrence({
      startsAt: body.startsAt,
      endsAt: body.endsAt,
      priceCents: body.priceCents,
      priceNote: body.priceNote,
      ticketUrl: body.ticketUrl,
      room: body.room,
      lineup: body.lineup,
      status: body.status,
    });
    if (!occ) return c.json({ error: 'startsAt invalid' }, 400);
    occurrenceInputs = [occ];
  }
  if (occurrenceInputs.length === 0) {
    return c.json(
      { error: 'minstens één occurrence (of top-level startsAt) verplicht' },
      400
    );
  }

  const id = (body.id ? String(body.id) : '') || `evt-${shortId()}`;
  const kind = parseEnum(EVENT_KINDS, body.kind) ?? 'show';

  // Bestaat de venue? Anders FK-error van Postgres met een nare melding.
  const [venue] = await db
    .select({ id: schema.venues.id })
    .from(schema.venues)
    .where(eq(schema.venues.id, venueId))
    .limit(1);
  if (!venue) return c.json({ error: `venue ${venueId} bestaat niet` }, 400);

  try {
    await db.transaction(async (tx) => {
      await tx.insert(schema.events).values({
        id,
        title,
        venueId,
        kind,
        description: body.description ? String(body.description) : null,
        imageUrl: body.imageUrl ? String(body.imageUrl) : null,
        category: parseCategoryOne(body.category),
        featured: Boolean(body.featured),
        genres: parseStringArray(body.genres),
        published: body.published == null ? true : Boolean(body.published),
      });
      await tx.insert(schema.occurrences).values(
        occurrenceInputs.map((occ) => ({
          id: occ.id ?? `occ-${shortId()}`,
          eventId: id,
          startsAt: occ.startsAt,
          endsAt: occ.endsAt,
          priceCents: occ.priceCents,
          priceNote: occ.priceNote,
          ticketUrl: occ.ticketUrl,
          room: occ.room,
          lineup: occ.lineup,
          status: occ.status,
        }))
      );
    });
  } catch (e) {
    const code = (e as { code?: string }).code ?? '';
    if (code === '23505') return c.json({ error: 'id bestaat al' }, 409);
    throw e;
  }

  const created = await loadEventWithOccurrences(id);
  return c.json({ event: created }, 201);
});

adminApi.get('/events/:id', async (c) => {
  const event = await loadEventWithOccurrences(c.req.param('id'));
  if (!event) return c.json({ error: 'not found' }, 404);
  return c.json({ event });
});

adminApi.patch('/events/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<Record<string, unknown>>();
  const updates: Record<string, unknown> = {};
  if ('title' in body) updates.title = String(body.title ?? '').trim();
  if ('venueId' in body) updates.venueId = String(body.venueId);
  if ('kind' in body) {
    const k = parseEnum(EVENT_KINDS, body.kind);
    if (!k) return c.json({ error: 'kind moet show of exhibition zijn' }, 400);
    updates.kind = k;
  }
  if ('description' in body) updates.description = body.description ? String(body.description) : null;
  if ('imageUrl' in body) updates.imageUrl = body.imageUrl ? String(body.imageUrl) : null;
  if ('category' in body) updates.category = parseCategoryOne(body.category);
  if ('featured' in body) updates.featured = Boolean(body.featured);
  if ('genres' in body) updates.genres = parseStringArray(body.genres);
  if ('published' in body) updates.published = Boolean(body.published);

  if (Object.keys(updates).length === 0) {
    return c.json({ error: 'geen velden om te updaten' }, 400);
  }

  const [row] = await db
    .update(schema.events)
    .set(updates)
    .where(eq(schema.events.id, id))
    .returning();
  if (!row) return c.json({ error: 'not found' }, 404);
  const event = await loadEventWithOccurrences(id);
  return c.json({ event });
});

adminApi.delete('/events/:id', async (c) => {
  const result = await db
    .delete(schema.events)
    .where(eq(schema.events.id, c.req.param('id')))
    .returning({ id: schema.events.id });
  if (result.length === 0) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

// ─── Occurrences ────────────────────────────────────────────────────────

adminApi.post('/events/:id/occurrences', async (c) => {
  const eventId = c.req.param('id');
  const [event] = await db
    .select({ id: schema.events.id })
    .from(schema.events)
    .where(eq(schema.events.id, eventId))
    .limit(1);
  if (!event) return c.json({ error: 'event niet gevonden' }, 404);

  const body = await c.req.json<Record<string, unknown>>();
  const occ = parseOccurrence(body);
  if (!occ) return c.json({ error: 'startsAt invalid' }, 400);

  const id = occ.id ?? `occ-${shortId()}`;
  try {
    const [row] = await db
      .insert(schema.occurrences)
      .values({
        id,
        eventId,
        startsAt: occ.startsAt,
        endsAt: occ.endsAt,
        priceCents: occ.priceCents,
        priceNote: occ.priceNote,
        ticketUrl: occ.ticketUrl,
        room: occ.room,
        lineup: occ.lineup,
        status: occ.status,
      })
      .returning();
    return c.json({ occurrence: row }, 201);
  } catch (e) {
    const code = (e as { code?: string }).code ?? '';
    if (code === '23505') return c.json({ error: 'id bestaat al' }, 409);
    throw e;
  }
});

adminApi.patch('/occurrences/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<Record<string, unknown>>();
  const updates: Record<string, unknown> = {};
  if ('startsAt' in body) {
    const d = parseDate(body.startsAt);
    if (!d) return c.json({ error: 'startsAt invalid' }, 400);
    updates.startsAt = d;
  }
  if ('endsAt' in body) updates.endsAt = parseDate(body.endsAt);
  if ('priceCents' in body) {
    updates.priceCents =
      body.priceCents != null && body.priceCents !== ''
        ? Number(body.priceCents)
        : null;
  }
  if ('priceNote' in body) updates.priceNote = body.priceNote ? String(body.priceNote).trim() || null : null;
  if ('ticketUrl' in body) updates.ticketUrl = body.ticketUrl ? String(body.ticketUrl) : null;
  if ('room' in body) updates.room = body.room ? String(body.room).trim() || null : null;
  if ('lineup' in body) updates.lineup = parseLineup(body.lineup);
  if ('status' in body) {
    const s = parseEnum(OCCURRENCE_STATUSES, body.status);
    if (!s) return c.json({ error: 'status invalid' }, 400);
    updates.status = s;
  }
  if (Object.keys(updates).length === 0) {
    return c.json({ error: 'geen velden om te updaten' }, 400);
  }
  const [row] = await db
    .update(schema.occurrences)
    .set(updates)
    .where(eq(schema.occurrences.id, id))
    .returning();
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json({ occurrence: row });
});

adminApi.delete('/occurrences/:id', async (c) => {
  const result = await db
    .delete(schema.occurrences)
    .where(eq(schema.occurrences.id, c.req.param('id')))
    .returning({ id: schema.occurrences.id });
  if (result.length === 0) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

// ─── Venues ─────────────────────────────────────────────────────────────

adminApi.get('/venues', async (c) => {
  const rows = await db.select().from(schema.venues).orderBy(asc(schema.venues.name));
  return c.json({ venues: rows });
});

adminApi.post('/venues', async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const name = String(body.name ?? '').trim();
  if (!name) return c.json({ error: 'name verplicht' }, 400);
  const id = (body.id ? String(body.id) : '') || slugify(name) || `venue-${shortId()}`;
  const slug = (body.slug ? String(body.slug) : '') || slugify(name) || id;
  try {
    const [row] = await db
      .insert(schema.venues)
      .values({
        id,
        slug,
        name,
        address: String(body.address ?? '').trim(),
        lat: Number(body.lat ?? 0),
        lng: Number(body.lng ?? 0),
        description: body.description ? String(body.description) : null,
        imageUrl: body.imageUrl ? String(body.imageUrl) : null,
        categories: parseCategoryArr(body.categories),
        type: parseEnum(VENUE_TYPES, body.type) ?? undefined,
        dayNight: parseEnum(DAY_NIGHT, body.dayNight) ?? undefined,
        wijk: parseEnum(WIJKEN, body.wijk) ?? undefined,
        scene: parseEnum(SCENES, body.scene) ?? undefined,
        capacity: parseEnum(CAPACITIES, body.capacity) ?? undefined,
        subtype: parseStringArray(body.subtype),
        website: body.website ? String(body.website) : null,
        instagram: body.instagram ? normalizeInstagram(String(body.instagram)) : null,
        priceNote: body.priceNote ? String(body.priceNote).trim() || null : null,
        published: body.published == null ? true : Boolean(body.published),
      })
      .returning();
    return c.json({ venue: row }, 201);
  } catch (e) {
    const code = (e as { code?: string }).code ?? '';
    if (code === '23505') return c.json({ error: 'id of slug bestaat al' }, 409);
    throw e;
  }
});

adminApi.get('/venues/:id', async (c) => {
  const [row] = await db
    .select()
    .from(schema.venues)
    .where(eq(schema.venues.id, c.req.param('id')))
    .limit(1);
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json({ venue: row });
});

adminApi.patch('/venues/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<Record<string, unknown>>();
  const updates: Record<string, unknown> = {};
  if ('slug' in body) updates.slug = String(body.slug);
  if ('name' in body) updates.name = String(body.name);
  if ('address' in body) updates.address = String(body.address);
  if ('lat' in body) updates.lat = Number(body.lat);
  if ('lng' in body) updates.lng = Number(body.lng);
  if ('description' in body) updates.description = body.description ? String(body.description) : null;
  if ('imageUrl' in body) updates.imageUrl = body.imageUrl ? String(body.imageUrl) : null;
  if ('categories' in body) updates.categories = parseCategoryArr(body.categories);
  if ('type' in body) updates.type = parseEnum(VENUE_TYPES, body.type);
  if ('dayNight' in body) updates.dayNight = parseEnum(DAY_NIGHT, body.dayNight);
  if ('wijk' in body) updates.wijk = parseEnum(WIJKEN, body.wijk);
  if ('scene' in body) updates.scene = parseEnum(SCENES, body.scene);
  if ('capacity' in body) updates.capacity = parseEnum(CAPACITIES, body.capacity);
  if ('subtype' in body) updates.subtype = parseStringArray(body.subtype);
  if ('website' in body) updates.website = body.website ? String(body.website) : null;
  if ('instagram' in body)
    updates.instagram = body.instagram ? normalizeInstagram(String(body.instagram)) : null;
  if ('priceNote' in body)
    updates.priceNote = body.priceNote ? String(body.priceNote).trim() || null : null;
  if ('published' in body) updates.published = Boolean(body.published);
  if (Object.keys(updates).length === 0) {
    return c.json({ error: 'geen velden om te updaten' }, 400);
  }
  const [row] = await db
    .update(schema.venues)
    .set(updates)
    .where(eq(schema.venues.id, id))
    .returning();
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json({ venue: row });
});

adminApi.delete('/venues/:id', async (c) => {
  const result = await db
    .delete(schema.venues)
    .where(eq(schema.venues.id, c.req.param('id')))
    .returning({ id: schema.venues.id });
  if (result.length === 0) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

// ─── Series ─────────────────────────────────────────────────────────────

adminApi.get('/series', async (c) => {
  const rows = await db.select().from(schema.series).orderBy(asc(schema.series.name));
  return c.json({ series: rows });
});

adminApi.post('/series', async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const name = String(body.name ?? '').trim();
  if (!name) return c.json({ error: 'name verplicht' }, 400);
  const id = (body.id ? String(body.id) : '') || `series-${slugify(name)}` || `series-${shortId()}`;
  const slug = (body.slug ? String(body.slug) : '') || slugify(name) || id;
  try {
    const [row] = await db
      .insert(schema.series)
      .values({
        id,
        slug,
        name,
        description: body.description ? String(body.description) : null,
        imageUrl: body.imageUrl ? String(body.imageUrl) : null,
        startsAt: parseDate(body.startsAt),
        endsAt: parseDate(body.endsAt),
        categories: parseCategoryArr(body.categories),
        published: body.published == null ? true : Boolean(body.published),
        featured: Boolean(body.featured),
      })
      .returning();
    return c.json({ series: row }, 201);
  } catch (e) {
    const code = (e as { code?: string }).code ?? '';
    if (code === '23505') return c.json({ error: 'id of slug bestaat al' }, 409);
    throw e;
  }
});

adminApi.get('/series/:id', async (c) => {
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(schema.series)
    .where(eq(schema.series.id, id))
    .limit(1);
  if (!row) return c.json({ error: 'not found' }, 404);
  const events = await db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      startsAt: schema.occurrences.startsAt,
    })
    .from(schema.eventsInSeries)
    .innerJoin(schema.events, eq(schema.events.id, schema.eventsInSeries.eventId))
    .leftJoin(
      schema.occurrences,
      eq(schema.occurrences.eventId, schema.events.id)
    )
    .where(eq(schema.eventsInSeries.seriesId, id))
    .orderBy(asc(schema.occurrences.startsAt));
  return c.json({ series: row, events });
});

adminApi.patch('/series/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<Record<string, unknown>>();
  const updates: Record<string, unknown> = {};
  if ('slug' in body) updates.slug = String(body.slug);
  if ('name' in body) updates.name = String(body.name);
  if ('description' in body) updates.description = body.description ? String(body.description) : null;
  if ('imageUrl' in body) updates.imageUrl = body.imageUrl ? String(body.imageUrl) : null;
  if ('startsAt' in body) updates.startsAt = parseDate(body.startsAt);
  if ('endsAt' in body) updates.endsAt = parseDate(body.endsAt);
  if ('categories' in body) updates.categories = parseCategoryArr(body.categories);
  if ('published' in body) updates.published = Boolean(body.published);
  if ('featured' in body) updates.featured = Boolean(body.featured);
  if (Object.keys(updates).length === 0) {
    return c.json({ error: 'geen velden om te updaten' }, 400);
  }
  const [row] = await db
    .update(schema.series)
    .set(updates)
    .where(eq(schema.series.id, id))
    .returning();
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json({ series: row });
});

adminApi.delete('/series/:id', async (c) => {
  const result = await db
    .delete(schema.series)
    .where(eq(schema.series.id, c.req.param('id')))
    .returning({ id: schema.series.id });
  if (result.length === 0) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

adminApi.post('/series/:id/events/:eventId', async (c) => {
  const seriesId = c.req.param('id');
  const eventId = c.req.param('eventId');
  await db
    .insert(schema.eventsInSeries)
    .values({ seriesId, eventId })
    .onConflictDoNothing();
  return c.json({ ok: true });
});

adminApi.delete('/series/:id/events/:eventId', async (c) => {
  const seriesId = c.req.param('id');
  const eventId = c.req.param('eventId');
  await db
    .delete(schema.eventsInSeries)
    .where(
      and(
        eq(schema.eventsInSeries.seriesId, seriesId),
        eq(schema.eventsInSeries.eventId, eventId)
      )
    );
  return c.json({ ok: true });
});

// ─── Scrapers ───────────────────────────────────────────────────────────
//
// Trigger een scraper voor alle venues die de bijbehorende
// `scraperConfig.<name>` ingevuld hebben. Bedoeld voor zowel manuele
// runs vanuit de admin webview als voor cron (Fly Machine schedule of
// een externe poke). Returns een rapport per venue zodat je kan zien
// hoeveel events nieuw waren, geüpdatet, of geskipt vanwege errors.

adminApi.post('/scrapers/run/:name', async (c) => {
  const name = c.req.param('name') as ScraperName;
  const runner = scrapers[name];
  if (!runner) {
    return c.json(
      { error: `unknown scraper: ${name}`, available: Object.keys(scrapers) },
      400
    );
  }
  const startedAt = Date.now();
  try {
    const results = await runner();
    return c.json({
      scraper: name,
      durationMs: Date.now() - startedAt,
      venues: results,
      totals: results.reduce(
        (acc, r) => ({
          fetched: acc.fetched + r.fetched,
          inserted: acc.inserted + r.inserted,
          occurrencesUpserted:
            acc.occurrencesUpserted + r.occurrencesUpserted,
          skipped: acc.skipped + r.skipped,
        }),
        { fetched: 0, inserted: 0, occurrencesUpserted: 0, skipped: 0 }
      ),
    });
  } catch (e) {
    return c.json(
      {
        scraper: name,
        durationMs: Date.now() - startedAt,
        error: (e as Error).message,
      },
      500
    );
  }
});

// ─── OMDb enrichment voor Film-events ───────────────────────────────
//
// Vult ontbrekende description, image en genres aan voor Film-events
// die nog gaps hebben. Aangeroepen door scrape-stager.yml's
// post-step (na alle scrapers). Idempotent — pakt alleen events met
// ontbrekende velden. Vereist OMDB_API_KEY in env.

adminApi.post('/enrich-films-omdb', async (c) => {
  const startedAt = Date.now();
  try {
    const result = await enrichFilmsFromOmdb();
    return c.json({
      durationMs: Date.now() - startedAt,
      ...result,
    });
  } catch (e) {
    return c.json(
      {
        durationMs: Date.now() - startedAt,
        error: (e as Error).message,
      },
      500
    );
  }
});

// ─── TMDb-enrichment ────────────────────────────────────────────────
//
// Vult posterUrl + stillUrl + trailerUrl voor Film+show events die
// nog gaps hebben. TMDb is veel completer dan OMDb voor arthouse en
// heeft year-disambiguatie + stills + trailers. Aangeroepen door
// scrape-stager.yml's post-step na de film-scrapers. Idempotent.
// Vereist TMDB_API_KEY in env.

adminApi.post('/enrich-films-tmdb', async (c) => {
  const startedAt = Date.now();
  try {
    const result = await enrichFilmsFromTmdb();
    return c.json({
      durationMs: Date.now() - startedAt,
      ...result,
    });
  } catch (e) {
    return c.json(
      {
        durationMs: Date.now() - startedAt,
        error: (e as Error).message,
      },
      500
    );
  }
});

// ─── Artists-enrichment via MusicBrainz ─────────────────────────────
//
// Verzamelt unieke artist-namen uit toekomstige Muziek-occurrence
// lineups, doet MB-lookup voor elke nieuwe + voor stale records (>7d
// oud), en linkt lineup-items naar artistId. CC0-data van MB cachen
// we expliciet in de `artists`-tabel.
//
// `?limit=N` query-param houdt 'n run binnen de cron-timeout (1.5s
// throttle × N artists × 2 calls = 3N seconds; 400 artists ≈ 20 min).

adminApi.post('/enrich-artists', async (c) => {
  const startedAt = Date.now();
  const limitParam = c.req.query('limit');
  const limit = limitParam ? parseInt(limitParam, 10) : undefined;
  try {
    const result = await enrichLineupArtists(
      limit && Number.isFinite(limit) ? limit : undefined
    );
    return c.json({
      durationMs: Date.now() - startedAt,
      ...result,
    });
  } catch (e) {
    return c.json(
      {
        durationMs: Date.now() - startedAt,
        error: (e as Error).message,
      },
      500
    );
  }
});

// ─── Genre-enrichment (keyword + AI fallback) ───────────────────────
//
// Twee-staps verrijking voor events zonder genre-labels. Stap 1 is
// keyword-heuristiek (gratis); stap 2 is Claude Haiku-fallback voor
// wat na stap 1 nog leeg is. Aangeroepen door scrape-stager.yml's
// post-steps na film-enrichment.

adminApi.post('/enrich-genres-keywords', async (c) => {
  const startedAt = Date.now();
  try {
    const result = await enrichGenresFromKeywords();
    return c.json({ durationMs: Date.now() - startedAt, ...result });
  } catch (e) {
    return c.json(
      { durationMs: Date.now() - startedAt, error: (e as Error).message },
      500
    );
  }
});

adminApi.post('/enrich-genres-ai', async (c) => {
  const startedAt = Date.now();
  try {
    const result = await enrichGenresFromAI();
    return c.json({ durationMs: Date.now() - startedAt, ...result });
  } catch (e) {
    return c.json(
      { durationMs: Date.now() - startedAt, error: (e as Error).message },
      500
    );
  }
});

// ─── LLM-import (musea/galleries) ───────────────────────────────────
//
// Voor traag-veranderende content: één endpoint pakt elke URL, plukt
// de pagina-tekst, en laat Claude een lijst tentoonstellingen
// extraheren. Admin reviewt + accepteert, daarna pas DB-insert.

adminApi.post('/import/extract-from-url', async (c) => {
  const body = await c.req.json<{ url?: unknown }>();
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!url || !/^https?:\/\//.test(url)) {
    return c.json({ error: 'geef een geldige http(s)-URL' }, 400);
  }
  const startedAt = Date.now();
  try {
    const result = await extractFromUrl(url);
    return c.json({
      ...result,
      durationMs: Date.now() - startedAt,
    });
  } catch (e) {
    return c.json(
      {
        error: (e as Error).message,
        durationMs: Date.now() - startedAt,
      },
      500,
    );
  }
});

adminApi.post('/import/exhibitions', async (c) => {
  const body = await c.req.json<{
    venueId?: unknown;
    exhibitions?: unknown;
  }>();
  const venueId = String(body.venueId ?? '').trim();
  if (!venueId) return c.json({ error: 'venueId verplicht' }, 400);
  const [venue] = await db
    .select({ id: schema.venues.id, name: schema.venues.name, categories: schema.venues.categories })
    .from(schema.venues)
    .where(eq(schema.venues.id, venueId))
    .limit(1);
  if (!venue) return c.json({ error: `venue ${venueId} bestaat niet` }, 400);

  if (!Array.isArray(body.exhibitions)) {
    return c.json({ error: 'exhibitions[] verplicht' }, 400);
  }

  type Item = {
    title: string;
    startDate: string | null;
    endDate: string | null;
    description: string | null;
    imageUrl: string | null;
    sourceUrl: string | null;
    category: 'Kunst' | 'Theater' | 'Literatuur' | 'Film' | 'Muziek' | 'Lezing';
  };

  const items: Item[] = [];
  for (const raw of body.exhibitions as Array<Record<string, unknown>>) {
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (title.length < 2) continue;
    const category = typeof raw.category === 'string' && CATEGORIES.includes(raw.category as Category)
      ? (raw.category as Category)
      : venue.categories?.[0] ?? 'Kunst';
    items.push({
      title,
      startDate: typeof raw.startDate === 'string' ? raw.startDate : null,
      endDate: typeof raw.endDate === 'string' ? raw.endDate : null,
      description: typeof raw.description === 'string' ? raw.description : null,
      imageUrl: typeof raw.imageUrl === 'string' ? raw.imageUrl : null,
      sourceUrl: typeof raw.sourceUrl === 'string' ? raw.sourceUrl : null,
      category,
    });
  }
  if (items.length === 0) {
    return c.json({ error: 'geen geldige items om in te voegen' }, 400);
  }

  // Idempotency: eventId = `evt-${venueId}-${slugify(title)}`. Re-runs
  // overschrijven imageUrl en description NIET (admin kan deze
  // bewerken via de gewone /events PATCH).
  let inserted = 0;
  let updated = 0;
  const errors: Array<{ title: string; error: string }> = [];

  for (const item of items) {
    const eventId = `evt-${venueId}-${slugify(item.title)}`;
    const occurrenceId = `occ-${venueId}-${slugify(item.title)}`;

    // Datum-parse: YYYY-MM-DD → 00:00 Amsterdam. Geen datums = skip
    // de occurrence-insert, alleen event.
    const startsAt = item.startDate
      ? new Date(`${item.startDate}T00:00:00+02:00`)
      : null;
    const endsAt = item.endDate
      ? new Date(`${item.endDate}T23:59:00+02:00`)
      : null;

    try {
      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      if (existing) {
        // Alleen updaten als description/sourceUrl iets nieuws hebben.
        if (item.description || item.sourceUrl) {
          await db
            .update(schema.events)
            .set({
              description: item.description ?? undefined,
              category: item.category,
            })
            .where(eq(schema.events.id, eventId));
          updated++;
        }
      } else {
        // Image mirroren naar Bunny zodat 'm niet afhankelijk is van
        // upstream-availability. Bij fout: skip de mirror, gewoon
        // de bron-URL bewaren als fallback.
        let mirroredUrl: string | null = item.imageUrl;
        if (item.imageUrl) {
          try {
            const r = await fetch(item.imageUrl);
            if (r.ok) {
              const mime = r.headers.get('content-type') ?? 'image/jpeg';
              if (mime.startsWith('image/')) {
                const buf = await r.arrayBuffer();
                if (buf.byteLength >= 1024 && buf.byteLength <= 16 * 1024 * 1024) {
                  const ext = mime.includes('png')
                    ? 'png'
                    : mime.includes('webp')
                      ? 'webp'
                      : mime.includes('gif')
                        ? 'gif'
                        : 'jpg';
                  const path = `media/events/import-${venueId}-${slugify(item.title)}.${ext}`;
                  mirroredUrl = await uploadToBunny(path, buf, mime);
                }
              }
            }
          } catch (e) {
            // Mirror faalt — behoud de bron-URL.
            errors.push({
              title: item.title,
              error: `image mirror: ${(e as Error).message}`,
            });
          }
        }
        await db.insert(schema.events).values({
          id: eventId,
          venueId,
          title: item.title,
          description: item.description,
          kind: 'exhibition',
          imageUrl: mirroredUrl,
          category: item.category,
          featured: false,
          genres: [],
          published: true,
        });
        inserted++;
      }

      if (startsAt) {
        const occEnd =
          endsAt ?? new Date(startsAt.getTime() + 90 * 24 * 60 * 60 * 1000);
        await db
          .insert(schema.occurrences)
          .values({
            id: occurrenceId,
            eventId,
            startsAt,
            endsAt: occEnd,
            priceCents: null,
            priceNote: null,
            ticketUrl: item.sourceUrl,
            room: null,
            lineup: null,
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: {
              startsAt,
              endsAt: occEnd,
              ticketUrl: item.sourceUrl,
            },
          });
      }
    } catch (e) {
      errors.push({ title: item.title, error: (e as Error).message });
    }
  }

  // Markeer wanneer er voor 't laatst voor deze venue succesvol
  // is gesynced (inclusief updates — alleen errors-only telt niet).
  if (inserted > 0 || updated > 0) {
    await db
      .update(schema.venues)
      .set({ lastImportedAt: new Date() })
      .where(eq(schema.venues.id, venueId));
  }

  return c.json({
    venueId,
    inserted,
    updated,
    errors,
    total: items.length,
  });
});
