-- Meldingsregels: "laat me weten als er hiphop in Paradiso bijkomt".
CREATE TABLE IF NOT EXISTS alerts (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label text NOT NULL,
  venue_ids text[],
  cities city[],
  categories event_category[],
  genres text[],
  artist_names text[],
  price_max_cents integer,
  starts_from timestamptz,
  starts_until timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alerts_user_idx ON alerts(user_id);
ALTER TYPE reminder_kind ADD VALUE IF NOT EXISTS 'regel';
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS alert_id text REFERENCES alerts(id) ON DELETE CASCADE;
