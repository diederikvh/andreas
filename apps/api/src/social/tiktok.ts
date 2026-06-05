/**
 * TikTok Content Posting API — OAuth + Inbox-upload.
 *
 * Flow:
 *   1. Admin klikt "Verbind TikTok" → /admin/api/social/tiktok/connect
 *      → 302 redirect naar TikTok auth-pagina
 *   2. TikTok callback → /admin/api/social/tiktok/callback?code=...
 *      → wissel code voor access_token + refresh_token, sla op in DB
 *   3. Admin klikt "Naar TikTok-drafts" op een Reel-post
 *      → publishTikTokInbox(videoUrl, caption)
 *      → TikTok pulls video van Bunny CDN, video komt in account's Drafts
 *   4. Admin opent TikTok-app, publisht handmatig vanuit Drafts
 *
 * Env-vars vereist:
 *   TIKTOK_CLIENT_KEY
 *   TIKTOK_CLIENT_SECRET
 *   TIKTOK_REDIRECT_URI (bv. http://localhost:8787/admin/api/social/tiktok/callback)
 */

import { createHash, randomBytes } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';

const AUTH_BASE = 'https://www.tiktok.com/v2/auth/authorize/';
const API_BASE = 'https://open.tiktokapis.com/v2';
const TOKEN_ID = 'main';
const REFRESH_THRESHOLD_MS = 60 * 60 * 1000; // refresh als <1h geldig

const SCOPES = ['user.info.basic', 'video.upload'];

function requireConfig() {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  const redirectUri = process.env.TIKTOK_REDIRECT_URI;
  if (!clientKey || !clientSecret || !redirectUri) {
    throw new Error(
      'TikTok niet geconfigureerd — vereist TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_REDIRECT_URI',
    );
  }
  return { clientKey, clientSecret, redirectUri };
}

// ─── OAuth ──────────────────────────────────────────────────────────────

/**
 * TikTok vereist PKCE: we genereren een random `code_verifier`, sturen
 * z'n SHA256-hash (base64url) mee als `code_challenge` bij authorize,
 * en geven de verifier weer mee bij de token-exchange.
 */
export function generatePkce(): { codeVerifier: string; codeChallenge: string } {
  // 64 random bytes → 86-char base64url verifier (TikTok eist 43-128).
  const codeVerifier = randomBytes(64).toString('base64url');
  const codeChallenge = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  return { codeVerifier, codeChallenge };
}

/**
 * Bouwt de TikTok-authorisation-URL. State is een random nonce die we
 * later bij de callback verifieren (CSRF-bescherming). codeChallenge
 * is de PKCE-hash van de verifier die in een cookie gaat.
 */
