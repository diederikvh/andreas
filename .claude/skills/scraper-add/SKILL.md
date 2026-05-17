---
name: scraper-add
description: Use this skill when adding a new venue scraper for Andreas — fetching events from a venue's website/agenda/ticket-platform into the database. Covers probing the target, picking the right pattern (direct-HTTP vs Playwright), choosing a template to copy, mandatory checklist (recurring-event dedup, image mirroring, idempotent inserts, NL/EN dedup), wiring into the registry and daily GitHub Actions matrix, and the production deploy. Invoke whenever the user says "add a scraper", "scrape <venue>", "events ophalen van …", or asks how to integrate a new event-source.
---

# Andreas scraper-add

Playbook voor een nieuwe scraper. Volg de stappen in volgorde — sla geen probe over, dat is de meest fout-makende stap.

## 0. Voorwaarden

- Venue zit **al** in de `venues`-tabel met `id`, `slug`, `name`, `lat`/`lng`, `type`, `published=true`. Zo niet: eerst venue toevoegen (handmatig SQL via `psql "$DATABASE_URL"` of via `POST /admin/api/venues`).
- DB-toegang: `apps/api/.env` bevat `DATABASE_URL` (Neon). Use `/opt/homebrew/opt/postgresql@17/bin/psql` (geen globale `psql` op deze machine).
- Bunny + admin creds: `BUNNY_STORAGE_ZONE`, `BUNNY_STORAGE_PASSWORD`, `BUNNY_PULL_ZONE_URL`, `ADMIN_API_KEY` — staan in `apps/api/.env`.

## 1. Probe het target — bepaal de juiste route

Voor elk venue 5 dingen checken **voordat** je code schrijft:

```bash
# A. Is er een ticket-platform? (de zilveren kogel — bestaande scraper hergebruiken)
curl -sL "$VENUE_AGENDA_URL" | grep -oE 'stager\.co|weeztix\.com|fourvenues\.com|celebratix\.io|web\.fourvenues\.com|shop\.celebratix|ticketmaster|weticket\.io|tribe-events|filmgenie|paylogic|fareharbor' | sort -u

# B. Is er een sitemap met event-URLs?
curl -sL "$VENUE_BASE/sitemap.xml" | grep -oE '<loc>[^<]+</loc>' | head -20

# C. Is er JSON-LD Event-data op een detail-pagina?
curl -sL "$VENUE_EVENT_URL" | grep -A30 'application/ld+json'

# D. Is er een ICS-feed?
curl -sLI "$VENUE_BASE/?ical=1" "$VENUE_BASE/events.ics" "$VENUE_BASE/agenda.ics" 2>&1 | grep -E '^HTTP|content-type'

# E. Is er een WordPress REST API met custom event post type?
curl -sL "$VENUE_BASE/wp-json/wp/v2/types" | python3 -c "import sys,json; [print(k) for k in json.load(sys.stdin).keys()]"
```

Resultaten mappen naar bestaande scraper-categorieën:

| Vondst | Scraper hergebruiken | Notitie |
|---|---|---|
| `stager.co` host | `stager` (config: `{ host, shopId }`) | `apps/api/src/scrapers/stager.ts` |
| `weeztix.com` / Eventix iframe | `weeztix` (config: `{ shopUuid }`) | |
| `web.fourvenues.com/iframe/{slug}` | `fourvenues` (config: `{ slug }`) — **Playwright!** | Lokaal-only |
| `shop.celebratix.io/event/` of channel-id | `celebratix` (config: `{ channel, ticketUrlBase? }`) | |
| `weticket.io` subdomain | `weticket` (config: `{ subdomain, locationName? }`) — **Playwright!** | Vercel-challenge |
| Tribe Events plugin (`/wp-json/tribe/events/v1/events`) | `eventscalendar` (config: `{ apiBase }`) | |
| `volkshotel.nl/en/agenda/{room}/` | `volkshotel` (config: `{ roomPath }`) | |
| Ticketmaster venue (Apollo of partner-zaal) | `ticketmaster` (config: `{ venueIds: [...] }`) | Wikipedia-fallback voor description |
| Sitemap met JSON-LD Event-blokken | `theater` (config: `{ sitemapUrl, showUrlPattern, useGooglebotUA?, useDataDateAttrs?, showSlugStripPattern? }`) | |
| Standalone JSON-LD per page | `jsonld` (config: `{ url }`) | |
| Standalone ICS | `ical` (config: `{ url }`) | |
| WP custom post type (geen ticketing) | **bouw venue-specifieke scraper**, twin van `denieuweanita.ts` of `akhnaton.ts` | |
| Niets server-rendered (SPA) | **Playwright** — twin van `paradiso.ts`/`melkweg.ts`/`ot301.ts` | Lokaal-only |

