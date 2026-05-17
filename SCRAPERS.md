# Scrapers — Status & TODO

Volledige inventory: elke gepubliceerde venue in de DB hier zichtbaar met status. ✅ events live · ⬜ nog te doen · ❌ niet doen (met reden).

**Stand (audit 2026-05-17)**: 87/196 gepubliceerde venues hebben momenteel toekomstige of lopende events (~4731 occurrences live). Lopende exhibitions (`starts_at` in verleden, `ends_at` in toekomst) tellen ook mee — dat is normaal voor musea.

Nieuwe event-categorie sinds 2026-05-17: **Lezing** (debat / talkshow / publieke-gesprek), apart van Literatuur. Eerste venue in deze categorie is Pakhuis de Zwijger.

Skill voor toevoegen van nieuwe scrapers: [.claude/skills/scraper-add/SKILL.md](.claude/skills/scraper-add/SKILL.md).

---

## Clubs (22)

- ✅ **Panama** (mainstream/groot/oost) — 37 events · `eventscalendar` (Tribe Events Pro REST)
- ✅ **Thuishaven** (mainstream/groot/west) — 20 events · Playwright (homepage harvest + `.agenda-line-up`)
- ✅ **Radion** (alternatief/klein/nieuw-west) — 19 events · `stager`
- ✅ **Lofi** (alternatief/middel/west) — 17 events · `jsonld`
- ✅ **BRET** (alternatief/klein/west) — 15 events · `celebratix` (channel `fuef7`)
- ✅ **Skatecafe Karin & Yvonne** (alternatief/middel/noord) — 15 events · `weticket` (Playwright)
- ✅ **Chin Chin Club** (mainstream/middel/centrum) — 13 events · `celebratix` (channel `2vys5`)
- ✅ **Radio Radio** (alternatief/klein/west) — 13 events · Playwright (DatoCMS in `__NUXT__`)
- ✅ **Shelter** (mainstream/middel/noord) — 12 events · WP REST `dt_portfolio`
- ✅ **Tilla Tec** (alternatief/klein/west) — 12 events · `weeztix`
- ✅ **nachbar** (alternatief/klein/centrum) — 12 events · `stager`
- ✅ **Club NYX** (mainstream/middel/centrum) — 10 events · `weeztix`
- ✅ **Sissi's** (alternatief/middel/zuid) — 10 events · `weticket` (Playwright)
- ✅ **Garage Noord** (alternatief/middel/noord) — 6 events · pure-HTTP
- ✅ **Het Sieraad** (alternatief/klein/west) — 6 events · pure-HTTP
- ✅ **Madam** (mainstream/middel/noord) — 5 events · `fourvenues` (Playwright)
- ✅ **Canvas** (alternatief/middel/oost) — 4 events · `volkshotel`
- ✅ **Doka** (alternatief/middel/oost) — 1 event · via Paradiso routing
- ⬜ **Café Café** — geen publieke feed gevonden; manuele probe nodig
- ⬜ **Escape** — Fairtix-platform (tickets.escape.nl), vereist dedicated `fairtix` scraper
- ⬜ **Warehouse Elementenstraat** — `weeztix` config gezet, shop momenteel leeg
- ⬜ **Yellow House** — scraper nog te kiezen

## Podia (53)

