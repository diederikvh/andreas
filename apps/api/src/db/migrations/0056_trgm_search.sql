-- Fuzzy zoeken op titel en zaalnaam, voor de import.
--
-- /search doet `ILIKE '%naald%'`. De OCR van een poster of ticket leest
-- geregeld één letter verkeerd — "Pagadiso", "The Afghan Wighs" — en dan
-- komen er nul rijen terug. Geen enkele weging aan de clientkant redt dat:
-- er is niets om op te scoren. Trigrammen wel.
--
-- De index is puur additief: zonder `fuzzy=1` verandert er niets aan
-- /search, en aan de bestaande ILIKE-paden ook niet.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS events_title_trgm
  ON events USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS venues_name_trgm
  ON venues USING gin (name gin_trgm_ops);
