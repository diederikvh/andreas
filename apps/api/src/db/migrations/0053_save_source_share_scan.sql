-- Import-flow ("Share naar Andreas", docs/share-naar-andreas.md) levert
-- saves op die niet van een scherm komen maar van buiten de app: via de
-- native share-sheet ('share') en straks via de poster-scanner ('scan').
-- Zonder deze waarden valt zo'n save als NULL in de discovery-trail en
-- weet je niet dat de import-lus werkt.
--
-- Draai dit VOOR je de API met de nieuwe SAVE_SOURCES deployt: de client
-- mag 'share' al meesturen (onbekende waarden worden nu stil NULL), maar
-- een server die 'share' doorlaat naar een enum zonder die waarde geeft
-- een insert-error.
ALTER TYPE save_source ADD VALUE IF NOT EXISTS 'share';
ALTER TYPE save_source ADD VALUE IF NOT EXISTS 'scan';

-- En 'going': de plannen-lijst (/going) navigeert al sinds z'n bestaan met
-- ?source=going, maar die waarde bestond nergens — dus elke save vanaf je
-- eigen plannen verloor stil z'n attributie. Zelfde klasse fout als 'new'
-- destijds.
ALTER TYPE save_source ADD VALUE IF NOT EXISTS 'going';
