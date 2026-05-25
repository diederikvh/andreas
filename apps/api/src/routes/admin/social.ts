import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, lte, notInArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import { db, schema } from '../../db/index.js';
import { generateCaption } from '../../social/caption.js';
import { ensureFreshToken, publishCarousel } from '../../social/publisher.js';
import { renderCarousel, type CarouselPick } from '../../social/render.js';
import {
  THEMES,
  THEME_KEYS,
  getThemeByKey,
  getThemeForDate,
  type Theme,
  type ThemeKey,
} from '../../social/themes.js';
import { uploadToBunny } from '../../storage/bunny.js';
import { requireAdminAny } from './auth.js';

/**
 * Sociale automatisering — backend voor de IG-postgenerator.
 *
 * Fase 1 levert alleen `GET /picks?slot=evening`: een gescoorde lijst
 * van events die vanavond plaatsvinden, gededupliceerd tegen recent
 * geposte content, beperkt tot N picks (default 3) gespreid over
 * categorieën. Output is JSON — admin-UI en render-endpoint consumeren
 * 'm. Geen DB-writes hier; selectie is read-only en deterministisch
 * per (slot, tijd, dedup-state).
 *
 * Auth via Bearer of cookie (`requireAdminAny`).
 */

export const adminSocial = new Hono();

adminSocial.use('*', requireAdminAny);

const DEDUP_DAYS = 14;
/** Venue-cooldown: venues uit posts van de laatste N dagen krijgen een
    score-penalty zodat het aanbod rouleert. Soft (penalty), niet hard
    (exclude), zodat we bij weinig kandidaten geen lege carousel krijgen. */
const VENUE_COOLDOWN_DAYS = 7;
const VENUE_COOLDOWN_PENALTY = -0.5;

/** Eén post per dag, gepubliceerd om 16:00 Amsterdam. Vroeger 9:00 +
    17:00 morning/evening — vervangen door dag-themas (zie themes.ts). */
const PUBLISH_HOUR = 16;

/** Auto-expansie van het event-window: als de initial windowDays van een
    theme te weinig candidates oplevert, groeit 't venster in stappen
    tot maxWindowDays. Houdt de week-structuur leesbaar (bv. theater
    blijft theater) terwijl rustige weken nog steeds een post leveren. */
const WINDOW_EXPAND_STEP_DAYS = 7;

/** Minimum aantal candidates voordat we niet meer expanderen. Lager
    dan limit=4 zou betekenen dat we niet alle 4 slides kunnen vullen,
    maar dan accepteren we dat liever dan een wildgroei aan oude events. */
const MIN_CANDIDATES = 4;

function shortId(): string {
  return randomBytes(6).toString('hex');
}
/**
 * Scene-weight: lichte voorkeur voor alt-scenes in slots 1+, mainstream
 * komt al via de pin op slide 0. Bewust gecomprimeerd t.o.v. de oude
 * range (0.6→1.0) zodat saves- en featured-boost meer doorslag krijgen
 * en één scene (m.n. underground = OT301/OCCII) niet structureel kaapt.
 */
const SCENE_WEIGHT: Record<string, number> = {
  mainstream: 0.7,
  alternatief: 0.8,
  underground: 0.85,
  fringe: 0.75,
};

/** Bouwt de WHERE-clauses die uit een Theme volgen: categories +
    venueTypes-whitelist + exclude-list. Returns een array van Drizzle
    SQL-expressies die met `and(...)` in de hoofdquery gecombineerd
    worden. Leeg als de theme geen filter heeft (mixed). */
function whereClausesForTheme(theme: Theme) {
  const cls: ReturnType<typeof inArray>[] = [];
  if (theme.categories && theme.categories.length > 0) {
    cls.push(
      inArray(schema.events.category, [...theme.categories])
    );
  }
  if (theme.venueTypes && theme.venueTypes.length > 0) {
    cls.push(inArray(schema.venues.type, [...theme.venueTypes]));
  }
  if (theme.excludeVenueTypes && theme.excludeVenueTypes.length > 0) {
    cls.push(notInArray(schema.venues.type, [...theme.excludeVenueTypes]));
  }
  return cls;
}

/**
 * Bouwt een Date in Europe/Amsterdam tz vanuit Y-M-D h:m components.
 * Standaardtruc: genereer een UTC-guess, vergelijk hoe Intl 'm
 * formatteert in Amsterdam, corrigeer voor de offset.
 */
function inAmsterdamTz(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0
): Date {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(utcGuess);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const h = get('hour') === 24 ? 0 : get('hour');
  const amsAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), h, get('minute'));
  const offsetMs = amsAsUtc - utcGuess.getTime();
  return new Date(utcGuess.getTime() - offsetMs);
}

