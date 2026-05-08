# Scrapers — Prioriteit & Stand

Prioriteit-volgorde voor scraper-implementaties, op volgorde van impact (events × belang). Vink af zodra een venue events oplevert in DB.

**Stand**: 22/50 done — ~1.500 events live (Boom Chicago aangevuld met eigen-producties: +8 events / 170 occurrences).

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
| ✅ | RAI Theater | 7 / 12 occ | Ticketmaster Discovery API |
| ✅ | Theater Amsterdam | 3 / 4 occ | Ticketmaster Discovery API |
| ✅ | Carré | 48 / 235 occ | Theater-scraper (sitemap + JSON-LD `Event`, Googlebot UA) |
| ✅ | Meervaart | 51 / 83 occ | Theater-scraper (sitemap + JSON-LD `TheaterEvent`) |
| ✅ | DeLaMar | 109 / 365 occ | Theater-scraper (sitemap + `data-date` attrs, Googlebot UA) |

---

## ⬜ TODO (volgorde aangepast — Bimhuis & Concertgebouw omhoog)

### Phase 1 — XL/L impact (volgende-aan-de-beurt)
- ⬜ **Het Concertgebouw** — high-impact, eigen ticketsysteem (TM heeft 0 events). Vermoedelijk gestructureerd te scrapen
- ⬜ **Bimhuis** — wereldberoemd, dagelijks programma
- ⬜ **Internationaal Theater Amsterdam (ITA)** — eigen ticketsysteem
- ⬜ **Nationale Opera & Ballet (Stopera)** — eigen ticketsysteem

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
- **Theater-scraper** (`apps/api/src/scrapers/theater.ts`) is een gegeneraliseerd patroon voor venues met een eigen agenda achter een SPA: sitemap.xml geeft de complete show-lijst, per show-page parseren we JSON-LD `Event`-blokken óf `data-date` attrs voor de datums. Werkt voor Carré (Vue-SPA, Googlebot UA-trick), Meervaart (Phoenix LiveView), DeLaMar (data-date fallback). Op deze venues is TM-config bewust verwijderd — theater-bron is exhaustief en de TM-events waren een subset.
- **FareHarbor calendar-API** (Boom Chicago) levert publiek (zonder auth) per item-id maandelijkse availabilities via `GET /api/v1/companies/{co}/items/{id}/calendar/{Y}/{M}/`. Beschrijving via `/api/items/v1/{co}/{id}/structured-description/`, image via `/api/v1/companies/{co}/items/{id}/images/`. Generic `140084` item-id (gedeelde "Tickets" knop op alle show-pages) wordt overgeslagen.
