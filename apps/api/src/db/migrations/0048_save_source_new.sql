-- /new wordt de belangrijkste save-plek, dus die verdient een eigen
-- bron-label. Zonder dit zou elke save vanaf de dagelijkse lijst als
-- 'other' in de spiegel-breakdown landen en klopt de discovery-trail niet.
ALTER TYPE save_source ADD VALUE IF NOT EXISTS 'new';