/** Y-M-D in Europe/Amsterdam voor een gegeven moment. */
function amsterdamYMD(at: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** Window vanuit een theme: nu → now + windowDays*24h. Voor 'tonight'
    is windowDays=1, voor weekly themes 7. Auto-expansie bij te weinig
    candidates zit in selectPicksForTheme. */
function computeWindowForTheme(
  theme: Theme,
  windowDaysOverride: number | null,
  now: Date
): { start: Date; end: Date } {
  const days = windowDaysOverride ?? theme.windowDays;
  const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  return { start: now, end };
}

interface Candidate {
  occurrenceId: string;
  startsAt: Date;
  endsAt: Date | null;
  eventId: string;
  title: string;
  description: string | null;
  imageUrl: string;
  category: string;
  featured: boolean;
  venueId: string;
  venueName: string;
  venueScene: string | null;
  venueType: string | null;
  venueInstagram: string | null;
  savesCount: number;
}

interface ScoredCandidate extends Candidate {
  score: number;
  breakdown: Record<string, number>;
}

function scoreCandidate(
  c: Candidate,
  opts: { venueCooldownSet: Set<string> } = { venueCooldownSet: new Set() }
): ScoredCandidate {
  const featuredBoost = c.featured ? 0.4 : 0;
  const sceneWeight = c.venueScene ? (SCENE_WEIGHT[c.venueScene] ?? 0.5) : 0.5;
  const sceneScore = 0.3 * sceneWeight;
  const savesScore = 0.2 * Math.min(c.savesCount / 10, 1);
  const cooldownPenalty = opts.venueCooldownSet.has(c.venueId)
    ? VENUE_COOLDOWN_PENALTY
    : 0;
  const score = featuredBoost + sceneScore + savesScore + cooldownPenalty;
  return {
    ...c,
    score,
    breakdown: {
      featured: featuredBoost,
      scene: sceneScore,
      saves: savesScore,
      cooldown: cooldownPenalty,
    },
  };
}

/**
 * Slide 0 = mainstream-hook: het bekendere event dat herkenning triggert
 * bij scrollers (Paradiso/Melkweg/Concertgebouw/Stedelijk). Slides 1..N
 * gaan ruimer — alternatief/underground/fringe als verdieping na de hook.
 *
 * Volgorde:
 *  1. Pin: hoogst-scorende mainstream event (al gerouleerd door cooldown).
 *  2. Spread: top-score, 1 per venue, 1 per category.
 *  3. Fallback 1: venue-uniek maar cat-dupes toegestaan.
 *  4. Fallback 2: alles toegestaan (last resort, bij erg dun aanbod).
 *
 * Geen mainstream beschikbaar? Dan begint stap 2 meteen en is de eerste
 * pick een alt-scene event — niet ideaal maar beter dan een lege post.
 */
function pickWithSpread(scored: ScoredCandidate[], limit: number): ScoredCandidate[] {
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const picked: ScoredCandidate[] = [];
  const seenCats = new Set<string>();
  const seenVenues = new Set<string>();

  const hook = sorted.find((c) => c.venueScene === 'mainstream');
  if (hook) {
    picked.push(hook);
    seenCats.add(hook.category);
    seenVenues.add(hook.venueId);
  }

  for (const c of sorted) {
    if (picked.length >= limit) break;
    if (picked.some((p) => p.occurrenceId === c.occurrenceId)) continue;
    if (seenCats.has(c.category) || seenVenues.has(c.venueId)) continue;
    picked.push(c);
    seenCats.add(c.category);
    seenVenues.add(c.venueId);
  }

  if (picked.length < limit) {
    for (const c of sorted) {
      if (picked.length >= limit) break;
      if (picked.some((p) => p.occurrenceId === c.occurrenceId)) continue;
      if (seenVenues.has(c.venueId)) continue;
      picked.push(c);
      seenVenues.add(c.venueId);
    }
  }

  if (picked.length < limit) {
    for (const c of sorted) {
      if (picked.length >= limit) break;
      if (picked.some((p) => p.occurrenceId === c.occurrenceId)) continue;
      picked.push(c);
    }
  }
  return picked;
}

/** Parse `?skip=evt-a,evt-b` query param naar een Set van event-IDs die
    uit candidates moeten worden gefilterd. Handig voor preview om door
    de top-N picks te kunnen rouleren zonder de DB aan te raken. */
function parseSkipParam(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  );
}

interface SelectResult {
  picks: ScoredCandidate[];
  candidateCount: number;
  window: { start: Date; end: Date };
  windowDays: number;
  dedupExcluded: number;
  theme: Theme;
}

