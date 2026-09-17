-- Artiesten volgen, en bericht krijgen bij een nieuwe avond.
CREATE TABLE IF NOT EXISTS artist_follows (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  artist_id text NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, artist_id)
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS push_artists boolean NOT NULL DEFAULT true;
ALTER TYPE reminder_kind ADD VALUE IF NOT EXISTS 'artiest';