export function buildAuthorizeUrl(state: string, codeChallenge: string): string {
  const { clientKey, redirectUri } = requireConfig();
  const params = new URLSearchParams({
    client_key: clientKey,
    response_type: 'code',
    scope: SCOPES.join(','),
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${AUTH_BASE}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_expires_in: number;
  open_id: string;
  scope: string;
  token_type: string;
}

/** Wissel de OAuth-code uit de callback om voor een access + refresh token.
 *  codeVerifier is de PKCE-verifier die we bij /connect hebben genereerd. */
export async function exchangeCodeForToken(
  code: string,
  codeVerifier: string,
): Promise<TokenResponse> {
  const { clientKey, clientSecret, redirectUri } = requireConfig();
  const body = new URLSearchParams({
    client_key: clientKey,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  const res = await fetch(`${API_BASE}/oauth/token/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = (await res.json()) as TokenResponse & { error?: string; error_description?: string };
  if (!res.ok || (json as { error?: string }).error) {
    throw new Error(
      `TikTok token-exchange faalde (${res.status}): ${(json as { error_description?: string }).error_description ?? JSON.stringify(json)}`,
    );
  }
  return json;
}

async function refreshToken(refreshTokenValue: string): Promise<TokenResponse> {
  const { clientKey, clientSecret } = requireConfig();
  const body = new URLSearchParams({
    client_key: clientKey,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshTokenValue,
  });
  const res = await fetch(`${API_BASE}/oauth/token/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = (await res.json()) as TokenResponse & { error?: string; error_description?: string };
  if (!res.ok || json.error) {
    throw new Error(
      `TikTok refresh-token faalde (${res.status}): ${json.error_description ?? JSON.stringify(json)}`,
    );
  }
  return json;
}

/** Haalt user.info zodat we display_name kunnen tonen in admin-UI. */
async function fetchUserInfo(accessToken: string): Promise<{ display_name?: string }> {
  const res = await fetch(`${API_BASE}/user/info/?fields=open_id,display_name`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = (await res.json()) as { data?: { user?: { display_name?: string } } };
  return json.data?.user ?? {};
}

/** Sla token op in DB. Roep aan na exchangeCodeForToken of refresh. */
async function persistToken(token: TokenResponse) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + token.expires_in * 1000);
  const refreshExpiresAt = new Date(now.getTime() + token.refresh_expires_in * 1000);
  let displayName: string | null = null;
  try {
    const info = await fetchUserInfo(token.access_token);
    displayName = info.display_name ?? null;
  } catch {
    // niet kritisch
  }
  await db
    .insert(schema.tiktokTokens)
    .values({
      id: TOKEN_ID,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt,
      refreshExpiresAt,
      openId: token.open_id,
      displayName,
      refreshedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.tiktokTokens.id,
      set: {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt,
        refreshExpiresAt,
        openId: token.open_id,
        displayName,
        refreshedAt: now,
      },
    });
}

/** Wisselt code voor token (met PKCE-verifier) en slaat 't op. */
export async function completeOAuth(
  code: string,
  codeVerifier: string,
): Promise<void> {
  const token = await exchangeCodeForToken(code, codeVerifier);
  await persistToken(token);
}

/**
 * Haalt de huidige access-token op. Refresht automatisch als 'm binnen
 * REFRESH_THRESHOLD_MS verloopt. Gooit een duidelijke error als er
 * helemaal geen token is — UI vraagt dan eerst om te verbinden.
 */
export async function ensureTikTokToken(): Promise<{
  accessToken: string;
  openId: string;
  displayName: string | null;
}> {
  const [row] = await db
    .select()
    .from(schema.tiktokTokens)
    .where(eq(schema.tiktokTokens.id, TOKEN_ID));
  if (!row) {
    throw new Error(
      'Geen TikTok-account verbonden — open /admin/api/social/tiktok/connect',
    );
  }

  const now = Date.now();
  const needsRefresh = row.expiresAt.getTime() - now < REFRESH_THRESHOLD_MS;
  if (!needsRefresh) {
    return {
      accessToken: row.accessToken,
      openId: row.openId,
      displayName: row.displayName,
    };
  }

  if (row.refreshExpiresAt.getTime() - now < 0) {
    throw new Error(
      'TikTok refresh-token verlopen — verbind het account opnieuw via /admin/api/social/tiktok/connect',
    );
  }

  const refreshed = await refreshToken(row.refreshToken);
  await persistToken(refreshed);
  return {
    accessToken: refreshed.access_token,
    openId: refreshed.open_id,
    displayName: row.displayName,
  };
}

// ─── Inbox upload (PULL_FROM_URL) ──────────────────────────────────────

export interface PublishInboxInput {
  videoUrl: string;
  caption?: string;
}

export interface PublishInboxResult {
  publishId: string;
}

/**
 * Plaatst een video als draft in de TikTok-app van de geconnecte
 * account. We gebruiken `PULL_FROM_URL` (TikTok pulls de video zelf
 * van Bunny CDN) zodat we geen multipart upload van de API hoeven
 * te doen — eenvoudig en snel.
 *
 * Status van de publish kan je daarna pollen via fetchPublishStatus(),
 * maar voor Inbox-mode is dat zelden nodig — zodra TikTok 'm heeft
 * gepulled, staat 'ie in de Drafts.
 */
export async function publishTikTokInbox(
  input: PublishInboxInput,
): Promise<PublishInboxResult> {
  const { accessToken } = await ensureTikTokToken();

  const body = {
    source_info: {
      source: 'PULL_FROM_URL',
      video_url: input.videoUrl,
    },
  };

  const res = await fetch(`${API_BASE}/post/publish/inbox/video/init/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as {
    data?: { publish_id?: string };
    error?: { code?: string; message?: string };
  };
  if (!res.ok || json.error?.code !== 'ok') {
    throw new Error(
      `TikTok inbox-publish faalde (${res.status}): ${json.error?.message ?? JSON.stringify(json)}`,
    );
  }
  if (!json.data?.publish_id) {
    throw new Error('TikTok inbox-publish: geen publish_id terug');
  }
  return { publishId: json.data.publish_id };
}

// ─── Photo carousel upload (Inbox) ───────────────────────────────────────

export interface PublishPhotoInboxInput {
  imageUrls: string[];
  /** Caption komt in TikTok-app waar de gebruiker 'm kan tweaken. */
  caption?: string;
}

/**
 * Carousel-foto's als draft in de TikTok-app van de geconnecte account.
 * TikTok pulls de images van Bunny (PULL_FROM_URL). Max 35 foto's per
 * post. In Inbox-mode publiceren ze niet automatisch — gebruiker tikt in
 * de TikTok-app op de draft en publisht handmatig.
 */
export async function publishTikTokPhotos(
  input: PublishPhotoInboxInput,
): Promise<PublishInboxResult> {
  if (input.imageUrls.length === 0) {
    throw new Error('TikTok photo-publish vereist minstens 1 image');
  }
  if (input.imageUrls.length > 35) {
    throw new Error(`TikTok carousel max 35 foto's — heeft ${input.imageUrls.length}`);
  }
  const { accessToken } = await ensureTikTokToken();

  const body: Record<string, unknown> = {
    media_type: 'PHOTO',
    // MEDIA_UPLOAD = inbox/draft (gebruiker publisht in TikTok-app);
    // DIRECT_POST zou direct posten en vereist extra approval.
    post_mode: 'MEDIA_UPLOAD',
    source_info: {
      source: 'PULL_FROM_URL',
      photo_images: input.imageUrls,
    },
  };
  if (input.caption) {
    (body as { post_info?: { description: string } }).post_info = {
      description: input.caption,
    };
  }

  const res = await fetch(`${API_BASE}/post/publish/content/init/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as {
    data?: { publish_id?: string };
    error?: { code?: string; message?: string };
  };
  if (!res.ok || json.error?.code !== 'ok') {
    throw new Error(
      `TikTok photo-publish faalde (${res.status}): ${json.error?.message ?? JSON.stringify(json)}`,
    );
  }
  if (!json.data?.publish_id) {
    throw new Error('TikTok photo-publish: geen publish_id terug');
  }
  return { publishId: json.data.publish_id };
}

export async function fetchPublishStatus(
  publishId: string,
): Promise<{ status: string; failReason?: string }> {
  const { accessToken } = await ensureTikTokToken();
  const res = await fetch(`${API_BASE}/post/publish/status/fetch/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ publish_id: publishId }),
  });
  const json = (await res.json()) as {
    data?: { status?: string; fail_reason?: string };
  };
  return {
    status: json.data?.status ?? 'UNKNOWN',
    failReason: json.data?.fail_reason,
  };
}

/** Read-only check of er een gekoppeld account is — voor admin-UI. */
export async function getTikTokConnection(): Promise<{
  connected: boolean;
  displayName: string | null;
  openId: string | null;
}> {
  const [row] = await db
    .select()
    .from(schema.tiktokTokens)
    .where(eq(schema.tiktokTokens.id, TOKEN_ID));
  if (!row) return { connected: false, displayName: null, openId: null };
  return {
    connected: true,
    displayName: row.displayName,
    openId: row.openId,
  };
}