/**
 * Selectie-pipeline per theme:
 *  1. Dedup-set + venue-cooldown ophalen (zelfde als voorheen).
 *  2. Kandidaten ophalen met theme-filter (categories + venueTypes).
 *  3. Window-expansie: te weinig candidates? Verleng windowDays met
 *     WINDOW_EXPAND_STEP_DAYS tot we MIN_CANDIDATES halen of de
 *     theme's maxWindowDays bereikt is.
 *  4. Scoren + pick-with-spread (mainstream-hook + venue-dedup).
 */
async function selectPicksForTheme(
  theme: Theme,
  options: { limit: number; skipIds: Set<string>; now: Date }
): Promise<SelectResult> {
  const { limit, skipIds, now } = options;
  const dedupSince = new Date(now.getTime() - DEDUP_DAYS * 24 * 60 * 60 * 1000);
  const cooldownSince = new Date(
    now.getTime() - VENUE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000
  );

  const recentlyPosted = await db
    .select({
      eventIds: schema.socialPosts.eventIds,
      postedAt: schema.socialPosts.postedAt,
    })
    .from(schema.socialPosts)
    .where(
      and(
        eq(schema.socialPosts.status, 'posted'),
        gte(schema.socialPosts.postedAt, dedupSince)
      )
    );
  const dedupSet = new Set(recentlyPosted.flatMap((r) => r.eventIds));
  for (const id of skipIds) dedupSet.add(id);

  const cooldownEventIds = recentlyPosted
    .filter((r) => r.postedAt && r.postedAt >= cooldownSince)
    .flatMap((r) => r.eventIds);
  const venueCooldownSet = new Set<string>();
  if (cooldownEventIds.length > 0) {
    const venueRows = await db
      .select({ venueId: schema.events.venueId })
      .from(schema.events)
      .where(inArray(schema.events.id, cooldownEventIds));
    for (const r of venueRows) venueCooldownSet.add(r.venueId);
  }

  const themeWhere = whereClausesForTheme(theme);

  async function fetchCandidates(windowDays: number): Promise<Candidate[]> {
    const window = computeWindowForTheme(theme, windowDays, now);
    return (await db
      .select({
        occurrenceId: schema.occurrences.id,
        startsAt: schema.occurrences.startsAt,
        endsAt: schema.occurrences.endsAt,
        eventId: schema.events.id,
        title: schema.events.title,
        description: schema.events.description,
        imageUrl: schema.events.imageUrl,
        category: schema.events.category,
        featured: schema.events.featured,
        venueId: schema.venues.id,
        venueName: schema.venues.name,
        venueScene: schema.venues.scene,
        venueType: schema.venues.type,
        venueInstagram: schema.venues.instagram,
        savesCount: sql<number>`(SELECT COUNT(*)::int FROM saves WHERE saves.occurrence_id = ${schema.occurrences.id})`.as('saves_count'),
      })
      .from(schema.occurrences)
      .innerJoin(schema.events, eq(schema.events.id, schema.occurrences.eventId))
      .innerJoin(schema.venues, eq(schema.venues.id, schema.events.venueId))
      .where(
        and(
          eq(schema.events.published, true),
          eq(schema.venues.published, true),
          isNotNull(schema.events.imageUrl),
          eq(schema.occurrences.status, 'scheduled'),
          gte(schema.occurrences.startsAt, window.start),
          lt(schema.occurrences.startsAt, window.end),
          ...themeWhere
        )
      )
      .orderBy(schema.occurrences.startsAt)) as Candidate[];
  }

  // Window-expansie loop
  let windowDays = theme.windowDays;
  let perEvent: Candidate[] = [];
  while (true) {
    const rows = await fetchCandidates(windowDays);
    const seen = new Set<string>();
    perEvent = [];
    for (const row of rows) {
      if (seen.has(row.eventId)) continue;
      if (dedupSet.has(row.eventId)) continue;
      if (!row.imageUrl) continue;
      perEvent.push(row);
      seen.add(row.eventId);
    }
    if (perEvent.length >= MIN_CANDIDATES) break;
    if (windowDays >= theme.maxWindowDays) break;
    windowDays = Math.min(windowDays + WINDOW_EXPAND_STEP_DAYS, theme.maxWindowDays);
  }

  const finalWindow = computeWindowForTheme(theme, windowDays, now);
  const scored = perEvent.map((c) => scoreCandidate(c, { venueCooldownSet }));
  const picks = pickWithSpread(scored, limit);

  return {
    picks,
    candidateCount: perEvent.length,
    window: finalWindow,
    windowDays,
    dedupExcluded: dedupSet.size,
    theme,
  };
}

