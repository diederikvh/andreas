# @andreas/video-gen

Remotion-renderer voor de dagelijkse Instagram Reels. Eén compositie
(`DailyFilms5`) die met variabele data tot een ~14s, 9:16, 1080×1920 MP4
renderen die direct als Reel kan worden geüpload.

## Lokaal gebruik

Vers renderen met de sample-data:

```sh
pnpm --filter @andreas/video-gen render
# → apps/video-gen/out/films.mp4
```

Live data van de API (vereist admin API-key in env als `ADMIN_API_KEY`):

```sh
curl -s -H "Authorization: Bearer $ADMIN_API_KEY" \
  "https://api.andreas.amsterdam/admin/api/social/video-props?theme=film" \
  > apps/video-gen/src/data/today.json

pnpm --filter @andreas/video-gen render:live
```

Geldige `theme`-waardes: `theater`, `live-music`, `film`, `weekend-kickoff`,
`galleries`, `tonight`, `week-preview`. Zie
`apps/api/src/social/themes.ts` voor de actuele lijst.

**Film-specifiek**: het `video-props` endpoint kiest voor het `film`-thema
automatisch de `stillUrl` (frame uit trailer), fallback naar `posterUrl`,
fallback naar `imageUrl`.

Studio (live preview met scrubber):

```sh
pnpm --filter @andreas/video-gen studio
```

## Posten naar Instagram

Upload de MP4 via de admin-UI:

1. Open https://api.andreas.amsterdam/admin/social
2. Sectie **"Video uploaden + posten als Reel"**
3. Kies thema, plak caption, selecteer `out/films.mp4`
4. Klik "Upload + post als Reel"

De backend:
- Slaat de video op Bunny CDN op (`social-videos/<datum>-<theme>-<id>.mp4`)
- Maakt een IG-Reel-container (`media_type=REELS`, `share_to_feed=true`)
- Publiceert via `media_publish` (met onze 4/2207051-workaround)
- Logt 'm in `socialPosts` zodat 'ie in het admin-overzicht verschijnt

## Sjabloon aanpassen

Animaties + layout staan in
`src/compositions/DailyFilms5.tsx`. Schema (5 picks + themeKicker) is
gedeeld met de `/admin/api/social/video-props` endpoint — als je het
schema uitbreidt, pas ook die endpoint aan.