- ✅ **Het Concertgebouw** (mainstream/groot/zuid) — 531 events · `theater` (sitemap-index + JSON-LD, future-slot filter)
- ✅ **Patronaat** (mainstream/groot/haarlem) — 140 events · `patronaat` (buiten Amsterdam, bewust meegenomen voor regio-coverage)
- ✅ **DeLaMar Theater** (mainstream/middel/centrum) — 435 events · `theater` (sitemap + `data-date` attrs, Googlebot UA)
- ✅ **Internationaal Theater Amsterdam** (mainstream/groot/centrum) — 418 events · publieke JSON `/nl/api/v1/channel/events/`
- ✅ **Muziekgebouw aan 't IJ** (alternatief/groot/centrum) — 378 events · Playwright `/agenda` + title-grouping
- ✅ **Paradiso** (mainstream/groot/centrum) — 264 events · GraphQL (+ routing voor Tolhuistuin/Bitterzoet/Doka)
- ✅ **Nationale Opera & Ballet** (mainstream/xl/centrum) — 258 events · Sitemap + Drupal `/api/1.0/activities`
- ✅ **Boom Chicago** (mainstream/middel/centrum) — 209 events · `ticketmaster` + FareHarbor calendar-API
- ✅ **Koninklijk Theater Carré** (mainstream/groot/centrum) — 188 events · `theater` (Googlebot UA)
- ✅ **Melkweg** (mainstream/groot/centrum) — 184 events · Playwright + Next.js `_next/data`
- ✅ **Theater Bellevue** (mainstream/middel/centrum) — 122 events · `theater` (Peppered SaaS)
- ✅ **Frascati** (mainstream/groot/centrum) — 121 events · `theater` (Peppered SaaS, host `frascatitheater.nl`)
- ✅ **Tolhuistuin** (mainstream/groot/noord) — 107 events · via Paradiso GraphQL routing
- ✅ **Ziggo Dome** (mainstream/xl/zuidoost) — 94 events · direct JSON-API
- ✅ **De Nieuwe Anita** (alternatief/klein/west) — 85 events · `denieuweanita` (WP REST + Elementor)
- ✅ **Meervaart** (mainstream/groot/nieuw-west) — 73 events · `theater` (Phoenix LiveView)
- ✅ **De Krakeling** (mainstream/middel/centrum) — 62 events · pure-HTTP
- ✅ **OT301** (underground/klein/west) — 60 events · Playwright `/nl/agenda`
- ✅ **Podium Mozaiek** (alternatief/middel/west) — 59 events · `/data/events/all.json` (Ticketmatic)
- ✅ **Bijlmer Parktheater** (mainstream/groot/zuidoost) — 55 events · `theater` (Peppered SaaS)
- ✅ **Theater Mascini** (alternatief/klein) — 53 events · `theatermascini`
- ✅ **AFAS Live** (mainstream/xl/zuidoost) — 52 events · `ticketmaster`
- ✅ **Splendor** (alternatief/middel/centrum) — 38 events · `stager`
- ✅ **Betty Asfalt Complex** (alternatief/klein/centrum) — 35 events · `bettyasfalt`
- ✅ **Bitterzoet** (alternatief/middel/centrum) — 30 events · via Paradiso routing
- ✅ **OCCII** (underground/klein/zuid) — 24 events · `ical`
- ✅ **P60** (mainstream/middel/amstelveen) — 24 events · WP REST + Elementor
- ✅ **Johan Cruijff ArenA** (mainstream/xl/zuidoost) — 19 events · `ticketmaster`
- ✅ **Bimhuis** (mainstream/middel/centrum) — 17 events · Playwright (lokaal-only)
- ✅ **Mike's Badhuistheater** (alternatief/klein/oost) — 17 events · `badhuistheater`
- ✅ **Podium DE FLUX** (alternatief/middel) — 16 events · `wpTheatre`
- ✅ **RAI Theater** (mainstream/groot/zuid) — 11 events · `ticketmaster`
- ✅ **Q-Factory** (alternatief/middel/oost) — 10 events · Playwright (eigen site, Storyblok)
- ✅ **De Brakke Grond** (mainstream/middel/centrum) — 9 events · Playwright per show
- ✅ **On the Roof** (alternatief/klein/noord) — 8 events · Playwright (Weeztix per artist)
- ✅ **Akhnaton** (alternatief/middel/centrum) — 5 events · `akhnaton` (WP CPT, recurring-dedup)
- ✅ **Concertgemaal** (fringe/klein/noord) — 4 events · Wix Events JSON-LD
- ✅ **Theater Amsterdam** (mainstream/groot/west) — 4 events · `ticketmaster`
- ✅ **Bourbon Street** (alternatief/klein/centrum) — 2 events · `bourbonstreet`
- ✅ **ZOJazz Stage** (alternatief/klein/zuidoost) — 5 events · `eventbrite` (organizer `70651461373`, jazz + wereldmuziek)
- ⬜ **Astarotheatro** — RSS in inventory; probe nodig
- ⬜ **Jazz Café Alto** — WP zonder custom event post-type
- ✅ **Perdu** (underground/klein/centrum) — 10 events · `perdu` (WP REST `events` CPT, filter NL-versies, datum uit detail-text "DD maand om HH:MM")
- ✅ **Plein Theater** (alternatief/klein/oost) — 22 events · `aaservices` (AA services-API `venue=123`, één JSON-call)
- ✅ **Podium Vrijburcht** (alternatief/klein/oost) — 14 events · `vrijburcht` (custom WP-listing, canonical-slug merging voor recurring shows)
- ⬜ **Salon de IJzerstaven** — probe
- ⬜ **Space for Dance Art** — probe
- ⬜ **Sugarfactory** — `/agenda/` 404, geen publieke events op site
- ✅ **Teatro Munganga** (alternatief/klein/zuid) — 37 events · `munganga` (WP REST product CPT, datum uit title, description uit content)
- ⬜ **Volta** — probe
- ⬜ **Zaal 100** — RSS in inventory; probe
- ⬜ **ZID Theater** — RSS in inventory; probe
- ❌ **Compagnietheater** — site gehackt (gokken-spam) — niet bruikbaar als bron