/** Resolveer een theme uit een query-string (?theme=<key>) of val
    terug op de auto-detect via vandaag-in-Amsterdam. Returns null
    als een expliciete key niet matcht. */
function resolveTheme(themeParam: string | undefined): Theme | null {
  if (themeParam) return getThemeByKey(themeParam);
  return getThemeForDate(new Date());
}

adminSocial.get('/picks', async (c) => {
  const theme = resolveTheme(c.req.query('theme'));
  if (!theme) {
    return c.json(
      { error: 'invalid theme', validKeys: THEME_KEYS },
      400
    );
  }
  const limit = Math.max(1, Math.min(10, Number(c.req.query('limit') ?? '4')));
  const debug = c.req.query('debug') === '1';
  const skipIds = parseSkipParam(c.req.query('skip'));

  const now = new Date();
  const { picks, candidateCount, window, windowDays, dedupExcluded } =
    await selectPicksForTheme(theme, { limit, skipIds, now });

  return c.json({
    theme: { key: theme.key, label: theme.label, windowLabel: theme.windowLabel, windowDays },
    window: { start: window.start.toISOString(), end: window.end.toISOString() },
    generatedAt: now.toISOString(),
    candidateCount,
    picks: picks.map((p) => ({
      occurrenceId: p.occurrenceId,
      eventId: p.eventId,
      title: p.title,
      venue: { id: p.venueId, name: p.venueName, scene: p.venueScene, type: p.venueType },
      category: p.category,
      featured: p.featured,
      imageUrl: p.imageUrl,
      startsAt: p.startsAt,
      endsAt: p.endsAt,
      savesCount: p.savesCount,
      score: Number(p.score.toFixed(3)),
      ...(debug ? { breakdown: p.breakdown } : {}),
    })),
    ...(debug ? { dedupExcluded } : {}),
  });
});

// ─── Caption ─────────────────────────────────────────────────────────────

adminSocial.post('/caption', async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { picks?: unknown; date?: string }
    | null;
  if (!body || !Array.isArray(body.picks) || body.picks.length === 0) {
    return c.json({ error: 'invalid body: { picks: [...] } required' }, 400);
  }
  const date = body.date ? new Date(body.date) : new Date();
  if (isNaN(date.getTime())) return c.json({ error: 'invalid date' }, 400);

  // Picks lichtgewicht valideren — alleen velden die caption nodig heeft.
  const captionPicks = body.picks
    .map((p: unknown) => {
      if (typeof p !== 'object' || p === null) return null;
      const o = p as Record<string, unknown>;
      if (typeof o.title !== 'string' || typeof o.venueName !== 'string') return null;
      const startsAt =
        typeof o.startsAt === 'string'
          ? new Date(o.startsAt)
          : o.startsAt instanceof Date
            ? o.startsAt
            : null;
      if (!startsAt || isNaN(startsAt.getTime())) return null;
      const endsAt =
        typeof o.endsAt === 'string'
          ? new Date(o.endsAt)
          : o.endsAt instanceof Date
            ? o.endsAt
            : null;
      return {
        title: o.title,
        venueName: o.venueName,
        venueType: typeof o.venueType === 'string' ? o.venueType : null,
        venueInstagram:
          typeof o.venueInstagram === 'string' ? o.venueInstagram : null,
        category: typeof o.category === 'string' ? o.category : '',
        startsAt,
        endsAt: endsAt && !isNaN(endsAt.getTime()) ? endsAt : null,
      };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);

  if (captionPicks.length === 0) {
    return c.json({ error: 'no valid picks' }, 400);
  }

  const result = await generateCaption({ picks: captionPicks, date });
  return c.json(result);
});

// ─── Render ──────────────────────────────────────────────────────────────
//
// Twee endpoints:
//   POST /render            — production: rendert + upload naar Bunny,
//                             returnt image-URLs. Body: { date?, picks }.
//   GET  /preview?slot=…    — dev: rendert in geheugen, returnt een
//                             HTML-page met inline data:-URIs. Geen Bunny.

interface RenderBodyPick {
  imageUrl: string;
  title: string;
  venueName: string;
  category: string;
  venueType: string | null;
  startsAt: string;
  endsAt: string | null;
}

function isRenderBodyPick(v: unknown): v is RenderBodyPick {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.imageUrl === 'string' &&
    typeof o.title === 'string' &&
    typeof o.venueName === 'string' &&
    typeof o.category === 'string' &&
    (o.venueType === null || typeof o.venueType === 'string') &&
    typeof o.startsAt === 'string' &&
    (o.endsAt === null || typeof o.endsAt === 'string')
  );
}

