/**
 * Kriterion scraper.
 *
 * Kriterion (Roetersstraat, sinds 1945, student-run) publiceert hun
 * volledige programma op één agenda-pagina in een JSON-LD `@graph` met
 * ScreeningEvent-items. Geen sitemap-loop nodig zoals bij Eye — de
 * agenda is een single fetch.
 *
 * Plan:
 *   1. Fetch `/agenda/`.
 *   2. Parse `@graph` ScreeningEvents.
 *   3. Strip " - Filmvoorstelling" suffix uit de titel zodat
 *      cross-venue dedup met Eye werkt ("Anora" matched "Anora",
 *      niet "Anora - Filmvoorstelling").
 *   4. Event-niveau dedup op title + kind='show' + category='Film'.
 *   5. Per ScreeningEvent een occurrence upsert met venueId='kriterion'.
 *
 * Kriterion's `offers.url` heeft `/show/{id}` — stabiel als occurrence-id.
 * Geen prijs in offers (alleen priceCurrency); priceCents = null.
 * Image is een generieke logo.png — niet film-specifiek, dus skippen
 * we 'm bij nieuwe events (laten 'm null; cross-scraper kan 'm later
 * vullen).
 */

import { randomBytes } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { fetchFilmGenres } from './_tmdb.js';

const AGENDA_URL = 'https://www.kriterion.nl/agenda/';
const FILMS_API = 'https://www.kriterion.nl/api/films?populate=still&pagination%5Blimit%5D=200';
const VENUE_ID = 'kriterion';
const UA = 'AndreasBot/1.0 (+https://andreas.amsterdam)';

export interface KriterionResult {
  venueId: 'kriterion';
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
}

interface ScreeningEventLd {
  '@type': 'ScreeningEvent';
  name: string;
  description?: string;
  startDate: string;
  endDate?: string;
  offers?: { url?: string; price?: string };
}

