-- Wie mag zien waar ik heen ga. Zelfde drie standen als saves_visibility
-- en hetzelfde enum-type, maar een eigen kolom, zodat je je likes met
-- vrienden kunt delen en je afspraken niet (of andersom).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS going_visibility saves_visibility NOT NULL DEFAULT 'friends';
