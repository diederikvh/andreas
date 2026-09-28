-- Dubbel event (zelfde zaal, zelfde begintijd, zelfde act of titel): het
-- kleinere exemplaar gaat offline en wijst naar het event dat blijft.
ALTER TABLE events ADD COLUMN IF NOT EXISTS duplicate_of text REFERENCES events(id) ON DELETE SET NULL;
