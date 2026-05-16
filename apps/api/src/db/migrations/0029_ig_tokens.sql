-- Eén rij in deze tabel houdt de huidige IG access-token bij. We
-- migreren de token vanuit env naar DB zodat we 'm via een API-call
-- kunnen verversen (long-lived tokens vervallen na 60d en moeten
-- periodiek worden verlengd). De primary key is een vaste sentinel
-- 'main' — een single-row tabel.

CREATE TABLE IF NOT EXISTS ig_tokens (
  id text PRIMARY KEY,
  access_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
