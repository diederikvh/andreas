import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, lt, lte, notInArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import { db, schema } from '../../db/index.js';
import { generateCaption } from '../../social/caption.js';
import { ensureFreshToken, publishCarousel, publishReel } from '../../social/publisher.js';
import { renderVideo } from '../../social/render-video.js';
import {
  buildAuthorizeUrl as tiktokAuthorizeUrl,
  completeOAuth as tiktokCompleteOAuth,
  generatePkce as tiktokGeneratePkce,
  getTikTokConnection,
  publishTikTokInbox,
} from '../../social/tiktok.js';
import {
  HOOKS as VIDEO_HOOKS,
  HOOK_UNITS,
  KICKERS as THEME_KICKERS,
  OVERVIEW_TITLES,
  formatWindowRange,
  withDynamicCount,
  withDynamicDate,
  type HookUnit,
} from '../../social/dailyfilms5-data.js';
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
 * Scene-weight: MAINSTREAM EERST. Een carousel is reclame voor wat er
 * speelt in Amsterdam — herkenning triggert engagement. We gaan voor
 * grote namen (Paradiso/Melkweg/Concertgebouw/Stedelijk) bovenaan en
 * vullen aan met alternatief/underground/fringe als de mainstream-
 * picks op zijn. Eerdere balans (mainstream=0.7, underground=0.85)
 * was juist omgekeerd — dat maakte de carousel te obscuur.
 */
const SCENE_WEIGHT: Record<string, number> = {
  mainstream: 1.0,
  alternatief: 0.55,
  fringe: 0.45,
  underground: 0.35,
};

/**
 * Capacity-weight: grotere zalen = meer reclame-waarde voor de carousel.
 * Schaalt mee met scene maar als onafhankelijk signaal (sommige
 * alternatieve venues zijn groot — bv. Melkweg Max — en horen op de
 * eerste slide).
 */
const CAPACITY_WEIGHT: Record<string, number> = {
  xl: 1.0,
  groot: 0.85,
  middel: 0.55,
  klein: 0.3,
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
  venueCapacity: string | null;
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
  // Scene-multiplier verhoogd 0.3→0.6 zodat mainstream echt domineert.
  // Carousel = reclame; herkenning moet boven exotiek staan.
  const sceneScore = 0.6 * sceneWeight;
  const capacityWeight = c.venueCapacity
    ? (CAPACITY_WEIGHT[c.venueCapacity] ?? 0.5)
    : 0.5;
  const capacityScore = 0.4 * capacityWeight;
  const savesScore = 0.2 * Math.min(c.savesCount / 10, 1);
  const cooldownPenalty = opts.venueCooldownSet.has(c.venueId)
    ? VENUE_COOLDOWN_PENALTY
    : 0;
  const score =
    featuredBoost + sceneScore + capacityScore + savesScore + cooldownPenalty;
  return {
    ...c,
    score,
    breakdown: {
      featured: featuredBoost,
      scene: sceneScore,
      capacity: capacityScore,
      saves: savesScore,
      cooldown: cooldownPenalty,
    },
  };
}

/**
 * Mainstream-eerst pick-strategie met spreiding over de week.
 *
 * Volgorde:
 *  1. Hook-pin: hoogst-scorende mainstream event (herkenning triggert
 *     engagement bij scrollers).
 *  2. Spread strict: top-score met venue-uniek EN dag-uniek (Y-M-D in
 *     Amsterdam-tz) — zorgt dat de carousel mooi over de week loopt.
 *  3. Fallback A: venue-uniek (dag-dup toegestaan).
 *  4. Fallback B: alles toegestaan (last resort bij erg dun aanbod).
 *
 * Output is gesorteerd op startsAt zodat de slides chronologisch lopen.
 * Geen mainstream beschikbaar? Stap 2 begint meteen — niet ideaal maar
 * beter dan een lege post.
 */
