-- Herinneringen: automatisch (dag ervoor, vanavond) en zelfgezet.
DO $$ BEGIN
  CREATE TYPE reminder_kind AS ENUM ('dag-ervoor', 'vanavond', 'zelf');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS reminders (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  occurrence_id text NOT NULL REFERENCES occurrences(id) ON DELETE CASCADE,
  kind reminder_kind NOT NULL,
  fire_at timestamptz NOT NULL,
  note text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS reminders_user_occ_kind_idx
  ON reminders (user_id, occurrence_id, kind);
CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders (fire_at, sent_at);

ALTER TABLE users ADD COLUMN IF NOT EXISTS push_daily_new boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS push_day_before boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS push_tonight boolean NOT NULL DEFAULT true;
