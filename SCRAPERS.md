# Scrapers — Status & TODO

Volledige inventory: elke gepubliceerde venue in de DB hier zichtbaar met status. ✅ events live · ⬜ nog te doen · ❌ niet doen (met reden).

**Stand (audit 2026-05-17)**: 87/196 gepubliceerde venues hebben momenteel toekomstige of lopende events (~4731 occurrences live). Lopende exhibitions (`starts_at` in verleden, `ends_at` in toekomst) tellen ook mee — dat is normaal voor musea.

Nieuwe event-categorie sinds 2026-05-17: **Lezing** (debat / talkshow / publieke-gesprek), apart van Literatuur. Eerste venue in deze categorie is Pakhuis de Zwijger.

Skill voor toevoegen van nieuwe scrapers: [.claude/skills/scraper-add/SKILL.md](.claude/skills/scraper-add/SKILL.md).

---

## Clubs (32)

- ✅ **West Weelde** (mainstream/groot/west) — 47 events · `westweelde` (Sanity CMS public-API, project `qcf0k7mi`)
- ✅ **Gashouder** (mainstream/groot/west) — 11 events · `gashouder` (Nuxt + DatoCMS GraphQL)
- ✅ **ClubUp** (alternatief/klein/centrum) — 10 events · `clubup` (Squarespace `?format=json-pretty`)
- ✅ **Odessa** (mainstream/klein/oost) — 10 events · `odessa` (Wix-home, events uit Hipsy.nl)
- ✅ **IJland** (alternatief/middel/noord) — 9 events · `ijland` (custom WP-theme, `.agenda_card`)
- ✅ **SUPPER** (mainstream/middel/centrum) — 8 events · `supper` (Elementor-cards op /club/, datum + lineup + ticket-URL per card)
- ✅ **Het Veronica Schip** (alternatief/klein/noord) — 7 events · `veronica` (`/api/events` JSON-feed, NDSM-werf)
- ✅ **Bar Dancing Multipla** (alternatief/klein/nieuw-west) — 11 events · `fullhouse` (Fullhouse.tech seller `solist-events-y4d6`, Next.js __NEXT_DATA__)
- ✅ **Levenslang** (alternatief/middel/oost) — 1 event · `levenslang` (Webflow CMS-collection)
- ⬜ **iNN** — `fourvenues` config gezet (slug `innams`); Playwright-only, lokaal te draaien
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

## Podia (68)

