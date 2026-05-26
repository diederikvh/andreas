-- Drop CHECK constraint die slot beperkte tot ('morning','afternoon','evening').
-- De slot-kolom bevat nu theme-keys (theater, live-music, film, …) die
-- dynamisch uit themes.ts komen; we vertrouwen op de TS-types i.p.v. een
-- DB-enum.
ALTER TABLE social_posts DROP CONSTRAINT IF EXISTS social_posts_slot_check;
