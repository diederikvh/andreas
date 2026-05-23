-- Drie nieuwe velden op `events` voor de poster/still-split en trailer-URL.
--
-- Waarom split:
--   - `imageUrl` blijft "best beschikbare beeld" (legacy, gemengd
--     poster/still afhankelijk van scraper).
--   - `posterUrl` = verticale poster (TMDb of venue-poster), voor
--     lijst-thumbs in /films, /live, /theater, /clubs, Agenda en de
--     Vandaag-rails.
--   - `stillUrl` = landscape sfeerbeeld (TMDb backdrop of venue-still),
--     voor de event-detail hero.
--   - `trailerUrl` = full YouTube/Vimeo URL voor films met een trailer
--     beschikbaar via TMDb's /movie/{id}/videos endpoint.
--
-- Display-prioriteit:
--   - Lijst-thumb: posterUrl ?? imageUrl ?? venueImageUrl
--   - Detail-hero: stillUrl ?? imageUrl
--   - Trailer-knop: alleen tonen als trailerUrl niet null is
--
-- Nullable + geen default: niet alle events hebben TMDb-match,
-- en niet-film events (Theater, Muziek, etc) hebben dit per definitie
-- niet — die houden alleen imageUrl.

ALTER TABLE events ADD COLUMN IF NOT EXISTS poster_url text;
ALTER TABLE events ADD COLUMN IF NOT EXISTS still_url text;
ALTER TABLE events ADD COLUMN IF NOT EXISTS trailer_url text;