- ✅ **Amsterdamse Bostheater** (mainstream/groot/amstelveen) — 29 events · `bostheater` (custom WP-theme, `.event-card` HTML, multi-day support)

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
- ✅ **TivoliVredenburg** (mainstream/groot/Utrecht) — 873 events · `tivolivredenburg` (RSS-feed `/agenda/feed/`, tien per pagina via `?paged=N`; elk item draagt de volledige productie-JSON uit hun CMS). Hun HTML zit achter Cloudflare — node's fetch krijgt 403, ook vanaf Fly.
- ✅ **013** (mainstream/groot/Tilburg) — 151 events (162 occurrences) · `013` (`/programma` is één server-rendered pagina met het hele komende programma — geen paginatie, `?page=N` geeft dezelfde tegels; de JSON-LD `MusicEvent` op de detailpagina draagt datum mét offset, eindtijd, zaal, beeld, omschrijving en beschikbaarheid). Links absoluut én met niet-ASCII slugs (`axel-flóvent`, `käärijä`, `queensrÿche`) — matchen op `href="…"`, niet op het URL-patroon, anders vallen er zeven af. Categorie komt van de enrichment: 013 zet álles weg als `MusicEvent`, ook comedy. Prijs is het minimum uit het Entree-blok, want bij rangen staat de duurste bovenaan. Afgelaste shows houden een schone titel en zetten alleen `eventStatus` — vandaar `includeCancelled` op de JSON-LD-extractor; zonder dat bleef zo'n rij op `scheduled` staan omdat de scraper 'm nooit meer zag.
- ✅ **Rotterdam Ahoy** (mainstream/xl/Rotterdam) — 39 occurrences · `ticketmaster` (venueIds `Z598xZbpZdk7k` + RTM Stage `Z598xZbpZA1ee`). Géén eigen scraper nodig: alleen een venue-rij met een `scraperConfig`. Let op dat "Ahoy Parking" óók een TM-venue is met 197 "events" — dat zijn parkeerkaartjes.
- ✅ **de Doelen** (mainstream/groot/Rotterdam) — 38 occurrences · `ticketmaster` (venueId `Z198xZbpZA6F`; de twee andere Doelen-venues in TM staan leeg). Hun eigen site geeft een redirect-lus op onze UA, dus geen venue-beeld.
- ✅ **De Oosterpoort** (296 events / 324 occ) · **Stadsschouwburg Groningen** (158/209) · **De Machinefabriek** (24/31) · **Lutherse Kerk** (12/12) · **USVA** (7/12) · **A-Theater** (5/5) · **Nieuwe Kerk** (2/2) — `spot`. SPOT Groningen programmeert vier panden vanaf één `/programma/`-pagina (608 permalinks, geen paginatie); de scraper verdeelt ze over zeven venue-rijen op basis van `location.address`, want `location.name` is voor allemaal "SPOT Groningen". **Matchen gaat op pandnaam én straat**: hun adresveld is niet consistent — naast `SPOT/De Oosterpoort, Kleine zaal / Trompsingel 27` staat er ook kaal `Trompsingel 27, 9724 DA Groningen`, en `SPOT/Nieuwe Kerk ,` heeft een spatie vóór de komma. Op alleen de naam matchen kostte vijf Oosterpoort-voorstellingen. Martiniplaza en Stadspark blijven bewust ongemapt: Martiniplaza is een eigen organisatie waar SPOT af en toe co-presenteert, en één show onder die naam wekt de indruk dat we hun programma hebben. De tegels noemen het pand niet, dus elke detailpagina is nodig. `startDate` heeft een echte offset. De omschrijving in de JSON-LD is één teaserregel; de volle tekst komt uit de alinea's in de body.
- ✅ **Amare** (mainstream/groot/Den Haag) — 282 events (404 occurrences) · `amare` (niet in Ticketmaster, dus eigen scraper). `/nl/agenda?page=N`, vijftien per pagina, 19 pagina's. Per detailpagina staat er een JSON-LD `Event` per speeldatum — één event met meerdere occurrences, elk met z'n eigen zaal. Prijs en ticketlink zitten achter hun JS-kaartverkoop en staan niet in de HTML. **De occurrence-id draagt de tijd, niet alleen de datum**: Amare speelt geregeld matinee én avond op één dag, en met alleen de datum overschreef de tweede de eerste — 23 van de 404 momenten weg bij de eerste run.
- ✅ **Effenaar** (alternatief/groot/Eindhoven) — 129 events (130 occurrences) · `effenaar` (Next.js; `/agenda` draagt de complete Algolia-collectie mee in `__NEXT_DATA__` — 130 events in één response, `nbPages: 1`, zonder Algolia zelf aan te roepen). **Niet via `stager`**: `effenaar.stager.co` heeft geen shop, de stager-link op hun site hoort bij promotor Discophonic Orchestra. De collectie geeft dag, zaal, genres, beeld en verkoopstatus; de starttijd staat alleen op de detailpagina (hun `date` is een timestamp op 12:00 UTC, dus enkel de dag). Die detailpagina's zijn 1,6 MB per stuk omdat Next.js de hele query-cache erin bakt, dus we halen ze alleen op voor onbekende events of wanneer de dag verschoven is — daarna ververst de rest uit die ene collectie-fetch. Twee valkuilen: op een detailpagina staan tientallen `AgendaDetail-*` queries van gerelateerde events (welke bij de pagina hoort staat in `pageProps.queryParams.queryKey`; de eerste pakken geeft overal hetzelfde event), en hun `ends_at` is een kale wandklok die bij "00:00" naar de volgende dag moet rollen. Gemeten: eerste run 10 min met 130 detailpagina's, tweede run 13,6 s met nul.
- ✅ **Doornroosje** (alternatief/groot/Nijmegen) — 204 events (208 occurrences) · `doornroosje` (de homepage ís de agenda: 211 server-rendered permalinks, geen paginatie; hun events-sitemap heeft er 962, maar dat zijn die 211 plus 751 afgelopen). Per detailpagina komt de helft uit JSON-LD (datum, zaal, status) en de helft uit de HTML ernaast (prijs, genre-tags, de volle tekst — de `description` in de JSON-LD is één teaserregel). **De offset in hun `startDate` liegt**: er staat altijd `+00:00` bij een tijd die de Amsterdamse wandklok is. Nagemeten op elf events in zomer- én wintertijd, allemaal gelijk aan wat de pagina zelf toont. `parseAmsterdamLocal` negeert de offset, en dat is hier precies goed. Merleyn (Hertogstraat) staat in hetzelfde programma en komt binnen als `room`, naast Rode zaal en Paarse zaal. Drie festivalpagina's (Soulcrusher ×2, Zeitgeist) hebben géén `Event`-node en vallen af — die hangen in hun `festival-sitemap.xml`, met de datums alleen in de kop ("9 & 10 October 2026").
- ✅ **PAARD** (mainstream/groot/Den Haag) — 163 events (165 occurrences) · `paard` (`/event/` is het hele komende programma, `page/2` geeft 404; JSON-LD `Event` per detailpagina). Hun `startDate` heeft géén offset, dus wandklok via `parseAmsterdamLocal` — `new Date()` zou op Fly twee uur schelen. Genres komen uit hun eigen tag-strip in de HTML en gaan vóór de enrichment; de leeftijdsgrens die ertussen staat is geen genre. Afgelastingen gaan vanzelf goed: PAARD plakt `[GEANNULEERD]` in de titel, wat de sweep in `_cancellations.ts` al vangt.
- ✅ **De Roma** (alternatief/middel/Borgerhout, Antwerpen) — 135 events · `deroma` (server-rendered agenda, 10 pagina's van 16 tegels; detailpagina's leveren JSON-LD met omschrijving, zaal en eindtijd). Enige venue buiten Nederland; heeft geen `wijk`.
- ✅ **De Brakke Grond** (mainstream/middel/centrum) — 41 events · Playwright per show. Datums komen uit `.event-detail__tickets-date` (reeks/los/komma-lijst) met de tijd uit `.event-detail__tickets-info`; mét tijd één occurrence per speeldag, zonder tijd één doorlopende periode. Tot 2026-09-11 las de parser de lopende tekst en pakte hij er 1 van de 41.
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
- ⬜ **Cinetol** — `stager` config klaar, shop momenteel leeg
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
- ✅ **Eye Filmmuseum** — film, mainstream
- ✅ **Kriterion** — JSON-LD kandidaat
- ✅ **The Movies**
- ✅ **The Ketelhuis**
- ✅ **Studio/K**
- ✅ **Rialto**
- ✅ **Lab111**
- ✅ **De Uitkijk**
- ✅ **Cavia**
- ✅ **FilmHallen**
- ✅ **FC Hyena** 
- ✅ **Cinema The Pulse** — eigen Webflow + FilmGenie 
- ✅ **Cinecenter**
- ✅ **Cinema De Vlugt**
- ✅ **Rialto VU**

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