Als de venue in één van de "config:"-categorieën valt: gewoon `scraper_config` op de venue-row zetten en je bent klaar. **Geen nieuwe scraper-file nodig.**

## 2. Twee patronen: direct-HTTP vs Playwright

### Direct-HTTP (default — kies altijd dit als het kan)
- Server-rendered HTML, JSON REST, of XML feed
- Werkt in de Fly Docker image
- Komt in de daily CI matrix (zie stap 5)
- Geen browser-overhead, snel en cheap

**Best templates per situatie:**

| Pattern | Template | Wanneer |
|---|---|---|
| WordPress CPT + Elementor body | [`akhnaton.ts`](../../../apps/api/src/scrapers/akhnaton.ts) | Modern WP met page-builder content, custom date in HTML |
| WordPress CPT + custom-fields | [`denieuweanita.ts`](../../../apps/api/src/scrapers/denieuweanita.ts) | WP met `_post_meta_*`-velden zichtbaar in detail-HTML |
| Sitemap → page → JSON-LD | [`theater.ts`](../../../apps/api/src/scrapers/theater.ts) | Grote venues met SPA-frontend maar volledige sitemap |
| Ticket-platform API | [`stager.ts`](../../../apps/api/src/scrapers/stager.ts) | Gestructureerde JSON met titel/start/image/lineup |
| HTML-tile met regex | [`sieraad.ts`](../../../apps/api/src/scrapers/sieraad.ts) | Eenvoudige listing-pagina zonder JSON-LD |

### Playwright (alleen als directe HTTP echt niet kan)
- Voor SPA's die client-side renderen (Next.js zonder SSR, Vue, Phoenix LiveView die UA-checks doet)
- Voor sites achter Vercel/Cloudflare Security Challenges (WeTicket, sommige RA-pages)
- **Komt NIET in de Fly Dockerfile** — runt lokaal of in een aparte runner

**Templates:**
- [`paradiso.ts`](../../../apps/api/src/scrapers/paradiso.ts) — GraphQL met session-token
- [`melkweg.ts`](../../../apps/api/src/scrapers/melkweg.ts) — Next.js `__NEXT_DATA__` mining
- [`weticket.ts`](../../../apps/api/src/scrapers/weticket.ts) — Vercel-challenge passage
- [`fourvenues.ts`](../../../apps/api/src/scrapers/fourvenues.ts) — iframe-widget DOM
- [`muziekgebouw.ts`](../../../apps/api/src/scrapers/muziekgebouw.ts), [`ontheroof.ts`](../../../apps/api/src/scrapers/ontheroof.ts), [`bimhuis.ts`](../../../apps/api/src/scrapers/bimhuis.ts), [`ot301.ts`](../../../apps/api/src/scrapers/ot301.ts), [`radioradio.ts`](../../../apps/api/src/scrapers/radioradio.ts), [`foam.ts`](../../../apps/api/src/scrapers/foam.ts) — diverse DOM-extracties

## 3. Mandatory checklist voor élke scraper

Vink elk item af voor je merget. De audit van mei 2026 ([SCRAPERS.md "Open cleanup"](../../../SCRAPERS.md)) is een lijst van scrapers die deze punten ontberen — vermijd herhaling.