export async function scrapeKriterion(): Promise<KriterionResult[]> {
  const result: KriterionResult = {
    venueId: 'kriterion',
    fetched: 0,
    inserted: 0,
    occurrencesUpserted: 0,
    skipped: 0,
    errors: [],
  };

  // Twee bronnen: agenda (screenings = JSON-LD met data/tijd/show-id),
  // films-API (Strapi met titel/regie/jaar/still). Stills komen van een
  // private GCS-bucket via tijdelijk-signed URLs (15 min) — we
  // downloaden ze en pushen naar Bunny CDN voor persistent gebruik.
  const [html, films] = await Promise.all([
    fetchText(AGENDA_URL),
    loadFilmsByTitle(),
  ]);
  if (!html) {
    result.errors.push('agenda fetch failed');
    return [result];
  }
  result.fetched = 1;

  const screenings = parseScreenings(html);
  const now = Date.now();
  const future = screenings.filter((s) => {
    const t = new Date(s.startDate).getTime();
    return Number.isFinite(t) && t >= now;
  });

  // Groepeer per (gestripte) titel zodat we per film één event-row
  // hebben en daar alle occurrences aan hangen. Cross-venue dedup
  // gebeurt in de event-lookup hieronder.
  const byTitle = new Map<string, ScreeningEventLd[]>();
  for (const s of future) {
    const title = cleanTitle(s.name);
    if (!title) continue;
    const arr = byTitle.get(title);
    if (arr) arr.push(s);
    else byTitle.set(title, [s]);
  }

  for (const [title, items] of byTitle) {
    try {
      // Cross-venue dedup: vind bestaand Film-event met deze titel.
      // Werkt voor Eye-films die we al hebben — Kriterion hangt z'n
      // occurrences daaraan. Anders nieuw event.
      const [existing] = await db
        .select({
          id: schema.events.id,
          description: schema.events.description,
          imageUrl: schema.events.imageUrl,
          genres: schema.events.genres,
        })
        .from(schema.events)
        .where(
          and(
            eq(schema.events.title, title),
            eq(schema.events.category, 'Film'),
            eq(schema.events.kind, 'show')
          )
        )
        .limit(1);

      const meta = films.get(normalizeForMatch(title));
      let eventId: string;
      if (existing) {
        eventId = existing.id;
        const patch: Record<string, unknown> = {};
        // Description aanvullen als 'ie leeg is. Niet overschrijven —
        // Eye/Wikipedia/AI-enrich kunnen al een betere variant hebben.
        if (!existing.description && meta?.description) {
          patch.description = meta.description;
        }
        // Kriterion's stills zijn cinematic en breed (16:9) — mooier
        // voor card-rendering dan Wikipedia's poster-thumbnails (1:1.5).
        // Overschrijf null OF wikipedia/wikimedia URLs; laat Eye- en
        // andere venue-stills met rust (die hebben hun eigen redactie).
        if (
          !existing.imageUrl ||
          /wiki(p|m)edia\.org/.test(existing.imageUrl)
        ) {
          const poster = await resolveAndUploadPoster(title, films);
          if (poster) patch.imageUrl = poster;
        }
        if (!existing.genres || existing.genres.length === 0) {
          const genres = await fetchFilmGenres(title);
          if (genres.length > 0) patch.genres = genres;
        }
        if (Object.keys(patch).length > 0) {
          await db
            .update(schema.events)
            .set(patch)
            .where(eq(schema.events.id, eventId));
        }
      } else {
        eventId = `film-${slugify(title)}-${randomBytes(3).toString('hex')}`;
        // Kriterion's agenda-description is een sjabloon, maar Strapi's
        // beschrijving (Editor.js JSON) is echte film-tekst. Poster
        // komt van Strapi → Bunny. Genres van TMDb. Alles null als 't
        // niet lukt; volgende run probeert opnieuw.
        const poster = await resolveAndUploadPoster(title, films);
        const genres = await fetchFilmGenres(title);
        await db.insert(schema.events).values({
          id: eventId,
          venueId: VENUE_ID,
          title,
          description: meta?.description ?? null,
          kind: 'show',
          imageUrl: poster,
          category: 'Film',
          ...(genres.length > 0 ? { genres } : {}),
        });
        result.inserted += 1;
      }

      for (const s of items) {
        const showId = parseShowId(s.offers?.url);
        if (!showId) continue;
        const occId = `kriterion-show-${showId}`;
        const startsAt = new Date(s.startDate);
        if (Number.isNaN(startsAt.getTime())) continue;
        const endsAt = s.endDate ? new Date(s.endDate) : null;
        const ticketUrl = s.offers?.url ?? null;

        const [existingOcc] = await db
          .select({ id: schema.occurrences.id })
          .from(schema.occurrences)
          .where(eq(schema.occurrences.id, occId))
          .limit(1);

        if (existingOcc) {
          await db
            .update(schema.occurrences)
            .set({
              startsAt,
              endsAt,
              ticketUrl,
              venueId: VENUE_ID,
              eventId,
            })
            .where(eq(schema.occurrences.id, occId));
        } else {
          await db.insert(schema.occurrences).values({
            id: occId,
            eventId,
            venueId: VENUE_ID,
            startsAt,
            endsAt,
            priceCents: null,
            ticketUrl,
            status: 'scheduled',
          });
        }
        result.occurrencesUpserted += 1;
      }
    } catch (e) {
      result.errors.push(`${title}: ${(e as Error).message ?? String(e)}`);
    }
  }

  result.skipped = screenings.length - future.length;
  return [result];
}

// ─── Helpers ────────────────────────────────────────────────────────────

