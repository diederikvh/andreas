-- Welke artiest hoort bij welk event, en hoe. Eén keer berekend (bij
-- binnenkomst, bij een nieuwe volger en 's nachts) in plaats van bij elke
-- vraag door alle titels te zoeken.
CREATE TABLE IF NOT EXISTS event_artists (
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  artist_id text NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  -- optreden: de artiest zelf. tribute: een eerbetoon aan de artiest.
  role text NOT NULL CHECK (role IN ('optreden', 'tribute')),
  -- lineup: gekoppelde line-up. titel: naam in de titel. admin: met de hand.
  source text NOT NULL CHECK (source IN ('lineup', 'titel', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, artist_id)
);
CREATE INDEX IF NOT EXISTS event_artists_artist_idx ON event_artists (artist_id);
