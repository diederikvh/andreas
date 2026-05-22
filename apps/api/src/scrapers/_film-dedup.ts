/**
 * Gedeelde dedup-laag voor film-scrapers (eye, kriterion, studiok,
 * lab111, filmhallen, themovies, cinecenter, cinemadevlugt, cavia,
 * ketelhuis, rialto, fchyena, …).
 *
 * Probleem: een film draait vaak in meerdere bioscopen, en elke
 * bioscoop noemt 'm net iets anders ("Anora" vs "Anora (ENG subs)" vs
 * "Anora (4K Restoration)"). Naïeve exact-match dedup op title
 * resulteert in 3 verschillende events voor één film, met als gevolg
 * dubbele kaartjes op de Avond/Vandaag-rails.
 *
 * Aanpak:
 *   1. `normalizeFilmTitle()` produceert een search-key: lowercase,
 *      diacritics weg, suffix-haakjes weg (subs/restoration/Q&A/etc),
 *      festival-bullet weg (`• Summer of Studio/Queer`). Twee titels
 *      die naar dezelfde key normaliseren = zelfde film.
 *   2. `loadFilmDedupeMap()` laadt aan het begin van de scraper alle
 *      bestaande Film+show events in een Map<key, eventId>. Eén SQL-
 *      query per scraper-run, daarna pure in-memory lookups.
 *   3. `findOrCreateFilmEvent()` doet de lookup + optional patch +
 *      insert. Voegt de nieuwe event-key meteen toe aan de map, zodat
 *      een volgende film in dezelfde run ook al gematched wordt.
 *   4. `pruneStaleOccurrences()` verwijdert future-occurrences die
 *      deze run niet meer gezien zijn — zo schoont een scraper z'n
 *      eigen verlede-rommel op (films die offline geplaatst zijn,
 *      tickets die verschoven zijn naar een nieuwe show-id).
 *
 * Display-titel: bij een hit op de map houden we de bestaande title
 * (first-insert-wins). De one-off merge-script kiest later een schonere
 * canonieke variant.
 */

import { randomBytes } from 'node:crypto';

import { and, eq, gte, inArray } from 'drizzle-orm';

import { db as dbDefault, schema } from '../db/index.js';

type Db = typeof dbDefault;

/**
 * Marker-keywords die we herkennen binnen een paren/bracket-suffix.
 * Wanneer een `(...)` of `[...]`-block er één of meer van bevat,
 * strippen we het hele block (incl. omringende "ENG, ", "met ",
 * komma-separators, etc).
 *
 * Bewust géén "year" hierin — die staat als losse regex hieronder en
 * raakt alleen pure jaar-haakjes "(2024)". Anders zouden we
 * "Suspiria (1977)" ook strippen, en dat doen we sowieso (de Suspiria
 * 1977 vs 2018-edge-case accepteren we als false-merge).
 */
const SUFFIX_MARKERS = [
  // Subs / language
  'subs?', 'ondertitels?', 'eng(?:lish)?\\s+subs?', 'nl\\s+subs?',
  'dutch\\s+subs?', 'nederlands(?:e)?\\s+ondertitels?',
  'originele\\s+versie',
  // Picture format
  '[24]k(?:\\s+(?:restoration|restauratie))?',
  'imax', '7?0\\s*mm', '35\\s*mm', 'dolby(?:\\s+atmos)?',
  '(?:digitaal\\s+)?gerestaureerd',
  // Event-type
  'q\\s*&\\s*a', 'premiere', 'pr[eé]mière', 'voorpremi[eè]re',
  'sneak\\s*preview', 'special\\s+screening',
  'director\'?s\\s+cut', 'extended', 'remastered', 'uncut',
].join('|');

/**
 * Patterns die we uit een titel strippen vóór de matching-key te
 * berekenen. Alleen patterns die echt "varianten van dezelfde film"
 * markeren — niet "andere film met zelfde basistitel" (zoals het
 * jaartal-onderscheid Suspiria 1977 vs 2018; daar verlies je accuracy
 * mee, maar in praktijk laten arthouse-bioscopen geen twee versies
 * tegelijk draaien).
 *
 * Volgorde matters: bullet-suffix eerst (kan zelf parenthesen
 * bevatten), dan paren-blocks met markers, dan jaar-paren, dan venue.
 */
