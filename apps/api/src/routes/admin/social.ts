import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, gte, isNotNull, lt, lte, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import { db, schema } from '../../db/index.js';
import { generateCaption } from '../../social/caption.js';
import { ensureFreshToken, publishCarousel } from '../../social/publisher.js';
import { renderCarousel, type CarouselPick } from '../../social/render.js';
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

export type Slot = 'morning' | 'afternoon' | 'evening';
export const SLOTS: readonly Slot[] = ['morning', 'afternoon', 'evening'];

const DEDUP_DAYS = 14;

/** Publicatie-tijd per slot (in Europe/Amsterdam local hours, op de
    dag van generatie). De cron die approved posts publiceert pakt
    alles waar scheduled_for valt in een venster rond deze tijd. */
const SLOT_PUBLISH_HOUR: Record<Slot, number> = {
  morning: 9,
  afternoon: 14,
  evening: 19,
};

function shortId(): string {
  return randomBytes(6).toString('hex');
}
const SCENE_WEIGHT: Record<string, number> = {
  mainstream: 0.6,
  alternatief: 0.8,
  underground: 1.0,
  fringe: 0.7,
};

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

/**
 * Time-window per slot:
 *  - evening: vanaf max(now, vandaag 18:00 Amsterdam) tot morgen 06:00
 *    Amsterdam (logical-day-boundary).
 *  - morning: vandaag 06:00–18:00 (overdag-content: galleries, theater,
 *    expos).
 *  - afternoon: identiek aan evening (carousel-content over vanavond).
 *
 * Voor fase 1 implementeren we alleen evening + afternoon meaningful;
 * morning krijgt een placeholder-window.
 */