async function fetchText(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

function parseScreenings(html: string): ScreeningEventLd[] {
  const out: ScreeningEventLd[] = [];
  const re = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  for (const m of html.matchAll(re)) {
    try {
      const data = JSON.parse(m[1]);
      // Kriterion zet alles onder een `@graph`. Andere blokken zijn
      // MovieTheater/WebSite — die slaan we over.
      const graph = (data as { '@graph'?: unknown[] })['@graph'];
      const items = Array.isArray(graph)
        ? graph
        : Array.isArray(data)
          ? data
          : [data];
      for (const item of items) {
        if (
          item &&
          typeof item === 'object' &&
          (item as { '@type'?: string })['@type'] === 'ScreeningEvent' &&
          typeof (item as { name?: unknown }).name === 'string' &&
          typeof (item as { startDate?: unknown }).startDate === 'string'
        ) {
          out.push(item as ScreeningEventLd);
        }
      }
    } catch {
      /* skip kapotte JSON-LD blokken */
    }
  }
  return out;
}

/** Strip Kriterion's " - Filmvoorstelling"-suffix. Sommige titels hebben
    extra info in tussen-haakjes (special-screenings, vooravonden) —
    die houden we, anders matched dedup niet. */
function cleanTitle(raw: string): string {
  return raw
    .replace(/\s*[-–]\s*Filmvoorstelling\s*$/i, '')
    .trim();
}

function parseShowId(url?: string): string | null {
  if (!url) return null;
  const m = url.match(/\/show\/(\d+)/);
  return m ? m[1] : null;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/** Normaliseer titels voor matching: lowercase, strip suffix-haakjes
    ("(ENG subs)", "(4k Restoration)"), strip " | Festival-X" en strip
    diacritics. Zo matched "The President's Cake (ENG subs)" met
    Strapi's "The President's Cake". */
function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/\s*\|\s*/)[0]
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface StrapiFilm {
  id: number;
  attributes: {
    titel?: string;
    /** Editor.js JSON-string met blocks. We platten 'm tot één
        paragraaf voor event.description. */
    beschrijving?: string;
    still?: {
      data?: {
        attributes?: {
          formats?: {
            large?: { url: string };
            medium?: { url: string };
            small?: { url: string };
          };
        };
      };
    };
  };
}

interface FilmMeta {
  posterUrl?: string;
  description?: string;
}

/** Haal alle Kriterion-films op uit hun Strapi-API en return een map
    van genormaliseerde titel → film-meta (signed-still-URL + plain-
    text-description geëxtraheerd uit Editor.js blocks). */
async function loadFilmsByTitle(): Promise<Map<string, FilmMeta>> {
  const map = new Map<string, FilmMeta>();
  try {
    const r = await fetch(FILMS_API, { headers: { 'User-Agent': UA } });
    if (!r.ok) return map;
    const json = (await r.json()) as { data?: StrapiFilm[] };
    for (const f of json.data ?? []) {
      const title = f.attributes.titel?.trim();
      if (!title) continue;
      const formats = f.attributes.still?.data?.attributes?.formats;
      const posterUrl =
        formats?.large?.url ?? formats?.medium?.url ?? formats?.small?.url;
      const description = parseEditorJsText(f.attributes.beschrijving);
      map.set(normalizeForMatch(title), { posterUrl, description });
    }
  } catch {
    /* gracefully skip */
  }
  return map;
}

/** Editor.js bewaart description als JSON met `blocks`. We pakken
    paragraph-blocks en plakken hun text aan elkaar; HTML entities
    decoderen en HTML-tags strippen omdat de tekst van Editor.js
    inline `<em>`/`<b>`/`&amp;`/etc. kan bevatten. */
function parseEditorJsText(raw?: string): string | undefined {
  if (!raw) return undefined;
  try {
    const data = JSON.parse(raw) as {
      blocks?: Array<{ type?: string; data?: { text?: string } }>;
    };
    const parts = (data.blocks ?? [])
      .filter((b) => b.type === 'paragraph' && b.data?.text)
      .map((b) => b.data!.text!);
    const text = parts
      .join('\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&nbsp;/g, ' ')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

/** Match een agenda-titel met Kriterion's film-DB, download de still
    via de signed GCS URL en upload naar Bunny voor persistente toegang.
    Returnt de publieke Bunny-URL, of null als 't niet lukt. */
async function resolveAndUploadPoster(
  title: string,
  films: Map<string, FilmMeta>
): Promise<string | null> {
  const key = normalizeForMatch(title);
  if (!key) return null;
  const signedUrl = films.get(key)?.posterUrl;
  if (!signedUrl) return null;
  try {
    const r = await fetch(signedUrl, { headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    // Bunny-path: kriterion/film-posters/<slug>.jpg. Idempotent (Bunny
    // overwrite is een PUT) — re-uploaden geeft dezelfde URL.
    const path = `kriterion/film-posters/${slugify(title)}.jpg`;
    return await uploadToBunny(path, buf, 'image/jpeg');
  } catch {
    return null;
  }
}
