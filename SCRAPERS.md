# Scrapers — Prioriteit & Stand

Prioriteit-volgorde voor scraper-implementaties, op volgorde van impact (events × belang). Vink af zodra een venue events oplevert in DB.

**Stand (audit 2026-05-17)**: 83/198 gepubliceerde venues hebben events — ~4.577 toekomstige occurrences live.

---

## Volledige venue-status (DB)

Gegenereerd via `apps/api/scripts/_venue-report.ts` — alle gepubliceerde venues gegroepeerd op `type`, gesorteerd op aantal toekomstige events (desc). ✅ = events binnen, ⬜ = nog geen feed of feed levert nu 0 events.

### Clubs (22)
- ✅ **Panama** (mainstream/groot/oost) — 33 events · `eventscalendar`
- ✅ **Thuishaven** (mainstream/groot/west) — 21 events · Playwright
- ✅ **Radion** (alternatief/klein/nieuw-west) — 20 events · `stager`
- ✅ **Skatecafe Karin & Yvonne** (alternatief/middel/noord) — 20 events · `weticket`
- ✅ **Shelter** (mainstream/middel/noord) — 15 events · WP REST
- ✅ **BRET** (alternatief/klein/west) — 14 events · `celebratix`
- ✅ **Lofi** (alternatief/middel/west) — 14 events · `jsonld`
- ✅ **nachbar** (alternatief/klein/centrum) — 14 events · `stager`
- ✅ **Chin Chin Club** (mainstream/middel/centrum) — 13 events · `celebratix`
- ✅ **Tilla Tec** (alternatief/klein/west) — 13 events · `weeztix`
- ✅ **Radio Radio** (alternatief/klein/west) — 11 events · Playwright
- ✅ **Sissi's** (alternatief/middel/zuid) — 10 events · `weticket`
- ✅ **Club NYX** (mainstream/middel/centrum) — 7 events · `weeztix`
- ✅ **Garage Noord** (alternatief/middel/noord) — 7 events · pure-HTTP
- ✅ **Madam** (mainstream/middel/noord) — 7 events · `fourvenues`
- ✅ **Canvas** (alternatief/middel/oost) — 6 events · `volkshotel`
- ✅ **Het Sieraad** (alternatief/klein/west) — 6 events · pure-HTTP
- ✅ **Doka** (alternatief/middel/oost) — 2 events · via Paradiso routing
- ✅ **Warehouse Elementenstraat** (mainstream/groot/west) — 0 events · `weeztix` (shop leeg)
- ✅ **Yellow House** (alternatief/middel/west) — 0 events · `weeztix` (shop leeg)
- ⬜ **Café Café** (mainstream/middel/centrum) — geen publieke feed gevonden
- ⬜ **Escape** (mainstream/groot/centrum) — Fairtix-platform, vereist dedicated scraper