function pickWithSpread(scored: ScoredCandidate[], limit: number): ScoredCandidate[] {
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const picked: ScoredCandidate[] = [];
  const seenVenues = new Set<string>();
  const seenDays = new Set<string>();

  /** Amsterdam-Y-M-D dagsleutel voor spread-detection. */
  const dayKey = (c: ScoredCandidate): string => {
    const ymd = amsterdamYMD(c.startsAt);
    return `${ymd.year}-${ymd.month}-${ymd.day}`;
  };

  // 1. Hook-pin
  const hook = sorted.find((c) => c.venueScene === 'mainstream');
  if (hook) {
    picked.push(hook);
    seenVenues.add(hook.venueId);
    seenDays.add(dayKey(hook));
  }

  // 2. Strict spread: venue-uniek EN dag-uniek
  for (const c of sorted) {
    if (picked.length >= limit) break;
    if (picked.some((p) => p.occurrenceId === c.occurrenceId)) continue;
    if (seenVenues.has(c.venueId)) continue;
    if (seenDays.has(dayKey(c))) continue;
    picked.push(c);
    seenVenues.add(c.venueId);
    seenDays.add(dayKey(c));
  }

  // 3. Fallback A: venue-uniek (dag-dup OK)
  if (picked.length < limit) {
    for (const c of sorted) {
      if (picked.length >= limit) break;
      if (picked.some((p) => p.occurrenceId === c.occurrenceId)) continue;
      if (seenVenues.has(c.venueId)) continue;
      picked.push(c);
      seenVenues.add(c.venueId);
    }
  }

  // 4. Fallback B: alles toegestaan
  if (picked.length < limit) {
    for (const c of sorted) {
      if (picked.length >= limit) break;
      if (picked.some((p) => p.occurrenceId === c.occurrenceId)) continue;
      picked.push(c);
    }
  }

  // Chronologisch sorteren zodat de slides door de week heen lopen.
  picked.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
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
export async function selectPicksForTheme(
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
        imageUrl: sql<string | null>`COALESCE(${schema.events.imageUrl}, ${schema.venues.imageUrl})`.as('image_url'),
        category: schema.events.category,
        featured: schema.events.featured,
        venueId: schema.venues.id,
        venueName: schema.venues.name,
        venueScene: schema.venues.scene,
        venueType: schema.venues.type,
        venueCapacity: schema.venues.capacity,
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
          // Tenminste één foto-bron (event of venue) moet bestaan.
          // Coalesced in de SELECT zodat downstream gewoon imageUrl ziet.
          sql`COALESCE(${schema.events.imageUrl}, ${schema.venues.imageUrl}) IS NOT NULL`,
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

// ─── Video-props ─────────────────────────────────────────────────────────
// Levert JSON in DailyFilms5-shape voor de Remotion-renderer in
// apps/video-gen. Lokale flow:
//   pnpm --filter @andreas/video-gen render -- \
//     --props=https://api.andreas.amsterdam/admin/api/social/video-props?theme=films
// Endpoint hergebruikt dezelfde pick-selector als de carousel-generator,
// dus de video toont exact dezelfde events als een carousel zou doen.

function videoKickerForTheme(theme: Theme): string {
  return theme.label.nl;
}

function videoHookForTheme(theme: Theme): string {
  // Hook voor de intro-slide — pakkende, concrete zin per thema.
  // Default = themeLabel; specifieke overrides hieronder.
  const hooks: Partial<Record<ThemeKey, string>> = {
    'theater': 'De voorstellingen waar Amsterdam over praat',
    'live-music': 'De concerten die je deze week niet wil missen',
    'film': 'Films die je deze week wil zien',
    'clubs': 'De clubnachten waar Amsterdam naartoe gaat',
    'galleries': 'De tentoonstellingen waar Amsterdam naartoe gaat',
  };
  return hooks[theme.key] ?? theme.label.nl;
}

function formatDateLabel(d: Date): string {
  const days = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
  const months = [
    'jan', 'feb', 'mrt', 'apr', 'mei', 'jun',
    'jul', 'aug', 'sep', 'okt', 'nov', 'dec',
  ];
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}`;
}

function formatTimeLabel(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

adminSocial.get('/video-props', async (c) => {
  const theme = resolveTheme(c.req.query('theme'));
  if (!theme) {
    return c.json({ error: 'invalid theme', validKeys: THEME_KEYS }, 400);
  }
  const limit = Math.max(3, Math.min(6, Number(c.req.query('limit') ?? '6')));
  const now = new Date();
  const { picks } = await selectPicksForTheme(theme, {
    limit,
    skipIds: new Set(),
    now,
  });
  if (picks.length === 0) {
    return c.json({ error: 'geen picks gevonden voor dit thema' }, 404);
  }

  // Voor films: gebruik liever de still (frame uit de trailer/film) dan
  // de poster, dan pas de generieke imageUrl. Andere thema's hebben
  // geen stills/posters dus daar blijft 't gewoon imageUrl.
  const useFilmImages = theme.key === 'film';
  const heroByEventId = new Map<string, string>();
  if (useFilmImages && picks.length > 0) {
    const rows = await db
      .select({
        id: schema.events.id,
        stillUrl: schema.events.stillUrl,
        posterUrl: schema.events.posterUrl,
        imageUrl: schema.events.imageUrl,
      })
      .from(schema.events)
      .where(inArray(schema.events.id, picks.map((p) => p.eventId)));
    for (const r of rows) {
      const url = r.stillUrl ?? r.posterUrl ?? r.imageUrl ?? null;
      if (url) heroByEventId.set(r.id, url);
    }
  }

  return c.json({
    themeKicker: videoKickerForTheme(theme),
    hook: videoHookForTheme(theme),
    picks: picks.map((p) => ({
      imageUrl: heroByEventId.get(p.eventId) ?? p.imageUrl,
      title: p.title,
      venueName: p.venueName,
      dateLabel: formatDateLabel(new Date(p.startsAt)),
      timeLabel: formatTimeLabel(new Date(p.startsAt)),
    })),
  });
});

// JustIn video-props — events die binnen de laatste 7 dagen zijn aan-
// gemaakt, sorteert op nieuwste eerst, returnt 5. Aparte logica dan
// `selectPicksForTheme` omdat we hier niet op categorie filteren maar
// op tijd.
adminSocial.get('/video-props/just-in', async (c) => {
  try {
    const { fetchJustInPropsForUi } = await import('../../social/justin-data.js');
    return c.json(await fetchJustInPropsForUi());
  } catch (e) {
    return c.json({ error: (e as Error).message }, 404);
  }
});

// ─── Volautomatische render + post pipeline ──────────────────────────────
//
// `POST /admin/api/social/run-video` → één call, alle stappen:
//   1. Data ophalen (zelfde logica als /video-props)
//   2. Render lokaal via Remotion (subprocess in apps/video-gen)
//   3. MP4 uploaden naar Bunny
//   4. Posten als Reel (met onze 4/2207051-workaround)
//   5. socialPosts-rij wegschrijven
//
// Vereist dat de API LOKAAL draait — render gebruikt headless Chromium
// dat niet op Fly geïnstalleerd is. Voor wekelijkse runs: laat een
// macOS launchd / cron-job deze endpoint aanroepen via curl op je
// dev-machine.

const DEFAULT_CAPTIONS: Record<string, string> = {
  'JustIn':
    'De 6 events die net zijn aangekondigd in Amsterdam. Bewaar voor later op andreas.amsterdam',
};

adminSocial.post('/run-video', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    composition?: string;
    caption?: string;
  };
  const composition = body.composition ?? 'JustIn';
  const caption = body.caption ?? DEFAULT_CAPTIONS[composition] ?? '';
  if (!caption.trim()) {
    return c.json({ error: 'caption is verplicht' }, 400);
  }

  let props: unknown;
  if (composition === 'JustIn') {
    const { fetchJustInPropsForUi } = await import('../../social/justin-data.js');
    props = await fetchJustInPropsForUi();
  } else {
    return c.json({ error: `onbekende compositie: ${composition}` }, 400);
  }

  console.log(`[run-video] rendering ${composition}…`);
  const mp4 = await renderVideo({ compositionId: composition, props });

  const ymd = new Date().toISOString().slice(0, 10);
  const id = randomBytes(6).toString('hex');
  const path = `social-videos/${ymd}-${composition.toLowerCase()}-${id}.mp4`;
  const videoUrl = await uploadToBunny(path, mp4, 'video/mp4');
  console.log(`[run-video] uploaded → ${videoUrl}`);

  const { igMediaId, permalink } = await publishReel({
    videoUrl,
    caption,
    shareToFeed: true,
  });

  const postId = `sp-${randomBytes(6).toString('hex')}`;
  await db.insert(schema.socialPosts).values({
    id: postId,
    slot: 'evening',
    status: 'posted',
    caption,
    imageUrls: [videoUrl],
    eventIds: [],
    scheduledFor: new Date(),
    postedAt: new Date(),
    igMediaId,
    meta: {
      ...(permalink ? { permalink } : {}),
      themeKey: composition,
    },
  });

  return c.json({ ok: true, igMediaId, permalink, videoUrl });
});

// ─── Video upload + post als Reel ────────────────────────────────────────
// Workflow:
//   1. Lokaal: `pnpm --filter @andreas/video-gen render`
//      → out/films.mp4
//   2. Upload via admin/social/video (multipart-form) → Bunny CDN
//   3. Reel-container + media_publish via publishReel()
//   4. Genereer caption (gebruiker tikt of regenereert; default = thema-label)
//   5. socialPosts-rij met status='posted' voor tracking

adminSocial.post('/post-video', async (c) => {
  const form = await c.req.parseBody();
  const file = form.video;
  const caption = typeof form.caption === 'string' ? form.caption : '';
  const themeKey = typeof form.theme === 'string' ? form.theme : null;

  if (!file || !(file instanceof File)) {
    return c.json({ error: 'video-bestand ontbreekt' }, 400);
  }
  if (!caption.trim()) {
    return c.json({ error: 'caption is verplicht' }, 400);
  }

  // Upload naar Bunny onder een unique pad zodat IG het niet uit cache
  // pakt (Meta cachet video-URLs aggressief).
  const ymd = new Date().toISOString().slice(0, 10);
  const id = randomBytes(6).toString('hex');
  const path = `social-videos/${ymd}-${themeKey ?? 'video'}-${id}.mp4`;
  const buf = await file.arrayBuffer();
  const videoUrl = await uploadToBunny(path, buf, 'video/mp4');

  try {
    const { igMediaId, permalink } = await publishReel({
      videoUrl,
      caption,
      shareToFeed: true,
    });
    // Track in socialPosts zodat dedup + admin-overzicht 'm zien.
    const postId = `sp-${randomBytes(6).toString('hex')}`;
    await db.insert(schema.socialPosts).values({
      id: postId,
      slot: 'evening',
      status: 'posted',
      caption,
      imageUrls: [videoUrl], // tracking: video-URL ipv slide-URLs
      eventIds: [],
      scheduledFor: new Date(),
      postedAt: new Date(),
      igMediaId,
      meta: {
        ...(permalink ? { permalink } : {}),
        ...(themeKey ? { themeKey } : {}),
      },
    });
    return c.json({ ok: true, igMediaId, permalink, videoUrl });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message, videoUrl }, 500);
  }
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
      uploadToBunny(`media/social/${ymd}/${prefix}-${i}.jpg`, buf, 'image/jpeg')
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
    limit: 6,
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
        themeLabel: THEME_KICKERS[theme.key] ?? theme.label.nl,
        hook: VIDEO_HOOKS[theme.key],
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
    limit: 6,
    skipIds: options.skipIds ?? new Set(),
    now,
  });
  if (picks.length === 0) {
    throw new Error(`geen picks voor theme=${theme.key} in huidig window`);
  }

  // 1. Bouw structuur-data voor de intro + overview (matched de video).
  const baseUnits: HookUnit[] = HOOK_UNITS[theme.key] ?? [
    { role: 'eyebrow', text: theme.label.nl.toUpperCase() },
    { role: 'count', text: String(picks.length) },
    { role: 'headline', text: 'highlights' },
    { role: 'meta', text: 'Amsterdam\n{date}' },
  ];
  const dateRange = formatWindowRange(theme.windowDays, now);
  const hookUnits = withDynamicDate(
    withDynamicCount(baseUnits, picks.length),
    dateRange,
  );
  const overviewTitleTemplate =
    OVERVIEW_TITLES[theme.key] ?? `Top ${picks.length} ${theme.label.nl}`;
  const overviewTitle = overviewTitleTemplate.replace(
    '{count}',
    String(picks.length),
  );

  // 2. Render slides in TWEE formaten:
  //    - 'ig'     → 1080×1350 (4:5) — Instagram-feed-carousel maximum
  //    - 'tiktok' → 1080×1920 (9:16) — TikTok photo-carousel beeldvullend
  //    Beide worden parallel gerenderd. IG-set blijft `imageUrls` (zodat
  //    bestaande IG-publish + UI ongewijzigd werken); TikTok-set wordt
  //    opgeslagen in `meta.tiktokImageUrls`.
  const renderOpts = {
    date: now,
    themeLabel: THEME_KICKERS[theme.key] ?? theme.label.nl,
    windowLabel: theme.windowLabel.nl,
    hook: VIDEO_HOOKS[theme.key],
    hookUnits,
    overviewTitle,
  };
  const carouselPicks = picks.map((p) => ({
    imageUrl: p.imageUrl,
    title: p.title,
    venueName: p.venueName,
    category: p.category,
    venueType: p.venueType,
    startsAt: p.startsAt,
    endsAt: p.endsAt,
  }));
  const [slidesIg, slidesTt] = await Promise.all([
    renderCarousel(carouselPicks, { ...renderOpts, format: 'ig' }),
    renderCarousel(carouselPicks, { ...renderOpts, format: 'tiktok' }),
  ]);

  // 2. Upload beide sets parallel — `media/social/YYYY-MM-DD/<id>-<gen>-{ig|tt}-{n}.jpg`.
  //    Pad bevat een generatie-marker (epoch in base36) zodat regenerates
  //    verse URLs opleveren en de browser-cache niet de oude versie blijft tonen.
  const ymd = now.toISOString().slice(0, 10);
  const postId = options.existingId ?? `sp-${shortId()}`;
  const generation = now.getTime().toString(36);
  const [imageUrls, tiktokImageUrls] = await Promise.all([
    Promise.all(
      slidesIg.map((buf, i) =>
        uploadToBunny(
          `media/social/${ymd}/${postId}-${generation}-ig-${i}.jpg`,
          buf,
          'image/jpeg',
        ),
      ),
    ),
    Promise.all(
      slidesTt.map((buf, i) =>
        uploadToBunny(
          `media/social/${ymd}/${postId}-${generation}-tt-${i}.jpg`,
          buf,
          'image/jpeg',
        ),
      ),
    ),
  ]);

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
          templateVersion: '3',
          skippedEventIds,
          themeKey: theme.key,
          windowDays,
          tiktokImageUrls,
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
        templateVersion: '3',
        skippedEventIds,
        themeKey: theme.key,
        windowDays,
        tiktokImageUrls,
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
    // Reel-posts (meta.kind='reel') worden anders behandeld: 1 video-URL
    // i.p.v. een carousel met N stills. Voor de rest is de flow identiek.
    const isReel = (post.meta as { kind?: string } | null)?.kind === 'reel';
    const { igMediaId, permalink } = isReel
      ? await publishReel({
          videoUrl: post.imageUrls[0],
          caption: post.caption,
          shareToFeed: true,
        })
      : await publishCarousel({
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
/**
 * Diagnostic — toont in één response de IG-token-scopes, app-id,
 * IG-user-id en de huidige `content_publishing_limit`. Gebruikt om bij
 * 4/2207051-fouten meteen te zien of het token de juiste scopes heeft
 * én of het quota op is.
 */
adminSocial.get('/debug', async (c) => {
  try {
    const { accessToken } = await ensureFreshToken();
    const userId = process.env.IG_USER_ID;
    const base = 'https://graph.instagram.com/v23.0';

    // 1. Token-debug op graph.facebook.com (graph.instagram.com heeft geen
    //    debug_token, fallback op de FB-variant — werkt voor IG Business
    //    Login tokens.)
    const debugRes = await fetch(
      `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(
        accessToken,
      )}&access_token=${encodeURIComponent(accessToken)}`,
    );
    const debugJson = (await debugRes.json()) as unknown;

    // 2. /me met fields user_id,username
    const meRes = await fetch(
      `${base}/me?fields=user_id,username,account_type&access_token=${encodeURIComponent(
        accessToken,
      )}`,
    );
    const meJson = (await meRes.json()) as unknown;

    // 2b. Scopes die ACTIEF in het token zitten — niet de app-config maar
    //     het token zelf. Mismatch hier verklaart 4/2207051 wanneer je
    //     een permission toevoegt na token-generatie.
    const permsRes = await fetch(
      `${base}/me/permissions?access_token=${encodeURIComponent(accessToken)}`,
    );
    const permsJson = (await permsRes.json()) as unknown;

    // 3. Content publishing limit
    let publishingLimit: unknown = null;
    if (userId) {
      const limitRes = await fetch(
        `${base}/${userId}/content_publishing_limit?fields=config,quota_usage&access_token=${encodeURIComponent(
          accessToken,
        )}`,
      );
      publishingLimit = await limitRes.json();
    }

    return c.json({
      env: {
        IG_USER_ID: userId ?? null,
      },
      debugToken: debugJson,
      me: meJson,
      tokenPermissions: permsJson,
      contentPublishingLimit: publishingLimit,
    });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

// ─── TikTok OAuth + Inbox-publish ────────────────────────────────────────

adminSocial.get('/tiktok/connect', (c) => {
  // CSRF-state + PKCE-verifier — beide in cookie, verifieren we bij callback.
  const state = randomBytes(16).toString('hex');
  const { codeVerifier, codeChallenge } = tiktokGeneratePkce();
  // Twee cookies — beide HttpOnly, 10 min levenstijd.
  c.header(
    'Set-Cookie',
    `tt_oauth_state=${state}; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=600`,
    { append: true },
  );
  c.header(
    'Set-Cookie',
    `tt_oauth_verifier=${codeVerifier}; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=600`,
    { append: true },
  );
  return c.redirect(tiktokAuthorizeUrl(state, codeChallenge));
});

adminSocial.get('/tiktok/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const cookieHeader = c.req.header('cookie') ?? '';
  const expectedState = /tt_oauth_state=([a-f0-9]+)/.exec(cookieHeader)?.[1];
  const verifier = /tt_oauth_verifier=([A-Za-z0-9_-]+)/.exec(cookieHeader)?.[1];
  if (!code) return c.text('Missing code', 400);
  if (!state || state !== expectedState) return c.text('Invalid state', 400);
  if (!verifier) return c.text('Missing PKCE verifier (cookie expired?)', 400);

  try {
    await tiktokCompleteOAuth(code, verifier);
  } catch (e) {
    return c.text(`OAuth-fout: ${(e as Error).message}`, 500);
  }
  return c.redirect(
    '/admin/social?flash=' + encodeURIComponent('TikTok verbonden'),
  );
});

adminSocial.get('/tiktok/status', async (c) => {
  return c.json(await getTikTokConnection());
});

adminSocial.post('/tiktok/disconnect', async (c) => {
  await db.delete(schema.tiktokTokens).where(eq(schema.tiktokTokens.id, 'main'));
  return c.json({ ok: true });
});

/**
 * Plaats een Reel-post (status=approved/draft/posted maakt niet uit —
 * we hergebruiken de video-URL) als draft in TikTok-app.
 */
adminSocial.post('/posts/:id/tiktok-draft', async (c) => {
  const id = c.req.param('id');
  const [post] = await db
    .select()
    .from(schema.socialPosts)
    .where(eq(schema.socialPosts.id, id));
  if (!post) return c.json({ error: 'post niet gevonden' }, 404);
  if (post.imageUrls.length === 0) {
    return c.json({ error: 'post heeft geen video-URL' }, 400);
  }
  try {
    const result = await publishTikTokInbox({
      videoUrl: post.imageUrls[0],
      caption: post.caption ?? undefined,
    });
    return c.json({ ok: true, publishId: result.publishId });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

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
  const theme =
    getThemeByKey(themeKey) ?? getThemeForDate(new Date()) ?? THEMES[0];
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
