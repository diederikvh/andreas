# Scrapers — Prioriteit & Stand

Prioriteit-volgorde voor scraper-implementaties, op volgorde van impact (events × belang). Vink af zodra een venue events oplevert in DB.

**Stand**: 36/50 done — ~2.440 events live. Phase 1 volledig + Phase 2 dekkende ronde + clubs (Thuishaven 24, BRET 15, Doka 2, Lofi 16, Radion 22 = 79 club-events).

---

## ✅ Done (11)

| # | Venue | Events | Methode |
|---|---|---|---|
| ✅ | Ziggo Dome | 61 | direct JSON-API + cdn.ziggodome.nl |
| ✅ | Paradiso | 262 | GraphQL (paradisoNederlands) + cross-venue routing |
| ✅ | Melkweg | 189 | Playwright + Next.js `_next/data/{buildId}/...` |
| ✅ | Muziekgebouw aan 't IJ | 284 | Playwright /agenda + title-grouping |
| ✅ | Tolhuistuin | 111 | via Paradiso GraphQL routing |
| ✅ | Splendor | 44 | Stager |
| ✅ | Bitterzoet | 30 | via Paradiso GraphQL routing |
| ✅ | OCCII | 28 | iCal feed |
| ✅ | P60 | 24 | WP REST API + Elementor parse |
| ✅ | Mediamatic | 16 | Stager + mediamatic.net website-enrich |
| ✅ | Lofi | 16 | JSON-LD scraper |
| ✅ | W139 | 13 | JSON-LD scraper |
| ✅ | Radion | 22 | Stager |
| ✅ | Ruigoord | 19 | iCal feed |
| ✅ | Podium DE FLUX | 18 | wp-theatre scraper |
| ✅ | On the Roof | 8 | Weeztix Playwright + per-artist pages |
| ✅ | Plantagedok | 7 | iCal feed |
| ✅ | Bajesdorp - GROND | 6 | iCal feed |
| ✅ | Concertgemaal | 6 | Wix Events JSON-LD |
| ✅ | Voedselpark Amsterdam | 3 | iCal feed |
| ✅ | Ru Paré | 3 | iCal feed |
| ✅ | Doka | 2 | via Paradiso GraphQL routing |
| ✅ | Fort van Sjakoo | 2 | iCal feed |
| ✅ | Cinetol | (geen events nu) | Stager |
| ✅ | If I Can't Dance | (geen events nu) | Stager |
| ✅ | AFAS Live | 47 | Ticketmaster Discovery API |
| ✅ | Johan Cruijff ArenA | 6 / 20 occ | Ticketmaster Discovery API |
| ✅ | Boom Chicago | 14 / 15 occ | Ticketmaster Discovery API (tour-acts) |
| ✅ | Boom Chicago — eigen | 8 / 170 occ | FareHarbor calendar API (improv + comedy embassy + sunday night live + …) |
| ✅ | Theater Bellevue | 65 / 146 occ | Theater-scraper (Peppered SaaS) |
| ✅ | Bijlmer Parktheater | 23 / 54 occ | Theater-scraper (Peppered SaaS) |
| ✅ | Het Concertgebouw | 490 / 490 occ | Theater-scraper (sitemap-index + JSON-LD, future-slot filter) |
| ✅ | Bimhuis | 18 / 20 occ | Playwright `/en/calendar/` tiles + og-meta (lokaal-only, Playwright niet in Fly Dockerfile) |
| ✅ | Internationaal Theater Amsterdam | 116 / 425 occ | Publieke JSON API `/nl/api/v1/channel/events/`, paginated, filter `itaOnTour=true` |
| ✅ | Nationale Opera & Ballet (Stopera) | 33 / 270 occ | Sitemap (4 pages) + Drupal `/api/1.0/activities/{nodeId}/nl` voor speeldatums |
| ✅ | Frascati | 46 / 130 occ | Theater-scraper (Peppered SaaS, juiste URL is `frascatitheater.nl`) |
| ✅ | OT301 | 32 / 66 occ | Playwright `/nl/agenda` `.event-item` parser (lokaal-only) |
| ✅ | NDSM Loods | 5 / 5 occ | Theater-scraper (WP `event_listing-sitemap.xml` + JSON-LD per detail-page) |
| ✅ | Podium Mozaïek | 21 / 27 occ | `/data/events/all.json` met custom_description + custom_images (rijker dan Ticketmatic shop) |
| ✅ | Q-Factory | 10 / 10 occ | Playwright op `q-factory.com/nl#all-events-section` — eigen site heeft images (Storyblok) + echte descriptions; lokaal-only (TM venue-page bron had fake descriptions + lege images) |
| ✅ | De Brakke Grond | 7 / 12 occ | Playwright per show op `/agenda/{id}/{slug}` — h1 + `.text-block.block` + `figure.gallery-block__image` voor image, body parsed voor multi-night Dutch dates |
| ✅ | RAI Theater | 7 / 12 occ | Ticketmaster Discovery API |
| ✅ | Theater Amsterdam | 3 / 4 occ | Ticketmaster Discovery API |
| ✅ | Carré | 48 / 235 occ | Theater-scraper (sitemap + JSON-LD `Event`, Googlebot UA) |
| ✅ | Meervaart | 51 / 83 occ | Theater-scraper (sitemap + JSON-LD `TheaterEvent`) |
| ✅ | DeLaMar | 109 / 365 occ | Theater-scraper (sitemap + `data-date` attrs, Googlebot UA) |

