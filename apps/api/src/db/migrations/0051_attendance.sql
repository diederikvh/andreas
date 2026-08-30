-- "Ik ga hierheen" zonder dat er een uitnodiging aan te pas komt.
-- Zie de toelichting bij `attendance` in schema.ts voor waarom dit
-- naast saves en invitation_responses staat en geen status-kolom heeft.
CREATE TABLE IF NOT EXISTS attendance (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  occurrence_id text NOT NULL REFERENCES occurrences(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  source save_source,
  PRIMARY KEY (user_id, occurrence_id)
);

CREATE INDEX IF NOT EXISTS attendance_occurrence_idx ON attendance (occurrence_id);
