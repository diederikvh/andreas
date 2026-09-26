-- Genres leuk of niet leuk vinden, en herkennen wat er via Claude gered is.
ALTER TYPE save_source ADD VALUE IF NOT EXISTS 'mcp';
CREATE TABLE IF NOT EXISTS genre_prefs (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  genre text NOT NULL,
  sentiment text NOT NULL CHECK (sentiment IN ('like', 'dislike')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, genre)
);
