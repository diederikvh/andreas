-- Wanneer we voor het laatst genres voor deze artiest bij Last.fm zochten,
-- ook als er niets uitkwam. Zelfde idee als image_tried_at: anders blijft
-- een onbekende artiest elke nacht vooraan in de wachtrij staan.
ALTER TABLE artists ADD COLUMN IF NOT EXISTS genres_tried_at timestamptz;
