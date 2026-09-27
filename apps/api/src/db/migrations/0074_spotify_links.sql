-- Een blijvende Spotify-koppeling: elke nacht volgen we de artiesten die je
-- op Spotify nieuw volgt. De refresh-token staat versleuteld (AES-GCM, sleutel
-- afgeleid van het auth-geheim). `seen` = artiesten die we al hebben
-- overgenomen, zodat een ontvolging in Andreas niet elke nacht terugkomt.
CREATE TABLE IF NOT EXISTS spotify_links (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_enc text NOT NULL,
  seen jsonb NOT NULL DEFAULT '[]'::jsonb,
  connected_at timestamptz NOT NULL DEFAULT now(),
  last_sync_at timestamptz,
  last_added integer NOT NULL DEFAULT 0
);
