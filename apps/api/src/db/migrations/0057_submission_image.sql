-- Een beeld bij een aanmelding.
--
-- Twee bronnen, in deze volgorde: de poster die de aanmelder zelf
-- meegaf (image_url), en anders de foto van de zaal als we die kennen
-- (via venue_id, geen kolom nodig). Zonder allebei blijft het de
-- gekleurde lettertegel.
--
-- image_url is altijd een bewuste keuze van de aanmelder en staat
-- standaard uit; bij een ticket bestaat die keuze niet.
ALTER TABLE event_submissions ADD COLUMN IF NOT EXISTS image_url text;