adminSocial.post('/render', async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { picks?: unknown; date?: string; uploadPrefix?: string }
    | null;
  if (!body || !Array.isArray(body.picks) || !body.picks.every(isRenderBodyPick)) {
    return c.json({ error: 'invalid body: { picks: RenderBodyPick[] } required' }, 400);
  }
  const date = body.date ? new Date(body.date) : new Date();
  if (isNaN(date.getTime())) return c.json({ error: 'invalid date' }, 400);

  const slides = await renderCarousel(body.picks as CarouselPick[], { date });

  // Upload-pad: media/social/YYYY-MM-DD/{prefix}-{n}.png
  const ymd = date.toISOString().slice(0, 10);
  const prefix = (body.uploadPrefix ?? 'carousel').replace(/[^a-z0-9-]/gi, '');
  const urls = await Promise.all(
    slides.map((buf, i) =>
      uploadToBunny(`media/social/${ymd}/${prefix}-${i}.png`, buf, 'image/png')
    )
  );

  return c.json({
    slideCount: slides.length,
    imageUrls: urls,
    bytes: slides.map((b) => b.length),
  });
});

/** Dev-preview: picks ophalen + renderen + inline tonen in HTML.
    Ondersteunt `?theme=<key>` om met een specifiek dag-thema te
    previewen (anders auto-vandaag) en `?skip=eventId,…` om door
    alternatieven te rollen. */
