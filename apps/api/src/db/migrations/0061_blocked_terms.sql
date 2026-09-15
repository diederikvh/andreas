-- Trefwoorden die een event bij binnenkomst op niet-live zetten.
CREATE TABLE IF NOT EXISTS blocked_terms (
  term text PRIMARY KEY,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