**Playwright (bewust niet in matrix):** ot301, thepulse, bimhuis, athenaeum, ontheroof, foam — runnen lokaal via `pnpm scrape <name>`, dagelijks 09:00 via `apps/api/scripts/scrape-local.sh` + launchd. fourvenues, paradiso, melkweg, muziekgebouw, thuishaven, weticket, qfactory, brakkegrond, ketelhuis en radioradio zaten hier ook in tot ze naar HTTP gingen.

---

## Implementatie-notities

- **Rate-limit-rem bij film-scrapers** — de 14 scrapers op `_film-dedup` lopen een film-lijst sequentieel af. Boven ~150 pagina's knijpt de bron af, waarna elke fetch de 15s-timeout van `fetchTextWithTimeout` volloopt en de CI-job z'n 25-minuten curl-timeout haalt (exit 28). Gemeten en gefixt bij `themovies` (580 pagina's) en `filmhallen` (202): `REQUEST_SPACING_MS = 200` plus een noodstop na 8 mislukte fetches op rij. De andere twaalf zijn nagelopen op 2026-08-23 en hebben het níet nodig — cinemadevlugt 24, studiok 17, uitkijk 28, ketelhuis 31, lab111 82, eye 84 pagina's (9-89s), en de rest itereert over maanden/producties/locaties in plaats van over een pagina-lijst. Rem toevoegen kost daar tijd zonder winst.

- **"RSS in inventory"** = WordPress site met `/feed/` endpoint, maar earlier check liet zien dat die feeds blog-posts mixen met events. Vereist Claude-filter per item.
- **Cloudflare-blocked venues** hebben Playwright nodig of een externe API (zoals Ticketmaster Discovery).
- **Cross-venue routing** (Tolhuistuin/Bitterzoet/Doka via Paradiso) is bewezen patroon — als we andere "moederpodia" tegenkomen kunnen we die opnieuw inzetten.
- **Ticketmaster Discovery API** is bewezen patroon voor 5 venues (AFAS Live, ArenA, Boom Chicago, RAI Theater, Theater Amsterdam). Tier-suffixes (`| VIP Packages`, `| Comfort Seats`) worden gestript en gededupliceerd, multi-night runs gegroepeerd via title-slug. Wikipedia summary van de hoofd-attractie als bron voor description.
- **Theater-scraper** (`apps/api/src/scrapers/theater.ts`) is een gegeneraliseerd patroon voor venues met een eigen agenda achter een SPA: sitemap.xml geeft de complete show-lijst, per show-page parseren we JSON-LD `Event`-blokken óf `data-date` attrs voor de datums. Werkt voor Carré (Vue-SPA, Googlebot UA), Meervaart (Phoenix LiveView), DeLaMar (data-date fallback), Bellevue + Bijlmer (Peppered SaaS), Concertgebouw (sitemap-index + future-slot filter).
- **FareHarbor calendar-API** (Boom Chicago) levert publiek (zonder auth) per item-id maandelijkse availabilities via `GET /api/v1/companies/{co}/items/{id}/calendar/{Y}/{M}/`.
- **Resident Advisor** (`ra.co/clubs/amsterdam`) heeft venue-pages voor de meeste underground clubs. Eén RA-scraper zou ~10 venues in één keer dekken — worth investigating als bulk-aanpak.
- **LLM-import via admin** is het bewezen pad voor venues met lange-lopende exposities (Stedelijk, Huis Marseille, H'ART, Verzetsmuseum). Lage cadans, geen dedicated scraper nodig.
