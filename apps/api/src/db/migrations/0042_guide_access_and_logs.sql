-- Conversationele zoek ("Andreas-gids"): per-user toegang + gebruik-logging.
-- Idempotent (IF NOT EXISTS) zodat herhaald draaien veilig is.

-- Per-user opt-in voor de gids. Default false → feature is uit tenzij
-- expliciet aangezet via het admin-paneel.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS guide_enabled boolean NOT NULL DEFAULT false;

-- Log per gids-vraag: kostenrem (tel laatste 24u) + productinzicht (§10).
CREATE TABLE IF NOT EXISTS zoek_logs (
  id text PRIMARY KEY,
  user_id text REFERENCES users(id) ON DELETE SET NULL,
  message text NOT NULL,
  profile jsonb,
  shown_event_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS zoek_logs_created_at_idx ON zoek_logs (created_at);
CREATE INDEX IF NOT EXISTS zoek_logs_user_idx ON zoek_logs (user_id);
