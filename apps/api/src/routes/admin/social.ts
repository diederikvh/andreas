import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import { db, schema } from '../../db/index.js';
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

type Slot = 'morning' | 'afternoon' | 'evening';
const SLOTS: readonly Slot[] = ['morning', 'afternoon', 'evening'];

const DEDUP_DAYS = 14;
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
  const window = computeWindow(slot, now);
  const dedupSince = new Date(now.getTime() - DEDUP_DAYS * 24 * 60 * 60 * 1000);

  // Welke event-ids hebben we de laatste DEDUP_DAYS al gepost?
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

  // Kandidaten ophalen — alle occurrences in window met published
  // event + venue, met imageUrl, status='scheduled'. Saves-count als
  // correlated subquery (snel genoeg voor < 200 candidates).
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

  // Eén occurrence per event (vroegste = al gesorteerd op startsAt).
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

  return c.json({
    slot,
    window: { start: window.start.toISOString(), end: window.end.toISOString() },
    generatedAt: now.toISOString(),
    candidateCount: perEvent.length,
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
    ...(debug ? { dedupExcluded: dedupSet.size } : {}),
  });
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
  const window = computeWindow(slot, now);

  // Hergebruik dezelfde query als /picks (kortere variant — geen
  // saves-count nodig voor preview-rendering).
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
      savesCount: sql<number>`0`.as('saves_count'),
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
    if (skipIds.has(row.eventId)) continue;
    if (!row.imageUrl) continue;
    perEvent.push(row);
    seen.add(row.eventId);
  }
  const picks = pickWithSpread(perEvent.map(scoreCandidate), 3);
  if (picks.length === 0) {
    return c.html(`<p>geen picks voor slot=${slot} in window ${window.start.toISOString()}–${window.end.toISOString()}</p>`);
  }

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

  return c.html(`<!doctype html>
<html><head><meta charset="utf-8"><title>social preview — ${slot}</title>
<style>
  body { margin:0; padding:32px; background:#ebe6d8; font-family:ui-sans-serif,system-ui; color:#1a1410 }
  header { display:flex; align-items:baseline; gap:16px; margin-bottom:24px; flex-wrap:wrap }
  header h1 { margin:0; font-size:22px }
  header span { font-size:13px; color:#5a4e3f }
  .grid { display:flex; flex-wrap:wrap; gap:24px; align-items:flex-start }
  figure a:hover { color:#c9453a !important }
</style>
</head><body>
<header>
  <h1>Social preview — ${slot}</h1>
  <span>${picks.length} picks · window ${window.start.toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' })} → ${window.end.toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' })}</span>
  ${skipLinks}
</header>
<div class="grid">${imgTags}</div>
</body></html>`);
});
