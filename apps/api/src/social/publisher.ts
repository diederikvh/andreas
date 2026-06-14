/**
 * IG Graph API publisher voor carousel-posts. Gebruikt de Instagram
 * Business Login flow (graph.instagram.com).
 *
 * Token-management:
 *   - Access token wordt opgeslagen in de `ig_tokens` tabel (één rij).
 *   - Bij elke publish wordt eerst gecheckt of het token >7 dagen
 *     geldig is. Zo niet → automatisch refreshen via Meta's
 *     refresh-endpoint en opnieuw opslaan.
 *   - Bij allereerste call valt 't terug op env (IG_ACCESS_TOKEN) en
 *     migreert die waarde meteen naar de DB met een conservatieve
 *     expires_at-schatting (now + 30d).
 *
 * Carousel-flow per publish:
 *   1. Per slide: POST /{ig-user-id}/media (image_url + is_carousel_item)
 *      → child-container-ID
 *   2. POST /{ig-user-id}/media (CAROUSEL + children + caption)
 *      → master container-ID
 *   3. Poll status_code tot FINISHED
 *   4. POST /{ig-user-id}/media_publish (creation_id)
 *      → definitief IG-media-ID
 *   5. GET /{media-id}?fields=permalink — best-effort permalink ophalen
 */

import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';

const GRAPH = 'https://graph.instagram.com';
const VERSION = 'v23.0';
const TOKEN_ID = 'main';
const REFRESH_THRESHOLD_DAYS = 7;

function requireUserId(): string {
  const userId = process.env.IG_USER_ID;
  if (!userId) {
    throw new Error('IG_USER_ID ontbreekt in env — kan niet publiceren');
  }
  return userId;
}

interface GraphError {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

/** Log de Meta rate-limit headers — `x-app-usage` (app-quota),
 *  `x-business-use-case-usage` (per-IG-user-quota) en `x-ad-account-usage`.
 *  Bij 100% op een teller is dat dé reden voor een 4/2207051. */
function logQuotaHeaders(path: string, res: Response) {
  const app = res.headers.get('x-app-usage');
  const buc = res.headers.get('x-business-use-case-usage');
  const ad = res.headers.get('x-ad-account-usage');
  if (app || buc || ad) {
    console.log(
      `[ig-quota] ${path}` +
        (app ? ` app=${app}` : '') +
        (buc ? ` business=${buc}` : '') +
        (ad ? ` ad=${ad}` : ''),
    );
  }
}

async function postGraph(
  path: string,
  params: Record<string, string>,
  token: string,
): Promise<Record<string, unknown>> {
  const url = `${GRAPH}/${VERSION}/${path}`;
  const body = new URLSearchParams({ ...params, access_token: token });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  logQuotaHeaders(path, res);
  const text = await res.text();
  let json: Record<string, unknown> & GraphError;
  try {
    json = JSON.parse(text) as Record<string, unknown> & GraphError;
  } catch {
    throw new Error(`IG API gaf non-JSON terug (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || json.error) {
    const e = json.error;
    console.error(`[ig-error] ${path} status=${res.status} body=${text}`);
    throw new Error(
      `IG API ${res.status}: ${e?.message ?? 'onbekende fout'}` +
        (e?.code ? ` [code=${e.code}]` : '') +
        (e?.error_subcode ? ` [subcode=${e.error_subcode}]` : '') +
        (e?.fbtrace_id ? ` [trace=${e.fbtrace_id}]` : ''),
    );
  }
  return json;
}

async function getGraph(
  path: string,
  params: Record<string, string>,
  token: string,
): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams({ ...params, access_token: token });
  const url = `${GRAPH}/${VERSION}/${path}?${qs.toString()}`;
  const res = await fetch(url);
  logQuotaHeaders(path, res);
  const text = await res.text();
  let json: Record<string, unknown> & GraphError;
  try {
    json = JSON.parse(text) as Record<string, unknown> & GraphError;
  } catch {
    throw new Error(`IG API gaf non-JSON terug (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || json.error) {
    const e = json.error;
    console.error(`[ig-error] GET ${path} status=${res.status} body=${text}`);
    throw new Error(
      `IG API ${res.status}: ${e?.message ?? 'onbekende fout'}` +
        (e?.code ? ` [code=${e.code}]` : '') +
        (e?.error_subcode ? ` [subcode=${e.error_subcode}]` : '') +
        (e?.fbtrace_id ? ` [trace=${e.fbtrace_id}]` : ''),
    );
  }
  return json;
}

// ─── Token-management ────────────────────────────────────────────────────

interface IgTokenRow {
  id: string;
  accessToken: string;
  expiresAt: Date;
  refreshedAt: Date;
}

/** Roep Meta's refresh-endpoint aan en sla 't resultaat op in de DB. */
async function refreshAndStore(currentToken: string): Promise<IgTokenRow> {
  const url = new URL(`${GRAPH}/refresh_access_token`);
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', currentToken);

  const res = await fetch(url.toString());
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`IG refresh-token gefaald (${res.status}): ${text.slice(0, 200)}`);
  }
  const json = JSON.parse(text) as {
    access_token: string;
    token_type: string;
    expires_in: number;
  };

  const now = new Date();
  const expiresAt = new Date(now.getTime() + json.expires_in * 1000);

  await db
    .insert(schema.igTokens)
    .values({
      id: TOKEN_ID,
      accessToken: json.access_token,
      expiresAt,
      refreshedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.igTokens.id,
      set: {
        accessToken: json.access_token,
        expiresAt,
        refreshedAt: now,
      },
    });

  return {
    id: TOKEN_ID,
    accessToken: json.access_token,
    expiresAt,
    refreshedAt: now,
  };
}

/** Migreer een env-token éénmalig naar de DB met een conservatieve
 *  schatting van expires_at (now + 30d). Na de eerste refresh wordt
 *  expires_at vervangen door Meta's echte waarde. */
async function seedFromEnv(envToken: string): Promise<IgTokenRow> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  await db
    .insert(schema.igTokens)
    .values({
      id: TOKEN_ID,
      accessToken: envToken,
      expiresAt,
      refreshedAt: now,
    })
    .onConflictDoNothing();

