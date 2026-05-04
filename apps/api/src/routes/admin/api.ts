import { randomBytes } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { db, schema } from '../../db/index.js';
import { uploadToBunny } from '../../storage/bunny.js';
import { requireAdminAny } from './auth.js';

/**
 * JSON API voor admin-acties — bedoeld voor n8n-agents en
 * scripts. Auth via cookie (browser) of `Authorization: Bearer
 * <ADMIN_API_KEY>` (server-to-server).
 *
 * Endpoints zijn idempotent waar het kan: id-collisies → 409,
 * onbekende ids → 404, validatie-fouten → 400.
 */

const CATEGORIES = ['Muziek', 'Theater', 'Literatuur', 'Film'] as const;
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

export const adminApi = new Hono();

adminApi.use('*', requireAdminAny);

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

adminApi.get('/events', async (c) => {
  const rows = await db.select().from(schema.events).orderBy(asc(schema.events.startsAt));
  return c.json({ events: rows });
});

adminApi.post('/events', async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const title = String(body.title ?? '').trim();
  const venueId = String(body.venueId ?? '').trim();
  const startsAt = parseDate(body.startsAt);
  if (!title || !venueId || !startsAt) {
    return c.json({ error: 'title, venueId, startsAt verplicht' }, 400);
  }
  const id = (body.id ? String(body.id) : '') || `evt-${shortId()}`;

  // Bestaat de venue? Anders FK-error van Postgres met een nare melding.
  const [venue] = await db
    .select({ id: schema.venues.id })
    .from(schema.venues)
    .where(eq(schema.venues.id, venueId))
    .limit(1);
  if (!venue) return c.json({ error: `venue ${venueId} bestaat niet` }, 400);

  try {
    const [row] = await db
      .insert(schema.events)
      .values({
        id,
        title,
        venueId,
        startsAt,
        endsAt: parseDate(body.endsAt),
        description: body.description ? String(body.description) : null,
        imageUrl: body.imageUrl ? String(body.imageUrl) : null,
        ticketUrl: body.ticketUrl ? String(body.ticketUrl) : null,
        priceCents: body.priceCents != null ? Number(body.priceCents) : null,
        priceNote: body.priceNote ? String(body.priceNote).trim() || null : null,
        category: parseCategoryOne(body.category),
        featured: Boolean(body.featured),
        genres: parseStringArray(body.genres),
        published: body.published == null ? true : Boolean(body.published),
      })
      .returning();
    return c.json({ event: row }, 201);
  } catch (e) {
    const code = (e as { code?: string }).code ?? '';
    if (code === '23505') return c.json({ error: 'id bestaat al' }, 409);
    throw e;
  }
});

adminApi.get('/events/:id', async (c) => {
  const [row] = await db
    .select()
    .from(schema.events)
    .where(eq(schema.events.id, c.req.param('id')))
    .limit(1);
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json({ event: row });
});

adminApi.patch('/events/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<Record<string, unknown>>();
  const updates: Record<string, unknown> = {};
  if ('title' in body) updates.title = String(body.title ?? '').trim();
  if ('venueId' in body) updates.venueId = String(body.venueId);
  if ('startsAt' in body) {
    const d = parseDate(body.startsAt);
    if (!d) return c.json({ error: 'startsAt invalid' }, 400);
    updates.startsAt = d;
  }
  if ('endsAt' in body) updates.endsAt = parseDate(body.endsAt);
  if ('description' in body) updates.description = body.description ? String(body.description) : null;
  if ('imageUrl' in body) updates.imageUrl = body.imageUrl ? String(body.imageUrl) : null;
  if ('ticketUrl' in body) updates.ticketUrl = body.ticketUrl ? String(body.ticketUrl) : null;
  if ('priceCents' in body) updates.priceCents = body.priceCents != null ? Number(body.priceCents) : null;
  if ('priceNote' in body) updates.priceNote = body.priceNote ? String(body.priceNote).trim() || null : null;
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
  return c.json({ event: row });
});

adminApi.delete('/events/:id', async (c) => {
  const result = await db
    .delete(schema.events)
    .where(eq(schema.events.id, c.req.param('id')))
    .returning({ id: schema.events.id });
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
      startsAt: schema.events.startsAt,
    })
    .from(schema.eventsInSeries)
    .innerJoin(schema.events, eq(schema.events.id, schema.eventsInSeries.eventId))
    .where(eq(schema.eventsInSeries.seriesId, id))
    .orderBy(asc(schema.events.startsAt));
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
