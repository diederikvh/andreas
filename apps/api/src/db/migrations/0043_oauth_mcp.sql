-- OAuth/OIDC-tabellen voor de better-auth mcp-plugin (OAuth-provider voor
-- MCP-clients). Idempotent. Kolomnamen snake_case (drizzle-adapter casing).

CREATE TABLE IF NOT EXISTS oauth_application (
  id text PRIMARY KEY,
  name text NOT NULL,
  icon text,
  metadata text,
  client_id text NOT NULL UNIQUE,
  client_secret text,
  redirect_urls text NOT NULL,
  type text NOT NULL,
  disabled boolean NOT NULL DEFAULT false,
  user_id text REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_access_token (
  id text PRIMARY KEY,
  access_token text NOT NULL UNIQUE,
  refresh_token text NOT NULL UNIQUE,
  access_token_expires_at timestamptz NOT NULL,
  refresh_token_expires_at timestamptz NOT NULL,
  client_id text NOT NULL,
  user_id text REFERENCES users(id) ON DELETE CASCADE,
  scopes text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_consent (
  id text PRIMARY KEY,
  client_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes text NOT NULL,
  consent_given boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_application_user_idx ON oauth_application(user_id);
CREATE INDEX IF NOT EXISTS oauth_access_token_client_idx ON oauth_access_token(client_id);
CREATE INDEX IF NOT EXISTS oauth_access_token_user_idx ON oauth_access_token(user_id);
CREATE INDEX IF NOT EXISTS oauth_consent_client_idx ON oauth_consent(client_id);
CREATE INDEX IF NOT EXISTS oauth_consent_user_idx ON oauth_consent(user_id);