## Musea (30)

Musea programmeren tentoonstellingen (`kind=exhibition`), niet point-in-time events. Per-museum scraper is venue-specifieke HTML-parse.

- ✅ **STRAAT Museum** — 6 events · `straatmuseum`
- ✅ **FOAM** — 5 events · `foam` (Playwright, lokaal-only)
- ✅ **Oude Kerk** — 5 events · `oudekerk` (Next.js `__NEXT_DATA__`)
- ✅ **Wereldmuseum Amsterdam** — 5 lopende exhibitions · `wereldmuseum`
- ✅ **Nxt Museum** — 3 events · `nxtmuseum`
- ✅ **Van Gogh Museum** — 3 events · `vangoghmuseum` (Playwright + selectors)
- ✅ **Verzetsmuseum** — 3 events · LLM-import via admin
- ✅ **Rijksmuseum** — 3 lopende exhibitions · `rijksmuseum` (Playwright + selectors)
- ✅ **Amsterdam Museum** — 2 lopende exhibitions · `amsterdammuseum`
- ✅ **H'ART Museum** — 2 events · LLM-import
- ✅ **Huis Marseille** — 2 events · LLM-import
- ✅ **Stedelijk Museum** — 2 events · LLM-import
- ✅ **Cobra Museum** — 1 event · `cobramuseum`
- ✅ **De Nieuwe Kerk** — 1 event · `nieuwekerk`
- ⬜ **ARCAM** — probe
- ⬜ **Allard Pierson** — probe
- ⬜ **Artis** — probe
- ⬜ **Embassy of the Free Mind** — probe
- ⬜ **Het Scheepvaartmuseum** — probe
- ⬜ **Hollandsche Schouwburg** — probe
- ⬜ **Hortus Botanicus** — probe
- ⬜ **Joods Museum** — probe
- ⬜ **Moco Museum** — probe
- ⬜ **Museum Het Rembrandthuis** — probe
- ⬜ **Museum Het Schip** — probe
- ⬜ **Museum Van Loon** — probe
- ⬜ **NEMO Science Museum** — probe
- ⬜ **Nationaal Holocaustmuseum** — probe
- ⬜ **Ons' Lieve Heer op Solder** — probe
- ❌ **Anne Frank Huis** — vast museum, geen tentoonstellingen

## Galleries (40)