### Podia (53)
- ✅ **Het Concertgebouw** (mainstream/groot/zuid) — 487 events · `theater`
- ✅ **Internationaal Theater Amsterdam** (mainstream/groot/centrum) — 423 events · Playwright
- ✅ **Muziekgebouw aan 't IJ** (alternatief/groot/centrum) — 385 events · Playwright
- ✅ **DeLaMar Theater** (mainstream/middel/centrum) — 359 events · `theater`
- ✅ **Nationale Opera & Ballet** (mainstream/xl/centrum) — 267 events · Playwright
- ✅ **Paradiso** (mainstream/groot/centrum) — 261 events · GraphQL (+ Tolhuistuin/Bitterzoet/Doka routing)
- ✅ **Melkweg** (mainstream/groot/centrum) — 185 events · Playwright + Next.js
- ✅ **Koninklijk Theater Carré** (mainstream/groot/centrum) — 183 events · `theater`
- ✅ **Boom Chicago** (mainstream/middel/centrum) — 179 events · `ticketmaster` + FareHarbor
- ✅ **Theater Bellevue** (mainstream/middel/centrum) — 136 events · `theater`
- ✅ **Frascati** (mainstream/groot/centrum) — 127 events · `theater`
- ✅ **Tolhuistuin** (mainstream/groot/noord) — 109 events · via Paradiso routing
- ✅ **Ziggo Dome** (mainstream/xl/zuidoost) — 95 events · direct JSON-API
- ✅ **De Nieuwe Anita** (alternatief/klein/west) — 85 events · `denieuweanita` (WP REST)
- ✅ **Meervaart** (mainstream/groot/nieuw-west) — 76 events · `theater`
- ✅ **OT301** (underground/klein/west) — 66 events · Playwright
- ✅ **De Krakeling** (mainstream/middel/centrum) — 62 events · pure-HTTP
- ✅ **Theater Mascini** (alternatief/klein) — 53 events · `theatermascini`
- ✅ **AFAS Live** (mainstream/xl/zuidoost) — 53 events · `ticketmaster`
- ✅ **Bijlmer Parktheater** (mainstream/groot/zuidoost) — 45 events · `theater`
- ✅ **Splendor** (alternatief/middel/centrum) — 40 events · `stager`
- ✅ **Betty Asfalt Complex** (alternatief/klein/centrum) — 35 events · `bettyasfalt`
- ✅ **Bitterzoet** (alternatief/middel/centrum) — 30 events · via Paradiso routing
- ✅ **OCCII** (underground/klein/zuid) — 25 events · `ical`
- ✅ **Podium Mozaiek** (alternatief/middel/west) — 23 events · Ticketmatic
- ✅ **P60** (mainstream/middel/amstelveen) — 22 events · WP REST
- ✅ **Bimhuis** (mainstream/middel/centrum) — 20 events · Playwright
- ✅ **Johan Cruijff ArenA** (mainstream/xl/zuidoost) — 20 events · `ticketmaster`
- ✅ **Podium DE FLUX** (alternatief/middel) — 17 events · `wpTheatre`
- ✅ **Mike's Badhuistheater** (alternatief/klein/oost) — 17 events · `badhuistheater`
- ✅ **De Brakke Grond** (mainstream/middel/centrum) — 12 events · Playwright
- ✅ **RAI Theater** (mainstream/groot/zuid) — 11 events · `ticketmaster`
- ✅ **Q-Factory** (alternatief/middel/oost) — 10 events · Playwright
- ✅ **On the Roof** (alternatief/klein/noord) — 8 events · Playwright
- ✅ **Akhnaton** (alternatief/middel/centrum) — 5 events · `akhnaton` (WP CPT, recurring-dedup)
- ✅ **Concertgemaal** (fringe/klein/noord) — 5 events · Wix Events JSON-LD
- ✅ **Theater Amsterdam** (mainstream/groot/west) — 4 events · `ticketmaster`
- ✅ **Bourbon Street** (alternatief/klein/centrum) — 2 events · `bourbonstreet`
- ⬜ **Sugarfactory** — `/agenda/` 404, geen publieke events
- ⬜ **Jazz Café Alto** — WP zonder custom event post-type
- ⬜ **Pakhuis Wilhelmina, Het Veem House for Performance, Plein Theater, ZID Theater, De Ruimte, Podium Vrijburcht, Teatro Munganga, Astarotheatro, Casablanca Variété, Volta, Space for Dance Art, Zaal 100, Perdu, Salon de IJzerstaven, Compagnietheater** — separate research per venue

### Musea

Musea programmeren tentoonstellingen (multi-week, `kind=exhibition`), niet point-in-time events. Per-museum scraper is venue-specifieke HTML-parse.

**Met scraper (events live):**
- ✅ **STRAAT Museum** — 6 events · `straatmuseum`
- ✅ **FOAM** — 5 events · `foam` (Playwright, lokaal-only)
- ✅ **Oude Kerk** — 5 events · `oudekerk`
- ✅ **Nxt Museum** — 3 events · `nxtmuseum`
- ✅ **Van Gogh Museum** — 3 events · `vangoghmuseum`
- ✅ **Verzetsmuseum** — 3 events · (LLM-import via admin)
- ✅ **H'ART Museum** — 2 events · LLM-import
- ✅ **Huis Marseille** — 2 events · LLM-import
- ✅ **Stedelijk Museum** — 2 events · LLM-import
- ✅ **Cobra Museum** — 1 event · `cobramuseum`
- ✅ **De Nieuwe Kerk** — 1 event · `nieuwekerk`

