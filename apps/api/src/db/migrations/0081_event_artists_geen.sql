-- "geen": met de hand geblokkeerd. Een koppeling die de job zou vinden
-- maar die niet klopt (naamgenoot, bio-vermelding).
ALTER TABLE event_artists DROP CONSTRAINT IF EXISTS event_artists_role_check;
ALTER TABLE event_artists ADD CONSTRAINT event_artists_role_check CHECK (role IN ('optreden', 'tribute', 'werk_van', 'covers', 'geen'));
