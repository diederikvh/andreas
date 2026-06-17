-- effectiveGenres: de getoonde genre-labels = eigen event-genres PLUS de
-- genres van de gelinkte line-up-artiesten (techno/house/…), eigen eerst,
-- gecapt. Bijgewerkt door /admin/api/recompute-effective-genres (daily). De
-- `genres`-kolom blijft de "eigen" set die de genre-enrich-pipeline bezit;
-- deze kolom is puur afgeleid (geen interferentie met die jobs).
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS effective_genres text[] NOT NULL DEFAULT ARRAY[]::text[];