---

## ⬜ TODO (volgorde aangepast — Bimhuis & Concertgebouw omhoog)

### Phase 1 — XL/L impact
✓ Volledig afgerond (Concertgebouw, Bimhuis, ITA, Stopera).

### Phase 2 — M impact
- ✅ **Frascati** — Peppered SaaS (juiste URL `frascatitheater.nl`, niet `theaterfrascati.nl`)
- ✅ **Theater Bellevue** — Peppered SaaS
- ✅ **Meervaart** — theater-scraper Phoenix LiveView
- ✅ **Bijlmer Parktheater** — Peppered SaaS
- ✅ **OT301** — Playwright `/nl/agenda`
- ✅ **NDSM Loods** — `ndsmloods.nl/event_listing-sitemap.xml` (echte URL is met www, niet ndsm-loods.nl)
- ✅ **Podium Mozaïek** — Ticketmatic shop `ticketshop.ticketmatic.com/podium_mozaiek/shop` (eigen site is SSL-broken)
- ❌ **Compagnietheater** — gehackt (gokken-spam)
- ✅ **Q-Factory** — eigen site `q-factory.com/nl#all-events-section` Playwright (rijker dan TM venue-page; eerst geprobeerd met `jsonld.ts` op TM SSR maar fake descriptions zonder image)
- ✅ **De Brakke Grond** — Playwright per show op `/agenda/{id}/{slug}`, multi-night Dutch dates uit body
- ⚠️ **Sugarfactory** — `/agenda/` 404, geen events publiek bereikbaar
- ⚠️ **Jazz Café Alto** — WP zonder custom event post-type

### Phase 3 — S impact
- ⬜ Pakhuis Wilhelmina
- ⬜ De Nieuwe Anita — RSS in inventory
- ⬜ De Krakeling
- ⬜ Het Veem House for Performance
- ⬜ Plein Theater
- ⬜ ZID Theater — RSS in inventory
- ⬜ Betty Asfalt Complex
- ⬜ Bourbon Street
- ⬜ De Ruimte — RSS in inventory
- ⬜ Podium Vrijburcht
- ⬜ Teatro Munganga — RSS in inventory
- ⬜ Astarotheatro — RSS in inventory
- ⬜ Casablanca Variété
- ⬜ Mike's Badhuistheater
- ⬜ Volta
- ⬜ Space for Dance Art
- ⬜ Zaal 100 — RSS in inventory
- ⬜ Perdu — Ticketkantoor
- ⬜ Salon de IJzerstaven

### Clubs (`type=club`) — 19 venues, top 5 op grootte/scene

Andreas-night-modus targeted. 3 al gescrape'd (Doka 2, Lofi 16, Radion 22 = 40 events totaal).