- [ ] **Idempotent**: event-id = `evt-{venueprefix}-{stableKey}`, occurrence-id = `occ-{venueprefix}-{stableKey}`. `onConflictDoUpdate` op insert, geen blinde inserts. Re-run op dezelfde dataset moet 0 nieuwe rows opleveren.
- [ ] **Recurring-event dedup**: één event-row + N occurrences, niet N events. Strip suffix-counters (`-N$`, `{id}-`, etc.) om de canonical key te krijgen. Zie `akhnaton.ts` → `canonicalKey()` en het `Map<canonical, items[]>`-grouping-patroon.
- [ ] **Year-inferentie verankerd op publish-date**: als de bron alleen "dag + maand" geeft (geen jaar), anker op `post.date_gmt`/equivalent, niet op `now()`. Anders rollen archief-events naar volgend jaar. Zie `akhnaton.ts` → `year = date.month < pubMonth ? pubYear + 1 : pubYear`.
- [ ] **Past-cutoff**: skip events ouder dan ~24h. Bronnen blijven oude events tonen.
- [ ] **HTML-entities decoden**: gebruik de standaard `decodeEntities`-helper (decimal `&#nnn;` + hex `&#xNNN;` + named). Pas toe op **alle user-facing strings** — title, description, lineup, room.
- [ ] **Image naar Bunny mirroren**: roep `uploadToBunny()` aan met deterministisch pad (`media/events/{prefix}-{slug}.{ext}`). Fallback op source-URL alleen als mirror echt faalt. **Nooit** een raw third-party URL in `events.imageUrl` zetten — dat veroorzaakt cold-cache LCP-issues en breekt als de bron de URL verandert.
- [ ] **Timezone**: gebruik `shiftToLocalTime(y, mo, d, h, mi)` (zie `akhnaton.ts:97-117`). Helper berekent het Amsterdam-offset (CET/CEST) zelf via `Intl.DateTimeFormat`.
- [ ] **NL/EN dedup voor sitemaps**: sites zoals Concertgebouw lijsten zowel `/concerten/{nl}` als `/concerten/{en}` in hun sitemap. Lees `<html lang="…">` op de detail-pagina en skip alles wat niet met `nl` begint. Pattern in `theater.ts`.
- [ ] **enrich-step**: roep `enrichEvent({ title, description, venueName, venueCategory })` aan voor category/genres/priceNote/lineup/room. Niet handmatig genre-hardcoden.
- [ ] **Result-rapport**: returneer `{ venueId, fetched, inserted, occurrencesUpserted, skipped, errors[] }`. Een per-scraper rij in de admin dashboard rapporteert dit terug.

## 4. Scraper-file structuur

Ieder TS-bestand exporteert:

```ts
export type FooResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeFoo(options?: { venueIds?: string[] }): Promise<FooResult[]>;
```

Het `options.venueIds` filter laat de admin endpoint per-venue triggeren als de scraper meerdere venues bedient (zoals `stager`, `theater`, `ticketmaster`).

## 5. Wire-up

### a. Registreren in `apps/api/src/scrapers/index.ts`

```ts
import { scrapeFoo, type FooResult } from './foo.js';

export const scrapers = {
  // ...bestaande
  foo: scrapeFoo,
} as const;

export type ScraperResult =
  // ...bestaande
  | FooResult;
```

### b. Daily CI matrix (`.github/workflows/scrape-stager.yml`)

**Alleen als de scraper pure-HTTP is** — voeg de key toe aan de matrix-array:

```yaml
matrix:
  scraper: [stager, ical, jsonld, ..., foo]
```

**Voor Playwright-scrapers**: NIET in de matrix zetten. Documenteer dat-ie lokaal draait (`pnpm scrape foo`). Optioneel: kondig in [`scripts/run-scraper.ts`](../../../apps/api/src/scripts/run-scraper.ts) een wekelijkse launchd/cron-suggestie aan.

### c. Bijwerken in `SCRAPERS.md`

Voeg een rij toe onder de juiste sectie (Clubs / Podia / Musea / Galleries) met het format: `✅ **{Naam}** (scene/cap/wijk) — {n} events · {scraper-naam of platform}`.