function computeWindow(slot: Slot, now: Date): { start: Date; end: Date } {
  const { year, month, day } = amsterdamYMD(now);
  if (slot === 'morning') {
    const start = inAmsterdamTz(year, month, day, 6, 0);
    const end = inAmsterdamTz(year, month, day, 18, 0);
    return { start: start < now ? now : start, end };
  }
  // evening + afternoon: vanavond-window
  const tonightStart = inAmsterdamTz(year, month, day, 18, 0);
  const tomorrowMorning = new Date(inAmsterdamTz(year, month, day, 6, 0).getTime() + 24 * 60 * 60 * 1000);
  return {
    start: tonightStart < now ? now : tonightStart,
    end: tomorrowMorning,
  };
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

function scoreCandidate(c: Candidate): ScoredCandidate {
  const featuredBoost = c.featured ? 0.4 : 0;
  const sceneWeight = c.venueScene ? (SCENE_WEIGHT[c.venueScene] ?? 0.5) : 0.5;
  const sceneScore = 0.3 * sceneWeight;
  const savesScore = 0.2 * Math.min(c.savesCount / 10, 1);
  const score = featuredBoost + sceneScore + savesScore;
  return {
    ...c,
    score,
    breakdown: {
      featured: featuredBoost,
      scene: sceneScore,
      saves: savesScore,
    },
  };
}

/**
 * Greedy spread: pak top-scorende items, maar maximaal 1 per
 * categorie en 1 per venue, totdat we N hebben. Als we N niet halen
 * binnen die constraint, vullen we aan met overgebleven top-scorers.
 */
function pickWithSpread(scored: ScoredCandidate[], limit: number): ScoredCandidate[] {
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const picked: ScoredCandidate[] = [];
  const seenCats = new Set<string>();
  const seenVenues = new Set<string>();
  for (const c of sorted) {
    if (picked.length >= limit) break;
    if (seenCats.has(c.category) || seenVenues.has(c.venueId)) continue;
    picked.push(c);
    seenCats.add(c.category);
    seenVenues.add(c.venueId);
  }
  if (picked.length < limit) {
    for (const c of sorted) {
      if (picked.length >= limit) break;
      if (picked.find((p) => p.occurrenceId === c.occurrenceId)) continue;
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
  dedupExcluded: number;
}

/**
 * Gedeelde selectie-pipeline: dedup, kandidaten ophalen, scoren,
 * greedy spread. Gebruikt door /picks (JSON), /preview (debug-HTML) en
 * /generate (DB-write).
 */
async function selectPicksForSlot(
  slot: Slot,
  options: { limit: number; skipIds: Set<string>; now: Date }
): Promise<SelectResult> {
  const { limit, skipIds, now } = options;
  const window = computeWindow(slot, now);
  const dedupSince = new Date(now.getTime() - DEDUP_DAYS * 24 * 60 * 60 * 1000);

  const recentlyPosted = await db
    .select({ eventIds: schema.socialPosts.eventIds })
    .from(schema.socialPosts)
    .where(
      and(
        eq(schema.socialPosts.status, 'posted'),
        gte(schema.socialPosts.postedAt, dedupSince)
      )
    );
  const dedupSet = new Set(recentlyPosted.flatMap((r) => r.eventIds));
  for (const id of skipIds) dedupSet.add(id);

  const rows = (await db
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
        lt(schema.occurrences.startsAt, window.end)
      )
    )
    .orderBy(schema.occurrences.startsAt)) as Candidate[];

  const seen = new Set<string>();
  const perEvent: Candidate[] = [];
  for (const row of rows) {
    if (seen.has(row.eventId)) continue;
    if (dedupSet.has(row.eventId)) continue;
    if (!row.imageUrl) continue;
    perEvent.push(row);
    seen.add(row.eventId);
  }
  const scored = perEvent.map(scoreCandidate);
  const picks = pickWithSpread(scored, limit);

  return {
    picks,
    candidateCount: perEvent.length,
    window,
    dedupExcluded: dedupSet.size,
  };
}

adminSocial.get('/picks', async (c) => {
  const slotParam = (c.req.query('slot') ?? 'evening') as string;
  if (!(SLOTS as readonly string[]).includes(slotParam)) {
    return c.json({ error: 'invalid slot' }, 400);
  }
  const slot = slotParam as Slot;
  const limit = Math.max(1, Math.min(10, Number(c.req.query('limit') ?? '3')));
  const debug = c.req.query('debug') === '1';
  const skipIds = parseSkipParam(c.req.query('skip'));

  const now = new Date();
  const { picks, candidateCount, window, dedupExcluded } = await selectPicksForSlot(slot, {
    limit,
    skipIds,
    now,
  });

  return c.json({
    slot,
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
      return {
        title: o.title,
        venueName: o.venueName,
        venueType: typeof o.venueType === 'string' ? o.venueType : null,
        venueInstagram:
          typeof o.venueInstagram === 'string' ? o.venueInstagram : null,
        category: typeof o.category === 'string' ? o.category : '',
        startsAt,
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
    Ondersteunt `?skip=eventId1,eventId2` om door alternatieven te rollen. */
adminSocial.get('/preview', async (c) => {
  const slotParam = (c.req.query('slot') ?? 'evening') as string;
  if (!(SLOTS as readonly string[]).includes(slotParam)) {
    return c.html('<p>invalid slot</p>', 400);
  }
  const slot = slotParam as Slot;
  const skipIds = parseSkipParam(c.req.query('skip'));
  const now = new Date();
  const { picks, window } = await selectPicksForSlot(slot, {
    limit: 3,
    skipIds,
    now,
  });
  if (picks.length === 0) {
    return c.html(`<p>geen picks voor slot=${slot} in window ${window.start.toISOString()}–${window.end.toISOString()}</p>`);
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
      { date: now }
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

  const imgTags = slides
    .map((buf, i) => {
      // slide 0 = cover, slide N-1 = outro; tussenliggende = picks[i-1]
      const pickIdx = i - 1;
      const pick = pickIdx >= 0 && pickIdx < picks.length ? picks[pickIdx] : null;
      const caption = pick
        ? `<a href="?slot=${slot}&skip=${encodeURIComponent([...skipIds, pick.eventId].join(','))}" style="color:#5a4e3f;text-decoration:none">${pick.eventId}<br/><span style="color:#a89c84">skip →</span></a>`
        : i === 0
          ? 'cover'
          : 'outro';
      return `<figure style="margin:0"><img src="data:image/png;base64,${buf.toString('base64')}" style="width:360px;height:auto;display:block;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,0.18)"/><figcaption style="margin-top:8px;font:13px/1.3 ui-monospace,Menlo,monospace;color:#5a4e3f">${caption}</figcaption></figure>`;
    })
    .join('');

  const skipLinks =
    skipIds.size > 0
      ? `<span style="font-size:13px;color:#5a4e3f">· ${skipIds.size} geskipt · <a href="?slot=${slot}" style="color:#c9453a">reset</a></span>`
      : '';

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
<html><head><meta charset="utf-8"><title>social preview — ${slot}</title>
<style>
  body { margin:0; padding:32px; background:#ebe6d8; font-family:ui-sans-serif,system-ui; color:#1a1410 }
  header { display:flex; align-items:baseline; gap:16px; margin-bottom:24px; flex-wrap:wrap }
  header h1 { margin:0; font-size:22px }
  header span { font-size:13px; color:#5a4e3f }
  .grid { display:flex; flex-wrap:wrap; gap:24px; align-items:flex-start }
  figure a:hover { color:#c9453a !important }
  .caption { margin:0 0 28px 0; padding:20px 24px; background:#f5f1e8; border-radius:12px; max-width:720px }
  .caption h2 { margin:0 0 12px 0; font-size:15px; font-weight:600; letter-spacing:0.5px; text-transform:uppercase; color:#5a4e3f }
  .caption h2 small { font-weight:500; letter-spacing:0; text-transform:none; color:#a89c84; margin-left:6px }
  .caption pre { margin:0; font:15px/1.45 ui-sans-serif,system-ui; white-space:pre-wrap; color:#1a1410 }
</style>
</head><body>
<header>
  <h1>Social preview — ${slot}</h1>
  <span>${picks.length} picks · window ${window.start.toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' })} → ${window.end.toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' })}</span>
  ${skipLinks}
</header>
${captionBlock}
<div class="grid">${imgTags}</div>
</body></html>`);
});

// ─── Posts (DB-backed drafts) ────────────────────────────────────────────
//
// Generate / approve / skip / regenerate flow voor mens-in-de-loop
// publicatie. `/generate` is de zware operatie (selectie + render +
// upload + caption), de andere zijn light state-transities.

/** Bouwt de scheduled_for-Date voor een slot op een gegeven dag in
    Europe/Amsterdam (= het tijdstip waarop de publish-cron 'm oppakt). */
function computeScheduledFor(slot: Slot, now: Date): Date {
  const { year, month, day } = amsterdamYMD(now);
  return inAmsterdamTz(year, month, day, SLOT_PUBLISH_HOUR[slot], 0);
}

interface PersistedPost {
  id: string;
  slot: Slot;
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
  } | null;
}

export async function runGenerate(
  slot: Slot,
  options: { skipIds?: Set<string>; existingId?: string } = {}
): Promise<{ post: PersistedPost; warnings: string[] }> {
  const warnings: string[] = [];
  const now = new Date();
  const { picks } = await selectPicksForSlot(slot, {
    limit: 3,
    skipIds: options.skipIds ?? new Set(),
    now,
  });
  if (picks.length === 0) {
    throw new Error(`geen picks voor slot=${slot} in huidig window`);
  }

  // 1. Render slides
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
    { date: now }
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
    })),
  });
  if (captionResult.source === 'fallback') {
    warnings.push('caption gebruikt fallback-template (Claude niet bereikt)');
  }

  const scheduledFor = computeScheduledFor(slot, now);
  const eventIds = picks.map((p) => p.eventId);

  const skippedEventIds = options.skipIds ? [...options.skipIds] : [];

  // 4. Persist — INSERT of UPDATE
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
        meta: {
          occurrenceIds: picks.map((p) => p.occurrenceId),
          templateVersion: '1',
          skippedEventIds,
        },
        updatedAt: now,
      })
      .where(eq(schema.socialPosts.id, options.existingId));
  } else {
    await db.insert(schema.socialPosts).values({
      id: postId,
      slot,
      eventIds,
      imageUrls,
      caption: captionResult.caption,
      scheduledFor,
      status: 'draft',
      meta: {
        occurrenceIds: picks.map((p) => p.occurrenceId),
        templateVersion: '1',
        skippedEventIds,
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

/** Genereer een nieuw concept-post voor een slot. */
adminSocial.post('/generate', async (c) => {
  const slotParam = (c.req.query('slot') ?? 'evening') as string;
  if (!(SLOTS as readonly string[]).includes(slotParam)) {
    return c.json({ error: 'invalid slot' }, 400);
  }
  const slot = slotParam as Slot;
  try {
    const { post, warnings } = await runGenerate(slot);
    return c.json({ post, warnings });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
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
    post (alleen toegestaan in draft-status). */
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
  try {
    const { post, warnings } = await runGenerate(existing.slot as Slot, {
      skipIds,
      existingId: id,
    });
    return c.json({ post, warnings });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});