**Top 5 grote clubs:**
- ✅ **Thuishaven** [groot/mainstream] — `thuishaven.nl` (WordPress) — Playwright homepage harvest event-URLs `/{DD}-{maand}-{slug}/`, server-rendered detail-page heeft `<title>`/img/`.agenda-line-up__line-up` met DJ-lineup per area (Loods/Secret). 24 events, 24/24 lineup, 23/24 mirrored.
- ⬜ **Warehouse Elementenstraat** [groot/mainstream] — geen eigen URL; vermoedelijk via RA / Eventbrite
- ⬜ **Garage Noord** [middel/alt] — gebruikt Resident Advisor als ticketing → mogelijk via RA-scraper
- ⬜ **Shelter** [middel/mainstream] — Eventix shop UUID `74cd4017-...` lijkt leeg; opnieuw checken
- ✅ **BRET** [klein/alt] — Celebratix-channel `fuef7` (in widget op `bret.bar/ticketshop` → filesusr.com iframe). Pure HTTP-API: `api.celebratix.io/v2/consumers/Events?channel=fuef7&pageSize=100`. 15 events / 15 mirrored. Patroon herbruikbaar voor andere clubs (`scraperConfig.celebratix = { channel }`).

**Kleinere alt-clubs:**
- ⬜ Tilla Tec, Radio Radio, nachbar — `tillatec.com`, `radioradio.radio`, `nachbar.amsterdam`
- ⬜ Garage Noord (zie boven), iNN Amsterdam, Claire, CONTACT — kleinere venues, vermoedelijk RA

**Mainstream clubs (8 unpublished):** Marktkantine, Madam, Club NL, Club Home, Het Sieraad — staan op `published=false`. Eerst onderzoek welke nog actief zijn (sommige zijn permanent gesloten of verhuisd).

**Mogelijke bulk-aanpak**: Resident Advisor (`ra.co/clubs/amsterdam`) heeft venue-pages voor de meeste underground clubs (Garage Noord, Lofi, Doka, Radion, BRET, Radio Radio, Tilla Tec, Shelter). Eén RA-scraper zou ~10 venues in één keer dekken. Worth investigating als per-club aanpak meer custom werk vereist.

---

## Aantekeningen

- "RSS in inventory" = WordPress site met `/feed/` endpoint, maar earlier check liet zien dat die feeds blog-posts mixen met events. Niet een echte quick-win — vereist Claude-filter per item. Rondom Phase 3 als groep aanpakken.
- Cloudflare-blocked venues hebben Playwright nodig of een externe API (zoals Ticketmaster Discovery).
- Cross-venue routing (Tolhuistuin/Bitterzoet/Doka via Paradiso) is bewezen patroon — als we andere "moederpodia" tegenkomen kunnen we die opnieuw inzetten.
- **Ticketmaster Discovery API** is bewezen patroon voor 5 venues (AFAS Live, ArenA, Boom Chicago, RAI Theater, Theater Amsterdam). Tier-suffixes (`| VIP Packages`, `| Comfort Seats`) worden gestript en gededupliceerd, multi-night runs gegroepeerd via title-slug. Geen Playwright nodig. Wikipedia summary van de hoofd-attractie als bron voor description (TM levert die niet).
- **Theater-scraper** (`apps/api/src/scrapers/theater.ts`) is een gegeneraliseerd patroon voor venues met een eigen agenda achter een SPA: sitemap.xml geeft de complete show-lijst, per show-page parseren we JSON-LD `Event`-blokken óf `data-date` attrs voor de datums. Werkt voor Carré (Vue-SPA, Googlebot UA-trick), Meervaart (Phoenix LiveView), DeLaMar (data-date fallback), Bellevue + Bijlmer (Peppered SaaS), Concertgebouw (sitemap-index + future-slot filter). Op de eerste 3 venues is TM-config bewust verwijderd — theater-bron is exhaustief en de TM-events waren een subset. Sitemap-index support volgt sub-sitemaps recursief; future-slot filter skipt enrich/image-mirror voor events met alle slots in het verleden (essentieel voor Concertgebouw met 4233 historische sitemap-entries: 490 nieuw, 3743 geskipt zonder Claude-cost).
- **FareHarbor calendar-API** (Boom Chicago) levert publiek (zonder auth) per item-id maandelijkse availabilities via `GET /api/v1/companies/{co}/items/{id}/calendar/{Y}/{M}/`. Beschrijving via `/api/items/v1/{co}/{id}/structured-description/`, image via `/api/v1/companies/{co}/items/{id}/images/`. Generic `140084` item-id (gedeelde "Tickets" knop op alle show-pages) wordt overgeslagen.