- ✅ **Arti et Amicitiae** (underground/klein/centrum) — 12 events · `arti`
- ✅ **W139** (underground/klein/centrum) — 8 events · `jsonld`
- ✅ **Bajesdorp - GROND** (underground/klein/oost) — 3 events · `ical`
- ✅ **CBK Zuidoost** (alternatief/middel/zuidoost) — 2 events · `cbkzuidoost`
- ⬜ **If I Can't Dance** — `stager` config klaar, shop leeg
- ⬜ **AKINCI** — probe
- ⬜ **Andriesse Eyck Galerie** — probe
- ⬜ **Annet Gelink Gallery** — probe
- ⬜ **Borzo Gallery** — probe
- ⬜ **Buro Stedelijk** — probe
- ⬜ **De Appel** — probe
- ⬜ **Ellen de Bruijne Projects** — probe
- ⬜ **Enari Gallery** — probe
- ⬜ **Framer Framed** — probe
- ⬜ **Framer Framed Noord** — probe
- ⬜ **GRIMM** — probe
- ⬜ **Galerie Bart** — probe
- ⬜ **Galerie Caroline O'Breen** — probe
- ⬜ **Galerie Fons Welters** — probe
- ⬜ **Galerie Onrust** — probe
- ⬜ **Galerie Ron Mandos** — probe
- ⬜ **Galerie de Schans** — probe
- ⬜ **Hama Gallery** — probe
- ⬜ **ISO** — probe
- ⬜ **Josilda da Conceição Gallery** — probe
- ⬜ **Kersgallery** — probe
- ⬜ **LANGArt** — probe
- ⬜ **Lumen Travo** — probe
- ⬜ **Madé van Krimpen Gallery** — probe
- ⬜ **No Man's Art Gallery** — probe
- ⬜ **OSCAM** — probe
- ⬜ **ROZENSTRAAT** — probe
- ⬜ **Slewe Gallery** — probe
- ⬜ **Stigter Van Doesburg** — probe
- ⬜ **TORCH Gallery** — probe
- ⬜ **Upstream Gallery** — probe
- ⬜ **Zone 2 Source** — probe
- ⬜ **galerie dudokdegroot** — probe
- ⬜ **puntWG** — probe
- ⬜ **tegenboschvanvreden** — probe

