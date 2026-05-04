# n8n → Andreas API

Handout voor n8n-workflows die data in Andreas pompen. Eén-pager.

## Auth

Eén header op elke call. Token zit in n8n credentials → "Header Auth":

```
Authorization: Bearer <ADMIN_API_KEY>
```

Zonder header → `401 unauthorized`. De key staat in Fly secrets onder `ADMIN_API_KEY` — uitlezen met `fly ssh console -a andreas-api -C 'printenv ADMIN_API_KEY'`.

## Base URL

```
https://api.andreas.amsterdam/admin/api
```

Alle endpoints accepteren + retourneren JSON tenzij expliciet anders. Velden gebruiken camelCase, datums zijn ISO-strings (`2026-10-14T22:00:00+02:00`), categorieën zijn een vaste enum: `Muziek`, `Theater`, `Literatuur`, `Film`.

## Volgorde van vullen

1. **Venues eerst** — events refereren naar een venue via `venueId`. Geen venue = geen event.
2. **Events** — kunnen op losse venues, of (later) als onderdeel van een serie.
3. **Series** — alleen nodig als events bij een overkoepelende cyclus horen (ADE, Lenteballet, London Calling). Serie + losse `link`-call koppelt bestaande events.

## Belangrijke tips (lees deze eerst)

Drie dingen die je niet wilt vergeten als je je flows bouwt:

1. **Stabiele eigen `id`** per entiteit — anders maakt elke run een nieuw record aan. Suggestie:
   - Venues: kort en herkenbaar, bv. `paradiso`, `melkweg`, `occii`.
   - Events: `evt-<venueSlug>-<YYYY-MM-DD>-<slug-titel>`. Voorbeeld: `evt-paradiso-2026-10-14-vince-staples`.
   - Series: `series-<slug>` met jaartal als nodig, bv. `series-ade-2026`.
   Met stabiele `id` kun je `PATCH /events/:id` doen bij her-runs ipv telkens nieuwe rows.

2. **Expliciete tijdzone** in `startsAt` / `endsAt`. Amsterdam is `+02:00` (zomer) of `+01:00` (winter). `Z` (UTC) werkt ook, maar maakt debugging lastiger en misverstanden over "om 21:00" makkelijker. Gebruik `2026-10-14T20:30:00+02:00`.

3. **Drafts via `published: false`**. Bij create een event/venue/series op `published: false` zetten betekent dat hij niet zichtbaar is in de app. Jij zet 'm vanuit `/admin` aan zodra hij gereviewd is. Geen aparte staging-omgeving nodig.

## Snelle preview / kill-switch

Elke entiteit heeft een `published` boolean. Default `true`. Zet 'm op `false` om iets te verbergen zonder te verwijderen — saves, koppelingen en geschiedenis blijven intact. Handig voor:
- Een event drafts laten staan terwijl je nog redigeert (`published:false` bij create).
- Live een event afgelasten (`PATCH` met `published:false`).
- Een venue tijdelijk uitzetten zonder events kwijt te raken.

Alle public endpoints (`/events`, `/venues`, `/series`, friend-feeds) filteren automatisch op `published=true`.

---

## Venues

```
POST /venues
GET /venues
GET /venues/:id
PATCH /venues/:id
DELETE /venues/:id
```

**POST body** (allen behalve `name` zijn optioneel):

```json
{
  "id": "paradiso",                    // optioneel — slug-based default uit naam
  "slug": "paradiso",                  // optioneel — wordt slug-versie van name
  "name": "Paradiso",
  "address": "Weteringschans 6-8, Amsterdam",
  "lat": 52.3622,
  "lng": 4.8836,
  "description": "Pop-tempel in een oud kerkgebouw.",
  "imageUrl": "https://andreas-x.b-cdn.net/media/venues/...jpg",
  "categories": ["Muziek", "Film"],
  "priceNote": "lidmaatschap vereist",  // optioneel — default voor alle events op deze venue
  "published": true
}
```

**Tips voor n8n-flows per venue**:
- Hou `id` stabiel (bv. `"paradiso"`, `"melkweg"`). Gebruik 'm in events.
- `categories` mag leeg, maar mét tags wordt 'ie filterbaar in de Venues-tab.
- `imageUrl` moet een publieke URL zijn — gebruik `/admin/api/uploads` (zie onderaan) als je 'm op onze CDN wilt.

**Idempotent maken**: bij een herhaalde flow probeer eerst `PATCH /venues/:id`. Als dat 404 returnt, doe `POST` met expliciete `id`. Met expliciete `id` kun je dezelfde venue veilig her-uploaden.

---

## Events

```
POST /events
GET /events
GET /events/:id
PATCH /events/:id
DELETE /events/:id
```

**POST body** (`title`, `venueId`, `startsAt` verplicht):

