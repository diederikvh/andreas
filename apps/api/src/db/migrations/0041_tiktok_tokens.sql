-- TikTok Content Posting API OAuth tokens.
-- Eén rij per app (id='main'). Access-token 24h, refresh-token 365d.
CREATE TABLE IF NOT EXISTS "tiktok_tokens" (
  "id" text PRIMARY KEY,
  "access_token" text NOT NULL,
  "refresh_token" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "refresh_expires_at" timestamptz NOT NULL,
  "open_id" text NOT NULL,
  "display_name" text,
  "refreshed_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
