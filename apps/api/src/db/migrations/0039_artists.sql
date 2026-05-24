-- Canonical artist-records, gedeeld over events. Eén row per artist;
-- lineup-items in `occurrences.lineup` linken via een optioneel
-- `artistId`-veld in de JSON-blob (geen FK want JSON, app-niveau
-- consistentie). Een artist verschijnt typisch in meerdere events
-- (DJ-residency, festival-tour, etc) — deze tabel voorkomt N MB-
-- lookups voor één artist.
--
-- Velden zijn allemaal nullable behalve id+name+createdAt. Enrichment
-- vult de rest in waar mogelijk; events kunnen ook een artist linken
-- die we nooit MB-matched hebben gekregen (`enrichedAt` zegt dan
-- "geprobeerd, niets gevonden" → niet elke nacht opnieuw zoeken).
--
-- Display-prioriteit van streaming-links is mobile-side: Spotify >
-- Apple Music > Bandcamp > YouTube > official.

CREATE TABLE IF NOT EXISTS artists (
  id text PRIMARY KEY,
  name text NOT NULL,
  -- MusicBrainz UUID. Unique zodat hetzelfde MB-record niet twee
  -- artist-rows kan voeden. Nullable: een artist kan ook bestaan
  -- zonder MB-match (geprobeerd, niks gevonden — we houden de naam
  -- vast zodat lineup-items er nog naar kunnen wijzen).
  mbid text UNIQUE,
  description text,
  image_url text,
  -- Streaming + content links. CC0-data (MB) is OK om te cachen.
  spotify_url text,
  apple_music_url text,
  bandcamp_url text,
  youtube_url text,
  official_url text,
  genres text[] NOT NULL DEFAULT ARRAY[]::text[],
  -- Timestamp van laatste enrich-poging — succesvol of niet. Bij
  -- "niet gevonden" gebruiken we dit om niet dagelijks opnieuw te
  -- zoeken (retry-window bv. 7 dagen).
  enriched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

-- Case-insensitive unique op naam zodat "DJ SWISHA" en "Dj Swisha"
-- naar één record dedupen. Lineup-enrich gebruikt `LOWER(name) = LOWER($1)`
-- voor lookups vóór 'ie een MB-search start.
CREATE UNIQUE INDEX IF NOT EXISTS artists_name_lower_idx
  ON artists (LOWER(name));

-- Voor de "alle events van deze artist"-query op de mobile artist-
-- pagina: we filteren occurrences.lineup op een artistId. JSONB-GIN
-- maakt dat snel zonder per-event scan.
CREATE INDEX IF NOT EXISTS occurrences_lineup_gin_idx
  ON occurrences USING GIN (lineup jsonb_path_ops);