  const [row] = await db
    .select()
    .from(schema.igTokens)
    .where(eq(schema.igTokens.id, TOKEN_ID));
  return row as IgTokenRow;
}

/**
 * Haalt het huidige IG-token uit de DB en refresht 'm als 't binnen
 * `REFRESH_THRESHOLD_DAYS` dagen vervalt. Bij allereerste call wordt
 * `IG_ACCESS_TOKEN` uit env geseed naar de DB.
 *
 * Geëxporteerd zodat de refresh-endpoint 'm ook kan aanroepen — die
 * forceert een refresh ongeacht expires_at.
 */
export async function ensureFreshToken(opts: { force?: boolean } = {}): Promise<IgTokenRow> {
  let [row] = (await db
    .select()
    .from(schema.igTokens)
    .where(eq(schema.igTokens.id, TOKEN_ID))) as IgTokenRow[];

  if (!row) {
    const envToken = process.env.IG_ACCESS_TOKEN;
    if (!envToken) {
      throw new Error(
        'Geen IG-token in DB en IG_ACCESS_TOKEN ontbreekt in env — kan niet publiceren',
      );
    }
    row = await seedFromEnv(envToken);
  }

  const now = Date.now();
  const thresholdMs = REFRESH_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
  const needsRefresh = opts.force || row.expiresAt.getTime() - now < thresholdMs;
  if (!needsRefresh) return row;

  try {
    return await refreshAndStore(row.accessToken);
  } catch (e) {
    // Refresh-fail betekent niet automatisch dat 't huidige token kaput
    // is — bv. Meta vereist dat 't >24u oud is voor refresh. Loggen en
    // doorgaan met het bestaande token; volgende attempt probeert weer.
    console.warn(`[publisher] refresh gefaald, val terug op bestaande token: ${(e as Error).message}`);
    return row;
  }
}

