# Audio voor de video-templates

IG's Graph API laat geen muziek-keuze uit de IG-library toe — daarom bundelen
we de audio in de Remotion-render zelf. Twee bestanden verwacht:

- `justin.mp3` — JustIn template (~16s; urgent/news/electronic vibe)
- `daily.mp3` — DailyFilms5 / overige themes (~22s; warm/cinematic/indie vibe)

## Aanbevolen tracks (royalty-free, Pixabay)

### JustIn — urgent, beat-driven
Ga naar https://pixabay.com/music/ en zoek op één van:
- "news intro"
- "tech house short"
- "breaking news"
- "synthwave loop"

Een goede match: **https://pixabay.com/music/synthwave-cyber-attack-271898/**
Klik "Download" (vereist een gratis Pixabay-account) → save als `justin.mp3` in
deze folder.

### DailyFilms5 — warm, cinematic
Zoek op:
- "cinematic uplifting"
- "indie acoustic"
- "ambient inspiration"

Bijvoorbeeld: **https://pixabay.com/music/beautiful-plays-115810/** →
save als `daily.mp3` in deze folder.

## Gebruik

Audio wordt automatisch meegerenderd zodra `audio` in de props staat. De
sample-JSON's verwijzen naar `audio/justin.mp3` en `audio/daily.mp3`. Bestand
ontbreekt → render werkt zonder audio.

Geluidvolume staat op 60% (`volume={0.6}` in beide composities). Aanpasbaar
in `JustIn.tsx` / `DailyFilms5.tsx`.

## Licenties

Pixabay's audio is Content Licence (vrij commercieel gebruik, geen attribution
verplicht). Documenteer de tracks die je daadwerkelijk gebruikt in
`apps/api/src/social/` voor het geval Meta vraagt naar audio-bron.