```json
{
  "id": "evt-paradiso-2026-10-14-vince-staples",   // optioneel — auto als leeg
  "title": "Vince Staples",
  "venueId": "paradiso",
  "startsAt": "2026-10-14T20:30:00+02:00",
  "endsAt": "2026-10-14T23:00:00+02:00",            // optioneel
  "description": "Vince doet de grote zaal.",
  "category": "Muziek",
  "imageUrl": "https://andreas-x.b-cdn.net/media/events/...jpg",
  "ticketUrl": "https://paradiso.nl/...",
  "priceCents": 3250,                                // 0 = "Gratis", null = "—"
  "priceNote": "lidmaatschap vereist",               // optioneel — overschrijft venues.priceNote
  "genres": ["techno", "house"],                     // 0–3 vrije strings, lowercase
  "featured": false,                                 // editorial-pick voor Avond
  "published": true
}
```

**Tips per scrape-flow**:
- Geef events een **stabiele `id`** zodat herhaalde runs idempotent zijn. Format suggestie: `evt-<venueSlug>-<YYYY-MM-DD>-<slug-titel>`. Re-runnen overschrijft niet (we hebben geen upsert) — gebruik `PATCH /events/:id` als de event al bestaat.
- **Tijdzone**: Amsterdam-events zijn `+02:00` (zomer) of `+01:00` (winter). `Z` (UTC) werkt ook maar maakt debugging lastiger. Geef expliciete TZ.
- **`priceCents`** is een int: `1250` = €12,50. `null` (of weglaten) toont "—" in de app.
- **`featured`** alleen aanzetten als de curator deze wil pinnen op de Avond-tab. Beperk tot ~3-5 actieve featured events tegelijk.
- **Onbekende venue?** `400` met `venue X bestaat niet` — zorg dat je flow eerst venues seedt.

### Prijs-noot

Onder de prijs op event-detail kan een korte vrije tekst staan (bv. "lidmaatschap vereist", "pay-what-you-can aan de deur"). Geen tekst → niets onder de prijs.

Resolutie:
1. `events.priceNote` (per-event) — wint als gevuld.
2. anders `venues.priceNote` (default voor de venue).
3. anders niets.

Best practice: zet de noot op de venue als hij voor álle events daar geldt (Paradiso → "lidmaatschap vereist"). Gebruik `events.priceNote` alleen voor uitzonderingen (bv. een gratis showcase in een betaalde venue → `priceNote: "gratis — alleen vanavond"`). Houd het kort, max ~40 tekens, zonder hoofdletter, geen punt aan het eind. Het verschijnt in mono-stijl onder de prijs.

### Genres — best practice

`genres` is een array van vrije strings. Geen enum, geen vaste lijst — maar kies bewust, want de filter in de app groepeert ze per categorie.

- **Lowercase, geen spaties**: `hip-hop` ipv `Hip Hop`, `drum-en-bass` ipv `Drum & Bass`. Hyphens als scheidingsteken.
- **1–3 genres per event** — meer wordt geruis. Eerste genre staat als label op de event-rij (naast de categorie-tag), de rest is alleen zichtbaar op event-detail en in de filter.
- **Categorie-bewust** — kies genres die passen bij `category`. De filter scheidt ze visueel per categorie, dus `techno` op een Theater-event is verwarrend.
  - **Muziek**: `techno`, `house`, `hip-hop`, `r-en-b`, `jazz`, `klassiek`, `ambient`, `drum-en-bass`, `pop`, `rock`, `indie`, `experimenteel`, `wereld`, `disco`, `gabber`.
  - **Theater**: `drama`, `dans`, `cabaret`, `performance`, `kindertheater`, `improvisatie`, `mime`.
  - **Film**: `arthouse`, `documentaire`, `horror`, `sci-fi`, `klassiek`, `kortfilm`, `animatie`.
  - **Literatuur**: `poëzie`, `roman`, `essay`, `lezing`, `slam`, `non-fictie`.
  - **Kunst/galerie/museum** (gebruikt category `Theater` of via venues): `schilderkunst`, `fotografie`, `conceptueel`, `sculptuur`, `video-art`, `installatie`.
- **Distinct endpoint**: `GET /events/genres` retourneert alle gebruikte genres met counts per categorie. Handig om te zien welke spelling je per ongeluk twee keer hebt (`hiphop` + `hip-hop` etc.).

---

## Series (festivals/cycli)

```
POST /series
GET /series
GET /series/:id
PATCH /series/:id
DELETE /series/:id
POST /series/:id/events/:eventId          // koppel event aan serie
DELETE /series/:id/events/:eventId        // ontkoppel
```

**POST body** (`name` verplicht):

```json
{
  "id": "series-ade-2026",                 // optioneel
  "slug": "ade-2026",
  "name": "ADE 2026",
  "description": "Amsterdam Dance Event 2026.",
  "imageUrl": "https://andreas-x.b-cdn.net/media/series/...jpg",
  "startsAt": "2026-10-14T18:00:00+02:00",  // optioneel
  "endsAt": "2026-10-18T06:00:00+02:00",    // optioneel — leeg = doorlopend
  "categories": ["Muziek"],
  "published": true
}
```