const STRIP_PATTERNS: RegExp[] = [
  // Festival/programma-bullet: " • Summer of Studio/Queer", " • Open Land".
  // Studio/K hangt deze achter al z'n festival-films.
  /\s*[•·]\s*[^•·()[\]]+$/u,
  // Paren/bracket-block dat één of meer marker-keywords bevat. Slurpt
  // het hele block (incl. komma-separated combos zoals
  // "(ENG subs, 4k Restoration)").
  new RegExp(
    `\\s*[([][^)\\]]*\\b(?:${SUFFIX_MARKERS})\\b[^)\\]]*[)\\]]`,
    'giu'
  ),
  // Jaar-suffix "(2024)" — strippen want Studio/K voegt 'm vaak toe
  // bij festival-titels terwijl andere bioscopen 'm weglaten. Cost:
  // Suspiria 1977/2018-edge-case faalt, accepteer dat.
  /\s*[([]\s*(?:19|20)\d{2}\s*[)\]]/g,
  // Venue-suffix uit de og:title: " - Studio/K", " - Filmvoorstelling",
  // " | Het Ketelhuis", " - Eye Filmmuseum".
  /\s*[-–|]\s*(?:filmvoorstelling|studio\/k|het\s+ketelhuis|eye(?:\s+filmmuseum)?|kriterion|lab111|filmhallen|the\s+movies|cinecenter|cinema\s+de\s+vlugt|cavia)\s*$/giu,
];

/**
 * Normalizeer een film-titel naar een search-key voor cross-venue
 * dedup. Lowercase + diacritics weg + suffix-patterns weg + apostrof-
 * varianten genormaliseerd + whitespace gecollapst.
 *
 * Voorbeelden:
 *   "Anora"                                        → "anora"
 *   "Anora (ENG subs)"                             → "anora"
 *   "Hard Boiled (ENG subs, 4k Restoration)"       → "hard boiled"
 *   "Hannah Montana: The Movie (2009) • Open Land" → "hannah montana: the movie"
 *   "The President's Cake"                         → "the president's cake"
 *   "The President's Cake (ENG SUBS)"              → "the president's cake"
 *   "Los Domingos"  / "Los domingos"               → "los domingos"
 *   "Michael - Studio/K"                           → "michael"
 */
export function normalizeFilmTitle(raw: string): string {
  let s = raw
    .normalize('NFD')
    // Diacritics weg (combining marks).
    .replace(/[̀-ͯ]/g, '')
    // Curly apostrofs/quotes → straight.
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    // Loose hyphen/dash-varianten → ascii hyphen voor pattern-match.
    .replace(/[–—]/g, '-')
    .toLowerCase();

  // Strippen in volgorde — sommige patterns kunnen na elkaar matchen
  // (bv. eerst bullet-suffix, dan jaar-haakje wat erin zat, dan subs).
  // We loopen tot er niks meer verandert om multi-suffix-staarten
  // ("Anora (ENG subs, 4k Restoration)") in één pass leeg te trekken.
  let prev = '';
  while (prev !== s) {
    prev = s;
    for (const re of STRIP_PATTERNS) {
      s = s.replace(re, '');
    }
  }

  // Whitespace + dangling punctuatie weg.
  return s
    .replace(/\s+/g, ' ')
    .replace(/[\s,;:]+$/, '')
    .trim();
}

/**
 * Een minimale view op een bestaand event-row, genoeg om beslissingen
 * te nemen over wel/niet patchen van description en image.
 */
interface ExistingFilmEvent {
  id: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
}

/**
 * Laad alle bestaande Film+show events in een lookup-map gekeyed op
 * `normalizeFilmTitle(title)`. Bedoeld om aan het begin van een
 * scraper-run één keer aan te roepen.
 *
 * Bij collisions (twee bestaande events normaliseren naar dezelfde
 * key — dat zijn de huidige dupes) houden we de eerst-gevonden. De
 * merge-script ruimt die later op.
 */
export async function loadFilmDedupeMap(
  db: Db = dbDefault
): Promise<Map<string, ExistingFilmEvent>> {
  const rows = await db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      description: schema.events.description,
      imageUrl: schema.events.imageUrl,
    })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.category, 'Film'),
        eq(schema.events.kind, 'show')
      )
    );

  const map = new Map<string, ExistingFilmEvent>();
  for (const row of rows) {
    const key = normalizeFilmTitle(row.title);
    if (!key) continue;
    if (!map.has(key)) map.set(key, row);
  }
  return map;
}

interface FilmEventInput {
  /** Raw scraped title; wordt as-is opgeslagen bij een nieuwe insert. */
  title: string;
  /** Venue van deze scraper — wordt event.venueId bij een insert.
      Bij een hit op de map wordt deze NIET gebruikt; events houden hun
      oorspronkelijke event-venue. Per-occurrence venue wordt los gezet. */
  venueId: string;
  description?: string | null;
  imageUrl?: string | null;
  /** Optionele override op de slugify-prefix; default `film`. */
  slugPrefix?: string;
}