**Zonder scraper, agenda-URL bekend:**
| Venue | Agenda URL | Platform | Strategy |
|---|---|---|---|
| Amsterdam Museum | `/zien-en-doen/agenda` | Next.js | `__NEXT_DATA__` mining + Playwright |
| Wereldmuseum Amsterdam | `/nl/zien-en-doen/tentoonstellingen` | JSON-LD detected | jsonld-scraper of detail-mining |
| Rijksmuseum | `/en/whats-on?filter=exhibitions` | enterprise (SSR/jaardata in head) | Playwright + selectors |
| Museum Het Rembrandthuis | — | onbekend | probe |
| Museum Het Schip / Van Loon / Moco / NEMO / Holocaustmuseum / Solder / Scheepvaartmuseum / Hollandsche Schouwburg / Allard Pierson / ARCAM / Artis / Embassy of the Free Mind / Joods Museum / Hortus Botanicus | — | per-venue probe nodig | separate research |
| Anne Frank Huis | — | (geen tentoonstellingen, vast museum) | overslaan |

### Galleries (55)
- ✅ **Arti et Amicitiae** (underground/klein/centrum) — 12 events · `arti`
- ✅ **W139** (underground/klein/centrum) — 9 events · `jsonld`
- ✅ **Bajesdorp - GROND** (underground/klein/oost) — 3 events · `ical`
- ✅ **CBK Zuidoost** (alternatief/middel/zuidoost) — 2 events · `cbkzuidoost`
- ✅ **If I Can't Dance** (underground/klein/centrum) — 0 events · `stager` (config klaar, shop leeg)
- ⬜ Overige 51 (AKINCI, Andriesse Eyck, Annet Gelink, Borzo, Bradwolff, Buro Stedelijk, De Appel, Ellen de Bruijne, Enari, Framer Framed (×2), Galerie Bart, Caroline O'Breen, de Schans, dudokdegroot, Fleur & Wouter, Fons Welters, Fontana, Martin van Zomeren, Onrust, Ron Mandos, Fanny Freytag, GoMulan, GRIMM, Hama, Helicopter, ISO, Josilda da Conceição, Kers, Kunstverein, LANGArt, Lumen Travo, m.simons, Madé van Krimpen, Marwan, No Limits!, No Man's Art, OSCAM, P/////AKT, Projectspace 38/40, puntWG, ROZENSTRAAT, Rutger Brandt, Slewe, Stigter Van Doesburg, tegenboschvanvreden, TORCH, Upstream, Zone 2 Source) — separate research

### Film (11)
- ✅ **Cinetol** (alternatief/middel/zuid) — 0 events · `stager` (shop leeg)
- ⬜ Cavia, De Uitkijk, Eye Filmmuseum, FC Hyena, FilmHallen, Kriterion, Lab111, Rialto, Studio/K, The Movies

### Ruimtes / culturele plekken (38)
- ✅ **Ruigoord** (fringe/groot/nieuw-west) — 29 events · `ical`
- ✅ **Mediamatic** (alternatief/middel/oost) — 27 events · `stager`
- ✅ **Voedselpark Amsterdam** (fringe/klein/nieuw-west) — 9 events · `ical`
- ✅ **Plantagedok** (underground/klein/centrum) — 6 events · `ical`
- ✅ **Ru Paré** (alternatief/klein/nieuw-west) — 3 events · `ical`
- ✅ **NDSM Loods** (alternatief/groot/noord) — 2 events · `theater`
- ⬜ Overige 32 (woonruimte coöperatief, A Lab, ADM Noord, AtelierWG, Buurtwerkplaats Noorderhof, De (Roze) Tanker, De Ateliers, De Balie, De Ceuvel, De Culturele Stelling, De Fabriek, De Hoop, De Omleiding, De Sloot, Felix Meritis, Huis te Vraag, KasKantine, Kostgewonnen, LIMA, Loods 6, NieuwLand, OT West, Pakhuis de Zwijger, Parknest, Rijksakademie, RijksHemelVaartDienst, SEXYLAND World, SPUI25, Steelhenge, Treehouse NDSM, Vondelbunker, Workship op de Ceuvel)

### Boekhandel-cafés (4)
- ✅ **Fort van Sjakoo** (underground/klein/centrum) — 1 event · `ical`
- ⬜ Athenaeum Boekhandel, Kanarie Club, Noon coffee & culture

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

**Top grote clubs:**
- ✅ **Thuishaven** [groot/mainstream] — `thuishaven.nl` (WordPress) — Playwright homepage harvest event-URLs `/{DD}-{maand}-{slug}/`, server-rendered detail-page heeft `<title>`/img/`.agenda-line-up__line-up` met DJ-lineup per area (Loods/Secret). 24 events, 24/24 lineup, 23/24 mirrored.
- ⬜ **Warehouse Elementenstraat** [groot/mainstream] — geen eigen URL; vermoedelijk via RA / Eventbrite
- ✅ **Garage Noord** [middel/alt] — pure-HTTP scraper op `garagenoord.com/`. Per event: tile-link `garagenoord.com/club/{slug}` + WeTicket-link `garagenoord.weticket.io/{slug}/shop` (of `ra.co/events/N` voor festivals). Image via og:image op detail-page (gehost op garagenoord.com). 7 events, 7/7 mirrored.
- ✅ **Shelter** [middel/mainstream] — directe WP REST API op `shelteramsterdam.nl/wp-json/wp/v2/dt_portfolio` (Fourvenues-iframe staat op de site, content komt uit WP). Per event: `featured_media` (1080×1080 PNG), `yoast_head_json.og_description` (1-2 zinnen lineup-summary), `date` als startsAt, default end = +7u. 16 events, 16/16 mirrored, 16/16 description.
- ✅ **BRET** [klein/alt] — Celebratix-channel `fuef7` (in widget op `bret.bar/ticketshop` → filesusr.com iframe). Pure HTTP-API: `api.celebratix.io/v2/consumers/Events?channel=fuef7&pageSize=100`. 15 events / 15 mirrored. Patroon herbruikbaar voor andere clubs (`scraperConfig.celebratix = { channel }`).
- ⏳ **Escape** [groot/mainstream] — venue toegevoegd (Rembrandtplein 11), géén scraper. Tickets via **Fairtix** (`tickets.escape.nl`) — nieuw platform, vereist dedicated `fairtix.ts` module. Agenda-overzicht op `escape.nl/en/agenda/` is custom HTML zonder JSON-LD/sitemap; events-URLs zijn `/en/{YYYY-MM-DD}_{slug}/` met og:image per event. Twee mogelijke bronnen: (a) Fairtix-API reverse engineeren (rijker, met tickets/prijs), of (b) escape.nl agenda-page parser (basisdata + image, géén tickets).

**Kleinere alt-clubs:**
- ✅ **Tilla Tec** — Weeztix (OpenTicket) shop UUID `0e536f93-...` → publieke `data` API. 14 events.
- ✅ **Radio Radio** — directe scraper op `radioradio.radio/club` (Nuxt-site met DatoCMS-payload inline in `window.__NUXT__.data.{key}.data.allEvents`). Per event: `id`/`title`/`description`/`date`/`startTime`/`endTime`/`ticket`/`image.responsiveImage.src`. 12 events, 7/12 mirrored (alleen events met "Info"-knop hebben een image in DatoCMS).
- ✅ **nachbar** — Stager-host `nachbar.stager.co`, shopId 5088. 0 events op moment (config klaar).
- ⏳ **Warehouse Elementenstraat** — Weeztix UUID `448146f6-...` (van `elementenstraat.nl/events`), shop momenteel leeg.
- ✅ **Het Sieraad** — pure-HTTP scraper op `het-sieraad.nl/` server-rendered tabel met `.event-row`s (date+time+lineup+sound+ticket-URL). Tickets via Paylogic short-IDs. Geen images op de site (Het Sieraad voert geen tile-art per event). 5 events.
- ⬜ iNN Amsterdam, Claire, CONTACT — separate research

- ✅ **Madam** — Fourvenues iframe (`site.fourvenues.com/en/iframe/madam@g:pwsbn` — slug URL-encoded). Tile-DOM is `<app-event-card>` met date+title+12u-tijden in tekst en image-src in nested `<img src="…/imagedelivery/…/width=534">`. 8 events, 8/8 mirrored.
- ✅ **Skatecafe Karin & Yvonne** [middel/alt] — Playwright op `skatecafe.weticket.io/` (Vercel-challenge passable via headed Chromium). De listing rendert SSR met `<script id="__NEXT_DATA__">.props.pageProps.organisationWithShops.upcoming_events` — een complete array met `slug`/`name`/`cover_photo.path_url`/`first_date`/`last_date`/`location_name`. Filter op `location_name === venue.name` om externe shows (bv. Stuzzi @ Melkweg) te skippen. Lokaal-only (Playwright). 21 events, 21/21 mirrored.

**Mainstream clubs (resterend):** Marktkantine, Club NL, Club Home — staan op `published=false`. Eerst onderzoek welke nog actief zijn (sommige zijn permanent gesloten of verhuisd).

**Nieuw toegevoegd (mei 2026):**
- ✅ **Sissi's** [middel/alt, Schinkel] — WeTicket `sissisamsterdam.weticket.io`. Generieke `weticket.ts` scraper (refactor van skatecafe.ts) loopt over `scraperConfig.weticket.subdomain`. Playwright, lokaal-only.
- ✅ **Chin Chin Club** [middel/mainstream, Jordaan] — Celebratix channel `2vys5` (achter tracking-link `?t=y2g8j`, resolved via `/v2/consumers/TrackingLinks/y2g8j`). 13 events live.
- ✅ **Panama** [groot/mainstream, Oost] — The Events Calendar Pro WP-plugin via REST `panama.nl/wp-json/tribe/events/v1/events`. Pure HTTP, in CI matrix als `eventscalendar`. 28 events.
- ⏳ **Canvas** [middel/alt, Oost] — Volkshotel custom WP-template op `volkshotel.nl/en/agenda/canvas/`. Per event: `<a class="card agenda buzz-hover">` met `<h2 class="buzz">` + `class="event-date"` + `class="event-time"` + og:image op detail. Vereist custom HTML-parser (~2u werk), nog niet gedaan.
- ⏳ **Club NYX** [middel/mainstream, centrum] — alleen Facebook events op `facebook.com/NYXamsterdam/events`. FB blokt crawlers + vereist login. Opties: (a) FB Graph API met page-token (auth-setup), (b) third-party FB-event-scraper. Niet gedaan, hoogste-pijn-niveau van de set.
- ⬜ **Café Café** [middel/mainstream, centrum] — `cafecafe-restaurant.nl/cafecafebar` lijkt geen publieke agenda-feed te hebben. Eerst manual probe nodig.
- ✅ **Yellow House** [middel/alt, Houthavens] — venue toegevoegd, scraper nog niet gekozen.

**Mogelijke bulk-aanpak**: Resident Advisor (`ra.co/clubs/amsterdam`) heeft venue-pages voor de meeste underground clubs (Garage Noord, Lofi, Doka, Radion, BRET, Radio Radio, Tilla Tec, Shelter). Eén RA-scraper zou ~10 venues in één keer dekken. Worth investigating als per-club aanpak meer custom werk vereist.

---

## Open cleanup (audit 2026-05-17)

DB-audit over alle 51 actieve scrapers. Skill `scraper-add` werkt deze pijnpunten ook in voor nieuwe scrapers — zie [.claude/skills/scraper-add/SKILL.md](.claude/skills/scraper-add/SKILL.md).

### 1. Recurring events nog niet gegroepeerd
Akhnaton heeft canonical-slug grouping; Anita en clones nog niet. Top ongegroepeerde recurring titels per venue:
- **De Nieuwe Anita** — Cinemanita & Fiber Factory (×10), Schrijfcafé Tussen de Regels (×6), Literanita (×3), Vrij Spel (×2), Comedy Queens (×2), Amsterdam Vinyl Club (×2), …
- **Chin Chin Club** — Mémoire | 18+ (×5), F.A.M. | 18+ (×4), Dynasty | 21+ (×2), Fusion | 20+ (×2). Slugs hebben `-N` suffix net als Akhnaton.
- **Theater Mascini** — Amsterdams Allooi (×4) — eigen pattern, geen `-N` maar `{id}-{slug}` met andere id per editie.
- **Podium DE FLUX**, **Ruigoord**, **Internationaal Theater Amsterdam** ("Public tour (in English)", "Openbare rondleiding (in het Nederlands)"), **Concertgemaal**, **De Krakeling**, **Club NYX**, **Madam** — telkens 2-3 dupes per recurring titel.

**Fix-patroon**: hergebruik de Akhnaton-aanpak — `canonicalKey(slug)` per scraper (strip `-N$` of `{id}-` prefix), group posts, één event-row, occurrence-row per editie.

### 2. Cross-language dupes (NL/EN)
- **Het Concertgebouw** heeft 1 bevestigde NL+EN-paar gevonden ("Samy Moussa & Poolse invloeden" / "Samy Moussa & Polish influences") — de `<html lang="nl">`-filter in `theater.ts` werkt grotendeels maar lekt soms. Andere "same-time"-paren zijn parallel Grote/Kleine Zaal, geen dupes.
- **ITA** dito: "same-time"-paren zijn meestal Rabozaal vs Grote Zaal. NL+EN-paar gespot: "Public tour (in English)" / "Openbare rondleiding (in het Nederlands)" — die zijn niet hetzelfde event, dit zijn juist twee verschillende tour-formats. Geen actie.

### 3. Image-bronnen die niet naar Bunny gemirroreerd zijn
| Venue | n | Reden |
|---|---|---|
| Theater Mascini | 43 | Mirror-stap ontbreekt in `theatermascini.ts`. Source: `theatermascini.nl/_live_portrait_...` en `/media/a_Webshop/...`. |
| Bourbon Street | 6 | Mirror-stap ontbreekt. Source: `bourbonstreet.nl/uploads/image/...-150x100.jpg`. Bonus: tile-thumb maat (150×100) is te klein — zoek native res of skip. |
| Betty Asfalt | 2 | Mirror-stap ontbreekt. |
| De Nieuwe Anita | 2 | Edge-case waar mirror faalt, fallback op source. |
| Podium Mozaiek | 2 | Idem. |
| Thuishaven | 1 | Idem. |

**Fix**: alle scrapers moeten `uploadToBunny()` aanroepen vóór ze het URL in `events.imageUrl` zetten. Zie het patroon in `denieuweanita.ts` / `akhnaton.ts` (`mirrorImage` helper).

### 4. Events met NULL image
Top venues met events zonder enige image: OCCII (31), Melkweg (21), Lofi (20), nachbar (17), Tilla Tec (13), Radio Radio (12), Club NYX (11), Mediamatic (9), Het Sieraad (9). Sommige bronnen bieden simpelweg geen image per event (OCCII iCal, Sieraad event-row). Voor deze: venue.imageUrl als fallback op event-tile is een UX-fix, geen scraper-fix.

### 5. Broken events (zonder occurrences)
2 entries: Boom Chicago (1) + Museum Het Rembrandthuis (1). Verwaarloosbaar, maar handig om periodiek te draaien:

```sql
DELETE FROM events e
WHERE NOT EXISTS (SELECT 1 FROM occurrences o WHERE o.event_id = e.id);
```

### 6. Scrapers in registry, niet in daily CI
Wel `scrapers/index.ts`, niet `.github/workflows/scrape-stager.yml` matrix. Sommige bewust (Playwright-only, kunnen niet op Fly), andere vergeten:

**Pure-HTTP, vergeten toe te voegen aan matrix:**
denieuweanita, amsterdammuseum, arti, cbkzuidoost, cobramuseum, nieuwekerk, nxtmuseum, oudekerk, rijksmuseum, straatmuseum, vangoghmuseum, wereldmuseum, badhuistheater, bettyasfalt, bourbonstreet, brakkegrond, qfactory, theatermascini, thuishaven, weticket.

**Playwright (bewust niet in matrix):** bimhuis, fourvenues, melkweg, muziekgebouw, ontheroof, paradiso, radioradio, foam — runnen lokaal via `pnpm scrape <name>`.

### 7. 121 venues met 0 events
121 van 204 gepubliceerde venues hebben nog geen events. Top podia/clubs/film zonder scraper (samenvatting):
Astarotheatro, Café Café, Cavia, Cinema The Pulse, Cinetol, De Uitkijk, Escape, Eye Filmmuseum, FC Hyena, FilmHallen, Jazz Café Alto, Kriterion, Lab111, Perdu, Rialto, Sugarfactory, The Movies, Volta, Zaal 100, Studio/K, Pakhuis Wilhelmina — separate research per venue.

## Aantekeningen

- "RSS in inventory" = WordPress site met `/feed/` endpoint, maar earlier check liet zien dat die feeds blog-posts mixen met events. Niet een echte quick-win — vereist Claude-filter per item. Rondom Phase 3 als groep aanpakken.
- Cloudflare-blocked venues hebben Playwright nodig of een externe API (zoals Ticketmaster Discovery).
- Cross-venue routing (Tolhuistuin/Bitterzoet/Doka via Paradiso) is bewezen patroon — als we andere "moederpodia" tegenkomen kunnen we die opnieuw inzetten.
- **Ticketmaster Discovery API** is bewezen patroon voor 5 venues (AFAS Live, ArenA, Boom Chicago, RAI Theater, Theater Amsterdam). Tier-suffixes (`| VIP Packages`, `| Comfort Seats`) worden gestript en gededupliceerd, multi-night runs gegroepeerd via title-slug. Geen Playwright nodig. Wikipedia summary van de hoofd-attractie als bron voor description (TM levert die niet).
- **Theater-scraper** (`apps/api/src/scrapers/theater.ts`) is een gegeneraliseerd patroon voor venues met een eigen agenda achter een SPA: sitemap.xml geeft de complete show-lijst, per show-page parseren we JSON-LD `Event`-blokken óf `data-date` attrs voor de datums. Werkt voor Carré (Vue-SPA, Googlebot UA-trick), Meervaart (Phoenix LiveView), DeLaMar (data-date fallback), Bellevue + Bijlmer (Peppered SaaS), Concertgebouw (sitemap-index + future-slot filter). Op de eerste 3 venues is TM-config bewust verwijderd — theater-bron is exhaustief en de TM-events waren een subset. Sitemap-index support volgt sub-sitemaps recursief; future-slot filter skipt enrich/image-mirror voor events met alle slots in het verleden (essentieel voor Concertgebouw met 4233 historische sitemap-entries: 490 nieuw, 3743 geskipt zonder Claude-cost).
- **FareHarbor calendar-API** (Boom Chicago) levert publiek (zonder auth) per item-id maandelijkse availabilities via `GET /api/v1/companies/{co}/items/{id}/calendar/{Y}/{M}/`. Beschrijving via `/api/items/v1/{co}/{id}/structured-description/`, image via `/api/v1/companies/{co}/items/{id}/images/`. Generic `140084` item-id (gedeelde "Tickets" knop op alle show-pages) wordt overgeslagen.
