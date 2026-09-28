-- Componisten: een gevolgde componist wiens werk op het programma staat.
ALTER TABLE event_artists DROP CONSTRAINT IF EXISTS event_artists_role_check;
ALTER TABLE event_artists ADD CONSTRAINT event_artists_role_check CHECK (role IN ('optreden', 'tribute', 'werk_van'));
ALTER TABLE event_artists DROP CONSTRAINT IF EXISTS event_artists_source_check;
ALTER TABLE event_artists ADD CONSTRAINT event_artists_source_check CHECK (source IN ('lineup', 'titel', 'programma', 'admin'));