interface FilmEventResult {
  eventId: string;
  inserted: boolean;
}

/**
 * Vind een bestaand Film-event dat naar dezelfde search-key
 * normaliseert, of maak een nieuw event aan. Bij een hit:
 *   - Patcht description als die in de DB nog leeg is.
 *   - Vervangt imageUrl als die in de DB null is OF naar wiki(p|m)edia
 *     wijst (Wikipedia-thumbnails zijn 1:1.5, venue-stills zijn meestal
 *     mooier 16:9). Andere venue-stills laten we met rust.
 *
 * Bij een miss: insert een nieuwe row met de raw title als display, en
 * voeg 'm meteen aan de map toe zodat een volgende film in dezelfde
 * scraper-run ook al wordt gematched.
 */
export async function findOrCreateFilmEvent(
  map: Map<string, ExistingFilmEvent>,
  input: FilmEventInput,
  db: Db = dbDefault
): Promise<FilmEventResult> {
  const key = normalizeFilmTitle(input.title);
  if (!key) {
    throw new Error(`findOrCreateFilmEvent: lege title-key voor "${input.title}"`);
  }

  const existing = map.get(key);
  if (existing) {
    const patch: Partial<typeof schema.events.$inferInsert> = {};
    if (!existing.description && input.description) {
      patch.description = input.description;
    }
    if (
      input.imageUrl &&
      (!existing.imageUrl || /wiki(p|m)edia\.org/.test(existing.imageUrl))
    ) {
      patch.imageUrl = input.imageUrl;
    }
    // Display-titel: bij gelijke key kiest de kortste variant. Zo wint
    // "Anora" van "Anora (ENG SUBS)" of "Anora (4K Restoration)" voor
    // de display, ongeacht welke scraper eerst draait.
    if (input.title.length < existing.title.length) {
      patch.title = input.title;
    }
    if (Object.keys(patch).length > 0) {
      await db.update(schema.events).set(patch).where(eq(schema.events.id, existing.id));
      // Sync de cached row zodat een volgende film-call in dezelfde
      // scraper-run de patch ook ziet (en niet opnieuw probeert).
      if (patch.description !== undefined) existing.description = patch.description ?? null;
      if (patch.imageUrl !== undefined) existing.imageUrl = patch.imageUrl ?? null;
      if (patch.title !== undefined) existing.title = patch.title;
    }
    return { eventId: existing.id, inserted: false };
  }

  const prefix = input.slugPrefix ?? 'film';
  const eventId = `${prefix}-${slugify(input.title)}-${randomBytes(3).toString('hex')}`;
  await db.insert(schema.events).values({
    id: eventId,
    venueId: input.venueId,
    title: input.title,
    description: input.description ?? null,
    kind: 'show',
    imageUrl: input.imageUrl ?? null,
    category: 'Film',
  });
  map.set(key, {
    id: eventId,
    title: input.title,
    description: input.description ?? null,
    imageUrl: input.imageUrl ?? null,
  });
  return { eventId, inserted: true };
}

/**
 * Verwijder future-occurrences van `eventId`+`venueId` die niet in
 * `seenOccIds` zitten. Bedoeld om aan het eind van de per-film loop
 * stale occurrences op te ruimen die niet meer op de venue-pagina
 * staan (verschoven screening-id's, offline films, etc.).
 *
 * - Past alleen op `venueId`: een Eye-occurrence wordt nooit aangeraakt
 *   door de Studio/K-scraper, ook als beide aan hetzelfde event hangen.
 * - Past alleen op future (>= nowMs): geschiedenis blijft intact voor
 *   analytics/save-tracking.
 *
 * Returns aantal verwijderde rows.
 */
export async function pruneStaleOccurrences(
  args: {
    eventId: string;
    venueId: string;
    seenOccIds: Set<string>;
    nowMs: number;
  },
  db: Db = dbDefault
): Promise<number> {
  const existing = await db
    .select({ id: schema.occurrences.id })
    .from(schema.occurrences)
    .where(
      and(
        eq(schema.occurrences.eventId, args.eventId),
        eq(schema.occurrences.venueId, args.venueId),
        gte(schema.occurrences.startsAt, new Date(args.nowMs))
      )
    );

  const stale = existing
    .map((r) => r.id)
    .filter((id) => !args.seenOccIds.has(id));

  if (stale.length === 0) return 0;

  await db
    .delete(schema.occurrences)
    .where(inArray(schema.occurrences.id, stale));

  return stale.length;
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