adminSocial.get('/preview', async (c) => {
  const theme = resolveTheme(c.req.query('theme'));
  if (!theme) {
    return c.html(
      `<p>invalid theme. valid: ${THEME_KEYS.join(', ')}</p>`,
      400
    );
  }
  const skipIds = parseSkipParam(c.req.query('skip'));
  const now = new Date();
  const { picks, window, windowDays } = await selectPicksForTheme(theme, {
    limit: 4,
    skipIds,
    now,
  });
  if (picks.length === 0) {
    return c.html(
      `<p>geen picks voor theme=${theme.key} in window ${window.start.toISOString()}–${window.end.toISOString()} (windowDays=${windowDays}, max=${theme.maxWindowDays})</p>`
    );
  }

  const [slides, captionResult] = await Promise.all([
    renderCarousel(
      picks.map((p) => ({
        imageUrl: p.imageUrl,
        title: p.title,
        venueName: p.venueName,
        category: p.category,
        venueType: p.venueType,
        startsAt: p.startsAt,
        endsAt: p.endsAt,
      })),
      {
        date: now,
        themeLabel: theme.label.nl,
        windowLabel: theme.windowLabel.nl,
      }
    ),
    generateCaption({
      date: now,
      picks: picks.map((p) => ({
        title: p.title,
        venueName: p.venueName,
        venueType: p.venueType,
        venueInstagram: p.venueInstagram,
        category: p.category,
        startsAt: p.startsAt,
      })),
    }),
  ]);

  const skipBase = `?theme=${theme.key}`;
  const imgTags = slides
    .map((buf, i) => {
      const pick = i < picks.length ? picks[i] : null;
      const caption = pick
        ? `<a href="${skipBase}&skip=${encodeURIComponent([...skipIds, pick.eventId].join(','))}" style="color:#5a4e3f;text-decoration:none">${pick.eventId}<br/><span style="color:#a89c84">skip →</span></a>`
        : 'outro';
      return `<figure style="margin:0"><img src="data:image/png;base64,${buf.toString('base64')}" style="width:360px;height:auto;display:block;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,0.18)"/><figcaption style="margin-top:8px;font:13px/1.3 ui-monospace,Menlo,monospace;color:#5a4e3f">${caption}</figcaption></figure>`;
    })
    .join('');

  const skipLinks =
    skipIds.size > 0
      ? `<span style="font-size:13px;color:#5a4e3f">· ${skipIds.size} geskipt · <a href="${skipBase}" style="color:#c9453a">reset</a></span>`
      : '';

  const themeNav = THEMES.map((t) =>
    t.key === theme.key
      ? `<strong>${t.key}</strong>`
      : `<a href="?theme=${t.key}" style="color:#5a4e3f;text-decoration:none">${t.key}</a>`
  ).join(' · ');

  const escapeHtml = (s: string) =>
    s.replace(/[&<>"']/g, (c) =>
      c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
    );

  const captionBlock = `
<section class="caption">
  <h2>Caption <small>(${captionResult.source})</small></h2>
  <pre>${escapeHtml(captionResult.caption)}</pre>
</section>`;

  return c.html(`<!doctype html>
<html><head><meta charset="utf-8"><title>social preview — ${theme.key}</title>
<style>
  body { margin:0; padding:32px; background:#ebe6d8; font-family:ui-sans-serif,system-ui; color:#1a1410 }
  header { display:flex; align-items:baseline; gap:16px; margin-bottom:24px; flex-wrap:wrap }
  header h1 { margin:0; font-size:22px }
  header span { font-size:13px; color:#5a4e3f }
  .themes { font-size:12px; color:#5a4e3f; margin-bottom:18px }
  .grid { display:flex; flex-wrap:wrap; gap:24px; align-items:flex-start }
  figure a:hover { color:#c9453a !important }
  .caption { margin:0 0 28px 0; padding:20px 24px; background:#f5f1e8; border-radius:12px; max-width:720px }
  .caption h2 { margin:0 0 12px 0; font-size:15px; font-weight:600; letter-spacing:0.5px; text-transform:uppercase; color:#5a4e3f }
  .caption h2 small { font-weight:500; letter-spacing:0; text-transform:none; color:#a89c84; margin-left:6px }
  .caption pre { margin:0; font:15px/1.45 ui-sans-serif,system-ui; white-space:pre-wrap; color:#1a1410 }
</style>
</head><body>
<header>
  <h1>Social preview — ${theme.label.nl}</h1>
  <span>${theme.windowLabel.nl} · ${picks.length} picks · windowDays=${windowDays}</span>
  ${skipLinks}
</header>
<div class="themes">themes: ${themeNav}</div>
${captionBlock}
<div class="grid">${imgTags}</div>
</body></html>`);
});

// ─── Posts (DB-backed drafts) ────────────────────────────────────────────
//
// Generate / approve / skip / regenerate flow voor mens-in-de-loop
// publicatie. `/generate` is de zware operatie (selectie + render +
// upload + caption), de andere zijn light state-transities.

/** Bouwt de scheduled_for-Date voor de huidige dag in Europe/Amsterdam
    (= het tijdstip waarop de publish-cron 'm oppakt). Eén post per dag,
    16:00 NL. */
function computeScheduledFor(now: Date): Date {
  const { year, month, day } = amsterdamYMD(now);
  return inAmsterdamTz(year, month, day, PUBLISH_HOUR, 0);
}

interface PersistedPost {
  id: string;
  slot: string;
  status: string;
  scheduledFor: Date;
  createdAt: Date;
  updatedAt: Date;
  postedAt: Date | null;
  caption: string | null;
  imageUrls: string[];
  eventIds: string[];
  igMediaId: string | null;
  error: string | null;
  meta: {
    occurrenceIds?: string[];
    templateVersion?: string;
    scoreBreakdown?: Record<string, number>;
    skippedEventIds?: string[];
    permalink?: string;
    themeKey?: ThemeKey;
    windowDays?: number;
  } | null;
}

export async function runGenerate(
  theme: Theme,
  options: { skipIds?: Set<string>; existingId?: string } = {}
): Promise<{ post: PersistedPost; warnings: string[] }> {
  const warnings: string[] = [];
  const now = new Date();
  const { picks, windowDays } = await selectPicksForTheme(theme, {
    limit: 4,
    skipIds: options.skipIds ?? new Set(),
    now,
  });
  if (picks.length === 0) {
    throw new Error(`geen picks voor theme=${theme.key} in huidig window`);
  }

  // 1. Render slides (theme + window-label als kicker op elke slide)
  const slides = await renderCarousel(
    picks.map((p) => ({
      imageUrl: p.imageUrl,
      title: p.title,
      venueName: p.venueName,
      category: p.category,
      venueType: p.venueType,
      startsAt: p.startsAt,
      endsAt: p.endsAt,
    })),
    {
      date: now,
      themeLabel: theme.label.nl,
      windowLabel: theme.windowLabel.nl,
    }
  );

  // 2. Upload elke slide naar Bunny — pad bevat een generatie-marker (epoch in base36)
  //    zodat regenerates verse URLs opleveren en de browser-cache niet de
  //    oude PNG blijft tonen. Pad: media/social/YYYY-MM-DD/<id>-<gen>-<n>.png
  const ymd = now.toISOString().slice(0, 10);
  const postId = options.existingId ?? `sp-${shortId()}`;
  const generation = now.getTime().toString(36);
  const imageUrls = await Promise.all(
    slides.map((buf, i) =>
      uploadToBunny(
        `media/social/${ymd}/${postId}-${generation}-${i}.png`,
        buf,
        'image/png'
      )
    )
  );

  // 3. Caption parallel ophalen
  const captionResult = await generateCaption({
    date: now,
    picks: picks.map((p) => ({
      title: p.title,
      venueName: p.venueName,
      venueType: p.venueType,
      venueInstagram: p.venueInstagram,
      category: p.category,
      startsAt: p.startsAt,
      endsAt: p.endsAt,
    })),
  });
  if (captionResult.source === 'fallback') {
    warnings.push('caption gebruikt fallback-template (Claude niet bereikt)');
  }

  const scheduledFor = computeScheduledFor(now);
  const eventIds = picks.map((p) => p.eventId);

  const skippedEventIds = options.skipIds ? [...options.skipIds] : [];

  // 4. Persist — INSERT of UPDATE. `slot`-kolom (legacy) krijgt nu de
  // theme-key zodat oude dedup-/sort-queries blijven werken zonder
  // schema-migratie.
  if (options.existingId) {
    await db
      .update(schema.socialPosts)
      .set({
        eventIds,
        imageUrls,
        caption: captionResult.caption,
        scheduledFor,
        status: 'draft',
        error: null,
        slot: theme.key,
        meta: {
          occurrenceIds: picks.map((p) => p.occurrenceId),
          templateVersion: '2',
          skippedEventIds,
          themeKey: theme.key,
          windowDays,
        },
        updatedAt: now,
      })
      .where(eq(schema.socialPosts.id, options.existingId));
  } else {
    await db.insert(schema.socialPosts).values({
      id: postId,
      slot: theme.key,
      eventIds,
      imageUrls,
      caption: captionResult.caption,
      scheduledFor,
      status: 'draft',
      meta: {
        occurrenceIds: picks.map((p) => p.occurrenceId),
        templateVersion: '2',
        skippedEventIds,
        themeKey: theme.key,
        windowDays,
      },
      createdAt: now,
      updatedAt: now,
    });
  }

  const [persisted] = await db
    .select()
    .from(schema.socialPosts)
    .where(eq(schema.socialPosts.id, postId));

  return {
    post: persisted as PersistedPost,
    warnings,
  };
}

/** Genereer een nieuw concept-post voor een theme. Default: vandaag's
    theme (auto-gekozen via Amsterdam-weekday). `?theme=<key>` overschrijft
    dat (handig voor handmatig regenereren van een specifieke dag). */
adminSocial.post('/generate', async (c) => {
  const theme = resolveTheme(c.req.query('theme'));
  if (!theme) {
    return c.json({ error: 'invalid theme', validKeys: THEME_KEYS }, 400);
  }
  try {
    const { post, warnings } = await runGenerate(theme);
    return c.json({ post, warnings });
  } catch (e) {
    const msg = (e as Error).message;
    // Geen candidates is voor de cron een normaal no-op (bv. zomers
    // weekend zonder galleries). Return 200 zodat GH-workflow niet
    // als failure markeert.
    if (msg.startsWith('geen picks voor theme=')) {
      return c.json({
        skipped: true,
        reason: 'no_candidates',
        theme: theme.key,
      });
    }
    return c.json({ error: msg }, 500);
  }
});

/** Lijst alle posts (newest first, paginated). */
adminSocial.get('/posts', async (c) => {
  const limit = Math.max(1, Math.min(100, Number(c.req.query('limit') ?? '50')));
  const rows = await db
    .select()
    .from(schema.socialPosts)
    .orderBy(desc(schema.socialPosts.createdAt))
    .limit(limit);
  return c.json({ posts: rows });
});

/** Approve een draft. */
adminSocial.post('/posts/:id/approve', async (c) => {
  const id = c.req.param('id');
  const [updated] = await db
    .update(schema.socialPosts)
    .set({ status: 'approved', updatedAt: new Date() })
    .where(and(eq(schema.socialPosts.id, id), eq(schema.socialPosts.status, 'draft')))
    .returning();
  if (!updated) return c.json({ error: 'not found or not draft' }, 404);
  return c.json({ post: updated });
});

/**
 * Publiceert een approved post naar Instagram. Updatet status naar
 * 'posted' bij succes (met ig_media_id + posted_at), naar 'failed' bij
 * fout (met error-message). Idempotent: een al-geposte post wordt
 * niet opnieuw gepubliceerd.
 */
export async function runPublish(
  id: string,
): Promise<{ post: PersistedPost; igMediaId: string }> {
  const [post] = await db
    .select()
    .from(schema.socialPosts)
    .where(eq(schema.socialPosts.id, id));
  if (!post) throw new Error('post niet gevonden');
  if (post.status === 'posted') {
    throw new Error('post is al gepubliceerd (ig_media_id=' + post.igMediaId + ')');
  }
  if (post.status !== 'approved') {
    throw new Error(`alleen goedgekeurde posts kunnen worden gepubliceerd (status=${post.status})`);
  }
  if (!post.caption) throw new Error('post heeft geen caption');
  if (post.imageUrls.length === 0) throw new Error('post heeft geen slides');

  try {
    const { igMediaId, permalink } = await publishCarousel({
      imageUrls: post.imageUrls,
      caption: post.caption,
    });
    const now = new Date();
    const mergedMeta = {
      ...(post.meta ?? {}),
      ...(permalink ? { permalink } : {}),
    };
    const [updated] = await db
      .update(schema.socialPosts)
      .set({
        status: 'posted',
        igMediaId,
        postedAt: now,
        error: null,
        meta: mergedMeta,
        updatedAt: now,
      })
      .where(eq(schema.socialPosts.id, id))
      .returning();
    return { post: updated as PersistedPost, igMediaId };
  } catch (e) {
    const msg = (e as Error).message;
    await db
      .update(schema.socialPosts)
      .set({ status: 'failed', error: msg, updatedAt: new Date() })
      .where(eq(schema.socialPosts.id, id));
    throw e;
  }
}

/**
 * IG token refresh-check. Veilig dagelijks aan te roepen — refresht
 * alleen als 't binnen 7d vervalt. `force=1` forceert hoe dan ook
 * (alleen handig voor handmatige debugging).
 *
 * Wordt aangeroepen door de GitHub Actions cron als veiligheidsnet —
 * de publisher zelf doet ook al lazy refresh-on-use.
 */
adminSocial.post('/refresh-token', async (c) => {
  const force = c.req.query('force') === '1';
  try {
    const row = await ensureFreshToken({ force });
    const daysLeft = Math.round(
      (row.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000),
    );
    return c.json({
      ok: true,
      expiresAt: row.expiresAt.toISOString(),
      refreshedAt: row.refreshedAt.toISOString(),
      daysLeft,
    });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

adminSocial.post('/posts/:id/publish', async (c) => {
  const id = c.req.param('id');
  try {
    const result = await runPublish(id);
    return c.json(result);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

/**
 * Publiceer alle approved posts waarvan de geplande tijd verstreken
 * is. Gebruikt door de scheduler-cron (elke 15 min) zodat Diederik
 * 's ochtends in 1x kan approven en de posts vanzelf op de juiste
 * tijd verschijnen.
 *
 * Sequentieel om Meta-rate-limits te respecteren en om bij 1 fout
 * niet de andere kapot te maken (foutmelding per post terug).
 */
adminSocial.post('/publish-due', async (c) => {
  const now = new Date();
  const due = (await db
    .select()
    .from(schema.socialPosts)
    .where(
      and(
        eq(schema.socialPosts.status, 'approved'),
        lte(schema.socialPosts.scheduledFor, now),
      ),
    )
    .orderBy(asc(schema.socialPosts.scheduledFor))) as Array<{
    id: string;
    scheduledFor: Date;
  }>;

  const results: Array<{
    id: string;
    ok: boolean;
    igMediaId?: string;
    error?: string;
  }> = [];
  for (const post of due) {
    try {
      const { igMediaId } = await runPublish(post.id);
      results.push({ id: post.id, ok: true, igMediaId });
    } catch (e) {
      results.push({ id: post.id, ok: false, error: (e as Error).message });
    }
  }
  return c.json({
    now: now.toISOString(),
    count: due.length,
    published: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  });
});

/** Regenerate — vervangt slides + caption + scheduled_for op bestaande
    post (alleen toegestaan in draft-status). De theme wordt afgeleid
    uit `meta.themeKey` of (fallback) uit de `slot`-kolom als die een
    geldige theme-key bevat; oude 'morning'/'evening' fall back op de
    auto-detect van vandaag. */
adminSocial.post('/posts/:id/regenerate', async (c) => {
  const id = c.req.param('id');
  const skipIds = parseSkipParam(c.req.query('skip'));
  const [existing] = await db
    .select()
    .from(schema.socialPosts)
    .where(eq(schema.socialPosts.id, id));
  if (!existing) return c.json({ error: 'not found' }, 404);
  if (existing.status !== 'draft') {
    return c.json({ error: 'alleen drafts kunnen regenerated worden' }, 400);
  }
  const themeKey =
    (existing.meta?.themeKey as string | undefined) ?? existing.slot;
  const theme = getThemeByKey(themeKey) ?? getThemeForDate(new Date());
  try {
    const { post, warnings } = await runGenerate(theme, {
      skipIds,
      existingId: id,
    });
    return c.json({ post, warnings });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});
