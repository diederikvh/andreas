# Scrapers — Prioriteit & Stand

Prioriteit-volgorde voor scraper-implementaties, op volgorde van impact (events × belang). Vink af zodra een venue events oplevert in DB.

**Stand**: 25/50 done — ~2.080 events live.

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
| ✅ | RAI Theater | 7 / 12 occ | Ticketmaster Discovery API |
| ✅ | Theater Amsterdam | 3 / 4 occ | Ticketmaster Discovery API |
| ✅ | Carré | 48 / 235 occ | Theater-scraper (sitemap + JSON-LD `Event`, Googlebot UA) |
| ✅ | Meervaart | 51 / 83 occ | Theater-scraper (sitemap + JSON-LD `TheaterEvent`) |
| ✅ | DeLaMar | 109 / 365 occ | Theater-scraper (sitemap + `data-date` attrs, Googlebot UA) |

---

## ⬜ TODO (volgorde aangepast — Bimhuis & Concertgebouw omhoog)

### Phase 1 — XL/L impact (volgende-aan-de-beurt)
- ⬜ **Bimhuis** — wereldberoemd, dagelijks programma. Calendar = client-side load-more, vereist Playwright-scraper
- ⬜ **Internationaal Theater Amsterdam (ITA)** — agenda is volledig CSR, vereist Playwright of API-discovery
- ⬜ **Nationale Opera & Ballet (Stopera)** — Drupal, URL-harvest via `/programma/24` (opera) + `/programma/25` (ballet)

### Phase 2 — M impact
- ⬜ **Frascati** — onafhankelijk theater
- ⬜ **Theater Bellevue**
- ⬜ **Meervaart**
- ⬜ **Compagnietheater**
- ⬜ **Sugarfactory** — late-night, mogelijk Eventix
- ⬜ **Bijlmer Parktheater**
- ⬜ **Q-Factory** — multi-program (3 zalen)
- ⬜ **NDSM Loods**
- ⬜ **Podium Mozaïek**
- ⬜ **De Brakke Grond** — Vlaams cultuurhuis (verplaatst omhoog)
- ⬜ **OT301** — alt-circuit (verplaatst omhoog)
- ⬜ **Jazz Café Alto** — RSS-feed in inventory

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

---

## Aantekeningen

- "RSS in inventory" = WordPress site met `/feed/` endpoint, maar earlier check liet zien dat die feeds blog-posts mixen met events. Niet een echte quick-win — vereist Claude-filter per item. Rondom Phase 3 als groep aanpakken.
- Cloudflare-blocked venues hebben Playwright nodig of een externe API (zoals Ticketmaster Discovery).
- Cross-venue routing (Tolhuistuin/Bitterzoet/Doka via Paradiso) is bewezen patroon — als we andere "moederpodia" tegenkomen kunnen we die opnieuw inzetten.
- **Ticketmaster Discovery API** is bewezen patroon voor 5 venues (AFAS Live, ArenA, Boom Chicago, RAI Theater, Theater Amsterdam). Tier-suffixes (`| VIP Packages`, `| Comfort Seats`) worden gestript en gededupliceerd, multi-night runs gegroepeerd via title-slug. Geen Playwright nodig. Wikipedia summary van de hoofd-attractie als bron voor description (TM levert die niet).
- **Theater-scraper** (`apps/api/src/scrapers/theater.ts`) is een gegeneraliseerd patroon voor venues met een eigen agenda achter een SPA: sitemap.xml geeft de complete show-lijst, per show-page parseren we JSON-LD `Event`-blokken óf `data-date` attrs voor de datums. Werkt voor Carré (Vue-SPA, Googlebot UA-trick), Meervaart (Phoenix LiveView), DeLaMar (data-date fallback), Bellevue + Bijlmer (Peppered SaaS), Concertgebouw (sitemap-index + future-slot filter). Op de eerste 3 venues is TM-config bewust verwijderd — theater-bron is exhaustief en de TM-events waren een subset. Sitemap-index support volgt sub-sitemaps recursief; future-slot filter skipt enrich/image-mirror voor events met alle slots in het verleden (essentieel voor Concertgebouw met 4233 historische sitemap-entries: 490 nieuw, 3743 geskipt zonder Claude-cost).
- **FareHarbor calendar-API** (Boom Chicago) levert publiek (zonder auth) per item-id maandelijkse availabilities via `GET /api/v1/companies/{co}/items/{id}/calendar/{Y}/{M}/`. Beschrijving via `/api/items/v1/{co}/{id}/structured-description/`, image via `/api/v1/companies/{co}/items/{id}/images/`. Generic `140084` item-id (gedeelde "Tickets" knop op alle show-pages) wordt overgeslagen.
