-- Voeg 'favorites' toe aan saves_visibility en mirror_visibility enums.
-- Met deze waarde delen gebruikers hun saves of spiegel alleen met
-- vrienden die hen als favoriet hebben gemarkeerd (`friend_favorites`-
-- rij van A→Mij). Bestaande rijen ('friends' default) blijven werken.

ALTER TYPE "public"."saves_visibility" ADD VALUE IF NOT EXISTS 'favorites';
ALTER TYPE "public"."mirror_visibility" ADD VALUE IF NOT EXISTS 'favorites';