**Belangrijk**: na `endsAt` verdwijnt de serie automatisch uit pills/tags op events en venues. Detail-pagina blijft toegankelijk via gedeelde links. Series zonder `endsAt` blijven altijd zichtbaar.

**Koppel-flow** voor n8n:

```
1. POST /series                                            → krijg serie-id
2. POST /events                                            → krijg event-id
3. POST /series/<seriesId>/events/<eventId>                → koppel
   (idempotent: dubbel-koppelen geeft geen fout)
```

Voor ADE 2026 typische flow: één n8n-workflow voor het ADE-programma, scrape per dag/venue events + creëer/update + koppel aan `series-ade-2026`.

---

## Image-uploads

Drie opties — kies wat past bij je n8n-flow.

### Optie A — Source-URL doorvoeren (aanbevolen)

n8n geeft de externe foto-URL door, onze API fetcht 'm en zet 'm op Bunny.

```
POST /admin/api/uploads
Content-Type: application/json

{
  "sourceUrl": "https://paradiso.nl/uploads/foo.jpg",
  "kind": "events"     // events|venues|series|misc — bepaalt het sub-pad
}
```

Antwoord:

```json
{ "url": "https://andreas-x.b-cdn.net/media/events/1729872000000-abc123.jpg" }
```

Die `url` plak je vervolgens in `imageUrl` op je event/venue/series. Voordeel: image is voor altijd gehost op onze CDN, ook als de bron-site offline gaat of de URL verandert.

### Optie B — File upload via multipart

Gebruik dit als n8n een binary file in handen heeft (geen URL maar een buffer).

```
POST /admin/api/uploads
Content-Type: multipart/form-data

file:  <binary>
kind:  events
```

Antwoord identiek aan optie A.

### Optie C — Externe URL direct gebruiken

Skip onze CDN, plak een externe URL rechtstreeks in `imageUrl`. Werkt, maar:
- Bron kan offline gaan → broken image in de app.
- Geen CDN-caching aan onze kant → tragere laadtijden.

Goed genoeg voor prototypes; voor productie liever optie A.

**Limieten**: max 8 MB per bestand, alleen `image/*` content-type (jpg/png/webp/gif/avif). Bestanden krijgen automatisch een tijdstempel + random suffix om collisions te vermijden.

---

## Voorbeelden — full curl

Een volledige flow vanaf nul, om je n8n HTTP Request nodes mee af te stemmen:

```bash
# Auth-header (of zet dit in n8n als variable)
H="Authorization: Bearer $ADMIN_API_KEY"
BASE=https://api.andreas.amsterdam/admin/api

# 1. Maak venue
curl -X POST $BASE/venues -H "$H" -H "Content-Type: application/json" -d '{
  "id": "paradiso",
  "slug": "paradiso",
  "name": "Paradiso",
  "address": "Weteringschans 6-8, Amsterdam",
  "lat": 52.3622,
  "lng": 4.8836,
  "categories": ["Muziek", "Film"]
}'

# 2. Upload poster naar Bunny
POSTER=$(curl -s -X POST $BASE/uploads -H "$H" -H "Content-Type: application/json" -d '{
  "sourceUrl": "https://paradiso.nl/posters/vince-staples.jpg",
  "kind": "events"
}' | jq -r .url)

# 3. Maak event
curl -X POST $BASE/events -H "$H" -H "Content-Type: application/json" -d "{
  \"id\": \"evt-paradiso-2026-10-14-vince-staples\",
  \"title\": \"Vince Staples\",
  \"venueId\": \"paradiso\",
  \"startsAt\": \"2026-10-14T20:30:00+02:00\",
  \"category\": \"Muziek\",
  \"genres\": [\"hip-hop\"],
  \"imageUrl\": \"$POSTER\",
  \"priceCents\": 3250,
  \"ticketUrl\": \"https://paradiso.nl/event/vince\"
}"

# 4. Koppel aan ADE-serie (als die er al is)
curl -X POST $BASE/series/series-ade-2026/events/evt-paradiso-2026-10-14-vince-staples \
  -H "$H"
```

---

## Foutcodes

| Code | Betekent |
|---|---|
| `400` | Validatie-fout (ontbrekend veld, ongeldige datum, onbekende venueId). Body bevat `error`. |
| `401` | Bearer-header ontbreekt of klopt niet. |
| `404` | `:id` bestaat niet. |
| `409` | `id` of `slug` bestaat al — kies een andere of `PATCH` de bestaande. |
| `413` | Upload te groot (>8 MB). |
| `502` | Source-URL onbereikbaar of geen image. |

---

## Tip: check je werk

Open `https://api.andreas.amsterdam/admin` in een browser (wachtwoord login) om te zien wat n8n heeft aangemaakt. Daar kun je ook handmatig dingen aan/uit zetten of verwijderen als een flow misging.

Voor diepere debug: `fly logs -a andreas-api` toont elke API-call live.
