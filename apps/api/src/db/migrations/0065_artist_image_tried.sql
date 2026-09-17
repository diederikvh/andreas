-- Onthouden dát we een foto gezocht hebben, niet alleen of we er een
-- vonden. Zonder dit blijft "image_url IS NULL" de enige vlag en komen
-- de artiesten die Spotify niet kent elke nacht opnieuw bovenaan de rij
-- te staan (74 van de eerste 200 op het moment van schrijven).
ALTER TABLE artists ADD COLUMN IF NOT EXISTS image_tried_at timestamptz;

-- Wie al een foto heeft is per definitie geprobeerd.
UPDATE artists SET image_tried_at = now() WHERE image_url IS NOT NULL AND image_tried_at IS NULL;