## 6. Lokaal testen

```bash
# Vanuit apps/api/
pnpm scrape foo

# Verifieer in DB
psql "$DATABASE_URL" -c "SELECT count(*) FROM events WHERE venue_id='foo-venue';"
psql "$DATABASE_URL" -c "SELECT title, image_url IS NOT NULL AS has_img, image_url LIKE '%andreas-x%' AS on_cdn FROM events WHERE venue_id='foo-venue' LIMIT 10;"

# Smoke-check op recurring-dedup
psql "$DATABASE_URL" -c "SELECT title, count(*) FROM events WHERE venue_id='foo-venue' GROUP BY title HAVING count(*)>1;"
```

Verwacht: 0 dupes op titel (of bewust verklaarbare, bv parallel-zaal). 100% on_cdn als de bron images geeft.

## 7. Deploy naar productie

De GitHub Actions cron hit `https://api.andreas.amsterdam` — dat is de Fly-deploy. Workflow-file op main is **niet voldoende**; de scraper-code moet ook in de productie-image zitten.

```bash
# 1. Commit + push
git add apps/api/src/scrapers/foo.ts apps/api/src/scrapers/index.ts .github/workflows/scrape-stager.yml SCRAPERS.md
git commit -m "feat(scrapers): foo — <korte beschrijving>"
git push origin main

# 2. Deploy API naar Fly (vanuit repo-root)
fly deploy --config apps/api/fly.toml --dockerfile apps/api/Dockerfile

# 3. Verifieer productie (admin key uit Fly secrets)
curl -X POST "https://api.andreas.amsterdam/admin/api/scrapers/run/foo" \
  -H "Authorization: Bearer $PROD_ADMIN_API_KEY"
```

Eerstvolgende auto-run: dagelijks 04:00 UTC via `.github/workflows/scrape-stager.yml`. Voor sneller verifieren: GitHub Actions UI → "Scrape venues" workflow → "Run workflow" (alle scrapers, of dispatch de specifieke key).

## 8. Bekende valkuilen

- **Pressable function-style** (mobile-related, irrelevant voor scrapers).
- **Cloudflare 403** op platte `fetch`: probeer eerst Googlebot-UA (`useGooglebotUA: true` in theater-config); werkt vaak. Anders: Playwright.
- **WP REST 404 op CPT** terwijl WP zelf werkt: check `/wp-json/wp/v2/types` voor de `rest_base` — het is niet altijd `events`/`event`. Akhnaton gebruikt `evenement`.
- **Stage-environment** in WP REST: sommige WP-sites publiceren via Polylang met `lang` query param. Default returns alleen 1 taal; pas `?lang=nl` of `?lang=en` aan.
- **Bunny upload faalt** met 401: check `BUNNY_STORAGE_PASSWORD` (niet de account-key, maar de storage-zone-specifieke key in Bunny → Storage Zones → FTP & API Access).
- **Idempotente re-run faalt** met 23505 unique constraint: je `onConflictDoUpdate` mist een veld. Inclusief title én startsAt verifiëren — de PK is event-id, niet titel.
- **Recurring slug zonder `-N` suffix** (bv. Theater Mascini: `842-vaart`, `906-vocal-jam`): pas de strip-regex aan op het venue-specifieke patroon. Mascini stript `^\d+-`, Akhnaton stript `-\d+$`.

## 9. Wanneer iets vragen aan Diederik

- Een venue uit de "121 met 0 events"-lijst die hij niet expliciet aanvroeg → niet zelf gaan bouwen.
- Een bron die LLM-extractie zou vereisen → bouw 'm in code (Claude Haiku direct via Anthropic SDK), niet via n8n. De n8n newsletter-workflow is legacy.
- Playwright-scraper toevoegen → vraag of-ie 'm in de lokale launchd/cron wil opnemen (de Fly Docker image heeft Playwright niet).
- Venue-data wijzigen (wijk, type, scene) zonder dat hij erom vraagt → eerst checken.
