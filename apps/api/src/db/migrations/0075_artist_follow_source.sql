-- Waar een gevolgde artiest vandaan komt: 'spotify' als hij via de
-- Spotify-koppeling binnenkwam, leeg als je hem zelf volgde. De app toont
-- daarmee een Spotify-icoontje, zodat ontvolgen zichtbaar een keuze is.
ALTER TABLE artist_follows ADD COLUMN IF NOT EXISTS source text;

-- Wie al gekoppeld is: alles wat we van Spotify overnamen (spotify_links.seen,
-- namen in kleine letters) krijgt de bron alsnog.
UPDATE artist_follows af SET source = 'spotify'
FROM spotify_links sl, artists a
WHERE af.user_id = sl.user_id AND a.id = af.artist_id
  AND af.source IS NULL AND sl.seen ? lower(a.name);