> Voor galleries is LLM-import via admin (zoals voor H'ART/Stedelijk) vaak praktischer dan een dedicated scraper — exposities draaien lang, lage cadans.

## Film (12)

- ⬜ **Cinema The Pulse** — Webflow CMS + FilmGenie booking; sitemap geeft alle films + DOM-rendered showtimes per detail-page
- ⬜ **Cinetol** — `stager` config klaar, shop momenteel leeg
- ⬜ **Cavia** — probe
- ⬜ **De Uitkijk** — probe
- ⬜ **Eye Filmmuseum** — probe (groot, hoge prioriteit)
- ⬜ **FC Hyena** — probe
- ⬜ **FilmHallen** — probe
- ⬜ **Kriterion** — probe (kandidaat voor `jsonld`)
- ⬜ **Lab111** — probe
- ⬜ **Rialto** — probe
- ⬜ **Studio/K** — probe
- ⬜ **The Movies** — probe

## Ruimtes / culturele plekken (37)

- ✅ **Ruigoord** (fringe/groot/nieuw-west) — 28 events · `ical`
- ✅ **Mediamatic** (alternatief/middel/oost) — 24 events · `stager`
- ✅ **Voedselpark Amsterdam** (fringe/klein/nieuw-west) — 8 events · `ical`
- ✅ **Plantagedok** (underground/klein/centrum) — 5 events · `ical`
- ✅ **Ru Paré** (alternatief/klein/nieuw-west) — 3 events · `ical`
- ✅ **Pakhuis de Zwijger** (mainstream/groot/centrum) — 52 events · `dezwijger` (custom HTML, paginated /agenda; events categorized als 'Lezing')
- ✅ **De Balie** (mainstream/middel/centrum) — 38 events · `debalie` (WP REST `vo-programme`, date in permalink, categorized als 'Lezing')
- ✅ **De Ceuvel** (alternatief/middel/noord) — 17 events (26 occurrences) · `deceuvel` (server-rendered tile-listing + month-headers, canonical-slug dedup, hi-res image via detail-page `data-original`)
- ✅ **Felix Meritis** (mainstream/middel/centrum) — 9 events · `felixmeritis` (WP REST `vo-event` + detail-fetch voor datum/tijd, default 'Literatuur')
- ✅ **NDSM Loods** (alternatief/groot/noord) — 2 events · `theater`
- ✅ **Rijksakademie van beeldende kunsten** (alternatief/middel/centrum) — 1 event · `rijksakademie` (listing-page met YYYY-MM-DD in URL, og:meta voor description/image)
- ⬜ **A Lab** — probe
- ⬜ **ADM Noord - Het Groene Veld** — probe
- ⬜ **AtelierWG Foundation** — probe
- ⬜ **Buurtwerkplaats Noorderhof** — probe
- ⬜ **De (Roze) Tanker** — probe
- ⬜ **De Ateliers** — probe
- ⬜ **De Fabriek** — probe
- ⬜ **De Hoop** (Zaandam) — probe
- ⬜ **De Omleiding** — probe
- ⬜ **De Sloot** — probe
- ⬜ **Het Motorblok** (Zaandam) — Squarespace Events collection bestaat maar is leeg; nog te onderzoeken wanneer ze 'm vullen
- ⬜ **Huis te Vraag** — probe
- ⬜ **KasKantine** — probe
- ⬜ **Kostgewonnen** — probe
- ✅ **LIMA** (alternatief/middel/centrum) — 0 events momenteel · `lima` (5 type-listings: talk/exhibition/screening/symposium/workshop; per article-tile DD-MM-YYYY + slug; og:meta voor description/image). 43 historische events geparsed, allemaal verleden — scraper wacht op nieuwe events. Default cat `Kunst`.
- ⬜ **Loods 6** — voornamelijk verhuur + ateliers; events sporadisch
- ⬜ **NieuwLand** — probe
- ⬜ **Parknest** — probe
- ⬜ **RijksHemelVaartDienst** — probe
- ⬜ **SEXYLAND World** — probe
- ⬜ **SPUI25** — Cloudflare managed-challenge blokkeert alles. Geprobeerd 2026-05-17: directe `fetch` → 403 (ook met Googlebot/Bing/Yandex/DuckDuck UA), headless Chromium via Playwright → 60s timeout op `networkidle` (challenge wordt nooit doorlopen). Vereist `playwright-extra` + stealth-plugin óf een externe service (FlareSolverr / ScrapingBee). Voor één venue te veel infra-overhead; gepauzeerd tot we meer Cloudflare-venues hebben die het samen rechtvaardigen.
- ⬜ **Steelhenge** — probe
- ⬜ **Treehouse NDSM** — probe
- ⬜ **Vondelbunker** — probe
- ⬜ **Workship op de Ceuvel** — probe
- ⬜ **[ woonruimte coöperatief ]** — private, probably skip

## Boekhandel-cafés (9)

- ✅ **De Nieuwe Boekhandel** (alternatief/klein/west) — 16 events · `nieuweboekhandel` (server-rendered `event-card` tiles, ID-based URLs)
- ✅ **Fort van Sjakoo** (underground/klein/centrum) — 1 event · `ical`
- ✅ **Athenaeum Spui** (mainstream/klein/centrum) — 4 events · `athenaeum` (Playwright + stealth, lokaal-only)
- ✅ **Scheltema** (mainstream/groot/centrum) — 4 events · `athenaeum` (zelfde scraper, `/agenda-scheltema`-pad)
- ✅ **Athenaeum Zuidoost** (alternatief/middel/zuidoost) — 4 events · `athenaeum` (zelfde scraper, `/agenda-zuidoost`-pad)
- ✅ **Boekhandel Van Rossum** (mainstream/klein/zuid) — 0 events momenteel · `athenaeum` (zelfde scraper, `/agenda-van-rossum`-pad; 2 tiles momenteel zichtbaar maar al gepasseerd)
- ✅ **The American Book Center** (mainstream/klein/centrum) — 5 events · `eventbrite` (generic, organizer `32908706629`, JSON-LD Event-schema)
- ❌ **Kanarie Club** — geen scraper nodig. WP zonder event-CPT; events worden niet publiek via website aangekondigd (vermoedelijk Instagram / mond-tot-mond).
- ⬜ **Noon coffee & culture** — heeft eventbrite-organizer (`116347191961`) maar momenteel leeg. Heractiveer met `scraperConfig.eventbrite = { organizerId: '116347191961' }` zodra ze events publiceren.

---

## Master TODO (alle ⬜ samengevat, op realistische prioriteit)

Volgorde op verwachte event-impact + scrape-effort.

**Blocked — extra infra nodig (Cloudflare managed-challenge):**

- 🟡 **SPUI25** — `/agenda` ~700 lezingen/jaar. Plain `fetch` → 403, headless Playwright `networkidle` timeout. **Stealth (playwright-extra + puppeteer-extra-plugin-stealth) is geprobeerd en passeerde Athenaeum prima, maar SPUI25 heeft een strictere challenge ("Even geduld...") die door stealth heen breekt. Volgende stap: FlareSolverr, of headed Chromium met menselijke interactie.**
- ✅ ~~Athenaeum Spui / Scheltema / Zuidoost~~ — Stealth werkte; 12 events live. Zie Boekhandel-cafés sectie.

**Quick-wins (platform al bekend, alleen config invullen):**
- ⬜ **Eye Filmmuseum** — film, mainstream
- ⬜ **Cinema The Pulse** — eigen Webflow + FilmGenie (custom scraper schrijven)
- ⬜ **Kriterion** — JSON-LD kandidaat
- ⬜ **FilmHallen / The Movies / Rialto / Studio/K / Lab111 / De Uitkijk / Cavia / FC Hyena** — film-venues, vergelijkbare aanpak

**Clubs zonder bron:**
- ⬜ **Café Café** — geen publieke feed gevonden
- ⬜ **Escape** — Fairtix-platform, dedicated scraper nodig
- ⬜ **Yellow House** — bron kiezen
- ⬜ **Warehouse Elementenstraat** — weeztix shop leeg (afwachten of vullen)

**Podia probes (kleinere venues):**
- ⬜ Astarotheatro, Plein Theater, ZID Theater, Podium Vrijburcht, Teatro Munganga, Volta, Space for Dance Art, Zaal 100, Salon de IJzerstaven, Perdu, Jazz Café Alto, Sugarfactory

**Musea probes (15× exposities):**
- ⬜ Allard Pierson, ARCAM, Artis, Embassy of the Free Mind, Het Scheepvaartmuseum, Hollandsche Schouwburg, Hortus Botanicus, Joods Museum, Moco, Rembrandthuis, Het Schip, Van Loon, NEMO, Holocaustmuseum, Solder

**Ruimtes probes (30+):**
- ⬜ De Ateliers, NieuwLand, en 22 alternatieve plekken (vooral underground/fringe AA-venues)

**Galleries probes (35+):**
- ⬜ De 35 galleries zonder feed. Realistisch: bulk-LLM-import via admin (zoals H'ART/Stedelijk), niet 35× dedicated scrapers.

**Boekhandel-cafés:**
- ⬜ Noon coffee & culture (Kanarie Club ❌; Athenaeum Spui + Scheltema + Zuidoost ✅)

## ❌ Niet doen (met reden)

- ❌ **Compagnietheater** — site gehackt (gokken-spam), geen bron
- ❌ **Anne Frank Huis** — vast museum, programmeert geen tentoonstellingen

Niet langer in DB (gesloten / verhuisd / nooit gepubliceerd):
- Marktkantine, Club NL, Club Home — `published=false` of verwijderd
- Casablanca Variété — niet in venue-tabel

---

## Open cleanup (audit 2026-05-17)

DB-audit over alle 51 actieve scrapers. De skill `scraper-add` werkt deze pijnpunten ook in voor nieuwe scrapers.

### 1. Recurring events nog niet gegroepeerd
Akhnaton heeft canonical-slug grouping; Anita en clones nog niet. Top ongegroepeerde recurring titels per venue:
- **De Nieuwe Anita** — Cinemanita & Fiber Factory (×10), Schrijfcafé Tussen de Regels (×6), Literanita (×3), Vrij Spel (×2), Comedy Queens (×2), Amsterdam Vinyl Club (×2), …
- **Chin Chin Club** — Mémoire | 18+ (×5), F.A.M. | 18+ (×4), Dynasty | 21+ (×2), Fusion | 20+ (×2). Slugs hebben `-N` suffix net als Akhnaton.
- **Theater Mascini** — Amsterdams Allooi (×4) — eigen pattern, geen `-N` maar `{id}-{slug}` met andere id per editie.
- **Podium DE FLUX**, **Ruigoord**, **Internationaal Theater Amsterdam** ("Public tour (in English)", "Openbare rondleiding (in het Nederlands)"), **Concertgemaal**, **De Krakeling**, **Club NYX**, **Madam** — telkens 2-3 dupes per recurring titel.

**Fix-patroon**: hergebruik de Akhnaton-aanpak — `canonicalKey(slug)` per scraper (strip `-N$` of `{id}-` prefix), group posts, één event-row, occurrence-row per editie.

### 2. Cross-language dupes (NL/EN)
- **Het Concertgebouw** heeft 1 bevestigde NL+EN-paar gevonden ("Samy Moussa & Poolse invloeden" / "Samy Moussa & Polish influences") — de `<html lang="nl">`-filter in `theater.ts` werkt grotendeels maar lekt soms.
- **ITA** "same-time"-paren zijn meestal Rabozaal vs Grote Zaal. Geen actie.

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

---

## Implementatie-notities

- **"RSS in inventory"** = WordPress site met `/feed/` endpoint, maar earlier check liet zien dat die feeds blog-posts mixen met events. Vereist Claude-filter per item.
- **Cloudflare-blocked venues** hebben Playwright nodig of een externe API (zoals Ticketmaster Discovery).
- **Cross-venue routing** (Tolhuistuin/Bitterzoet/Doka via Paradiso) is bewezen patroon — als we andere "moederpodia" tegenkomen kunnen we die opnieuw inzetten.
- **Ticketmaster Discovery API** is bewezen patroon voor 5 venues (AFAS Live, ArenA, Boom Chicago, RAI Theater, Theater Amsterdam). Tier-suffixes (`| VIP Packages`, `| Comfort Seats`) worden gestript en gededupliceerd, multi-night runs gegroepeerd via title-slug. Wikipedia summary van de hoofd-attractie als bron voor description.
- **Theater-scraper** (`apps/api/src/scrapers/theater.ts`) is een gegeneraliseerd patroon voor venues met een eigen agenda achter een SPA: sitemap.xml geeft de complete show-lijst, per show-page parseren we JSON-LD `Event`-blokken óf `data-date` attrs voor de datums. Werkt voor Carré (Vue-SPA, Googlebot UA), Meervaart (Phoenix LiveView), DeLaMar (data-date fallback), Bellevue + Bijlmer (Peppered SaaS), Concertgebouw (sitemap-index + future-slot filter).
- **FareHarbor calendar-API** (Boom Chicago) levert publiek (zonder auth) per item-id maandelijkse availabilities via `GET /api/v1/companies/{co}/items/{id}/calendar/{Y}/{M}/`.
- **Resident Advisor** (`ra.co/clubs/amsterdam`) heeft venue-pages voor de meeste underground clubs. Eén RA-scraper zou ~10 venues in één keer dekken — worth investigating als bulk-aanpak.
- **LLM-import via admin** is het bewezen pad voor venues met lange-lopende exposities (Stedelijk, Huis Marseille, H'ART, Verzetsmuseum). Lage cadans, geen dedicated scraper nodig.