// ─── Carousel publishing ─────────────────────────────────────────────────

/** Wacht tot de master-container status `FINISHED` is, of geeft een
 *  duidelijke fout als 't `ERROR` of `EXPIRED` wordt. Poll-interval is
 *  1s, max 30s totaal. */
async function waitForContainerReady(
  containerId: string,
  token: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = '';
  while (Date.now() < deadline) {
    const r = (await getGraph(
      containerId,
      { fields: 'status_code,status' },
      token,
    )) as { status_code?: string; status?: string };
    lastStatus = r.status_code ?? r.status ?? '';
    if (lastStatus === 'FINISHED') return;
    if (lastStatus === 'ERROR' || lastStatus === 'EXPIRED') {
      throw new Error(`IG container status=${lastStatus}`);
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(
    `IG container niet klaar binnen ${Math.round(timeoutMs / 1000)}s (last status=${lastStatus})`,
  );
}

export interface PublishInput {
  imageUrls: string[];
  caption: string;
}

export interface PublishResult {
  igMediaId: string;
  permalink: string | null;
}

export async function publishCarousel(input: PublishInput): Promise<PublishResult> {
  if (input.imageUrls.length < 2) {
    throw new Error('IG carousel vereist minimaal 2 slides');
  }
  if (input.imageUrls.length > 10) {
    throw new Error('IG carousel max 10 slides — heeft ' + input.imageUrls.length);
  }

  const userId = requireUserId();
  const { accessToken: token } = await ensureFreshToken();

  // 1. Child-containers parallel
  const childIds = await Promise.all(
    input.imageUrls.map(async (url) => {
      const r = (await postGraph(
        `${userId}/media`,
        {
          image_url: url,
          is_carousel_item: 'true',
        },
        token,
      )) as { id?: string };
      if (!r.id) throw new Error('IG child-container geen id terug');
      return r.id;
    }),
  );

  // 2. Master carousel-container
  const master = (await postGraph(
    `${userId}/media`,
    {
      media_type: 'CAROUSEL',
      children: childIds.join(','),
      caption: input.caption,
    },
    token,
  )) as { id?: string };
  if (!master.id) throw new Error('IG master-container geen id terug');

  // 3. Wacht tot ready
  await waitForContainerReady(master.id, token);

  // 4. Publish — met fallback-detectie voor de Meta-bug waar
  //    `/media_publish` 4/2207051 retourneert ondanks dat de master-
  //    container creatie de post al heeft gepubliceerd. We hebben dat
  //    empirisch bevestigd: bij die error stond de post tóch op IG.
  //    Workaround: bij specifiek 4/2207051 doen we een fallback-lookup
  //    naar `/me/media` en zoeken de net-gepubliceerde post in de
  //    laatste 60s. Vinden we 'm → behandelen we 't als success met
  //    die media-id.
  const publishStartedAt = Date.now();
  let igMediaId: string;
  try {
    const published = (await postGraph(
      `${userId}/media_publish`,
      { creation_id: master.id },
      token,
    )) as { id?: string };
    if (!published.id) throw new Error('IG publish geen media-id terug');
    igMediaId = published.id;
  } catch (e) {
    const msg = (e as Error).message;
    const isMetaBug = /\[code=4\].*\[subcode=2207051\]/.test(msg);
    if (!isMetaBug) throw e;

    console.warn(
      `[publisher] media_publish 4/2207051 — fallback via /me/media: ${msg}`,
    );
    const recent = (await getGraph(
      `${userId}/media`,
      { fields: 'id,timestamp,permalink', limit: '5' },
      token,
    )) as { data?: Array<{ id: string; timestamp: string; permalink?: string }> };
    const cutoff = publishStartedAt - 60_000;
    const match = (recent.data ?? []).find((m) => {
      const t = Date.parse(m.timestamp);
      return !Number.isNaN(t) && t >= cutoff;
    });
    if (!match) {
      throw new Error(
        `IG publish faalde met 4/2207051 én geen recente post gevonden in /me/media — echte fout: ${msg}`,
      );
    }
    console.log(`[publisher] fallback-detect: post staat live als ${match.id}`);
    igMediaId = match.id;
  }

  // 5. Permalink ophalen — best-effort
  let permalink: string | null = null;
  try {
    const meta = (await getGraph(
      igMediaId,
      { fields: 'permalink' },
      token,
    )) as { permalink?: string };
    permalink = meta.permalink ?? null;
  } catch {
    // permalink-fetch is niet kritisch
  }

  return { igMediaId, permalink };
}

// ─── Reels publishing ────────────────────────────────────────────────────

export interface PublishReelInput {
  videoUrl: string;
  caption: string;
  /** Ook tonen in de feed (niet alleen Reels-tab). Default true. */
  shareToFeed?: boolean;
  /** Optionele thumbnail-URL voor de Reel-cover. */
  coverUrl?: string;
}

/**
 * Reel-flow:
 *   1. POST /{ig-user-id}/media (media_type=REELS + video_url + caption)
 *   2. Poll status (Reels-encoding duurt langer dan foto's — tot 90s)
 *   3. POST /{ig-user-id}/media_publish (zelfde 4/2207051-workaround)
 *
 * IG-eisen voor de video: MP4/MOV, H.264, 9:16, ≤90s, ≤100MB.
 * URL moet publiek bereikbaar zijn (Bunny CDN is prima).
 */
export async function publishReel(input: PublishReelInput): Promise<PublishResult> {
  const userId = requireUserId();
  const { accessToken: token } = await ensureFreshToken();

  const containerParams: Record<string, string> = {
    media_type: 'REELS',
    video_url: input.videoUrl,
    caption: input.caption,
    share_to_feed: (input.shareToFeed ?? true) ? 'true' : 'false',
  };
  if (input.coverUrl) containerParams.cover_url = input.coverUrl;

  const container = (await postGraph(
    `${userId}/media`,
    containerParams,
    token,
  )) as { id?: string };
  if (!container.id) throw new Error('IG reel-container geen id terug');

  // Reels-encoding kan tot 90s duren — verleng polling-timeout.
  await waitForContainerReady(container.id, token, 120_000);

  const publishStartedAt = Date.now();
  let igMediaId: string;
  try {
    const published = (await postGraph(
      `${userId}/media_publish`,
      { creation_id: container.id },
      token,
    )) as { id?: string };
    if (!published.id) throw new Error('IG reel publish geen media-id terug');
    igMediaId = published.id;
  } catch (e) {
    const msg = (e as Error).message;
    const isMetaBug = /\[code=4\].*\[subcode=2207051\]/.test(msg);
    if (!isMetaBug) throw e;

    console.warn(
      `[publisher] reel media_publish 4/2207051 — fallback via /me/media: ${msg}`,
    );
    const recent = (await getGraph(
      `${userId}/media`,
      { fields: 'id,timestamp,permalink,media_type', limit: '5' },
      token,
    )) as {
      data?: Array<{ id: string; timestamp: string; permalink?: string; media_type?: string }>;
    };
    const cutoff = publishStartedAt - 120_000;
    const match = (recent.data ?? []).find((m) => {
      const t = Date.parse(m.timestamp);
      return !Number.isNaN(t) && t >= cutoff;
    });
    if (!match) {
      throw new Error(
        `IG reel publish faalde met 4/2207051 én geen recente post gevonden in /me/media — echte fout: ${msg}`,
      );
    }
    console.log(`[publisher] reel fallback-detect: post staat live als ${match.id}`);
    igMediaId = match.id;
  }

  let permalink: string | null = null;
  try {
    const meta = (await getGraph(
      igMediaId,
      { fields: 'permalink' },
      token,
    )) as { permalink?: string };
    permalink = meta.permalink ?? null;
  } catch {
    // niet kritisch
  }

  return { igMediaId, permalink };
}
