-- "Geen artiest": een feest, quiz of jamsessie waar geen artiest bij hoort.
-- Gezet vanuit de admin, zodat zo'n event niet elke keer terugkomt in de
-- lijst met concerten zonder artiest.
ALTER TABLE events ADD COLUMN IF NOT EXISTS no_artist boolean NOT NULL DEFAULT false;
