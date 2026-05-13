# Andreas — TODO

Live status van het project. Cross-checken met `HANDOFF.md` voor de oorspronkelijke briefing en met de huidige codebase voor de waarheid. Per open punt staat genoeg context om een agent zelfstandig te laten werken.

Laatste sync: 2026-05-07 · branch `main`.

## Stand

**Fase 1 — Fundament**: ✅ klaar.

**Fase 2 — Statische schermen**: ✅ klaar — alle hoofdroutes zijn live op echte data.

**Fase 3 — Interactie**: ✅ klaar.
- ✅ Save-flow op event-detail (server-backed, heart toggle met optimistic update + haptic).
- ✅ `/friend/[id]` detail met avatar/handle + ontvolgen-knop + lijst van toekomstige saves.
- ✅ `/venue/[slug]` venue-detail met programma, "Route openen" naar device maps, lokale venue-save.
- ✅ `/event/[id]/invite` modal — uitnodigen met checklist + universele share-link.
- ✅ `/add-friend` — handle-search + QR-scanner via `expo-camera` + auto-prefill via `?handle=` of `?scan=1`.

**Fase 4 — Backend**: ✅ live op productie.
- ✅ Monorepo (`apps/mobile`, `apps/api`, `packages/shared`) met pnpm workspaces + `node-linker=hoisted` voor RN+Metro.
- ✅ Neon Postgres (Frankfurt) + Drizzle schema. Tabellen: users · friendships · venues · events · saves · venue_follows · session · account · verification.
- ✅ Hono API op `:8787` met better-auth (phone-OTP via MessageBird, expo + bearer plugins, 180-dagen sliding session).
- ✅ Bunny.net storage zone `andreas-x` + pull zone (avatar uploads via `POST /me/avatar`).
- ✅ API-routes: `/health`, `/me` (GET + PATCH + avatar), `/events` (incl. `friendsSaved`), `/events/:id`, `/venues/:slug`, `/saves` (toggle + list), `/friends` (list + request + accept + decline + remove + detail), `/users/search`.
- ✅ Mobile auth-flow: Jij is single auth surface (phone → OTP-code → naam + handle → profielpagina), inclusief avatar-upload + edit.
- ✅ Mobile data-laag: TanStack Query hooks (`useEvents`, `useEvent`, `useVenue`, `useMySaves`, `useFriends`, `useFriendRequests`, `useFriend`, `useUserSearch`).
- ✅ Avond + Agenda + Kaart + Gered + Detail allemaal live op de API.
- ✅ Friend-pill op event-rijen + friends-blok op event-detail. Privacy-gates moeten later (TODO-comment in `buildFriendsByEvent` en `GET /friends/:id`).
- ✅ Invite-flow — `invites` tabel + endpoints (`GET/POST /invites`, `:id/accept`, `:id/decline`, `GET /friends/outgoing`); `/event/[id]/invite` modal met EventListRow + vrienden-checklist (incl. pending outgoing als gedimde rijen) + bericht; "Door jou uitgenodigd" gemerged met "vrienden bij event" tot één Crew-blok onder de description (heading "Wie gaat erheen?"); Jij toont "Uitnodigingen" + "Aangevraagd" secties; accept maakt automatisch een save aan.
- ✅ **Fly deploy live**: API draait op `https://api.andreas.amsterdam` (Fly app `andreas-api`, regio `ams`). Public share-pages op `https://andreas.amsterdam/e/<id>` en `/v/<slug>` met OG-meta + scheme-redirect + App-Store-fallback. AASA op `/.well-known/apple-app-site-association` zodat iOS universal-links direct in de app opent.
- ✅ **EAS Update + TestFlight**: app gepubliceerd in TestFlight (bundle id `amsterdam.andreas.app`), expo-updates wired naar `production` channel. Volgende JS-fixes via `cd apps/mobile && eas update --branch production --message "..."` — geen rebuild nodig zolang native config niet wijzigt.
- ✅ **SMS via Bird Channels API**: workspace `80dad4a0-…` + channel `8bfa1eee-…` + access key in Fly secrets. UseCase "2FA" geregistreerd; alphanumeric originator `Andreas` voor NL.
- ✅ **Universal-link share-buttons**: top-right knop op event- en venue-detail (volgorde hart, share, beide met `heart` + `share-outline`). Opent native share-sheet met `https://andreas.amsterdam/{e|v}/<id>?ref=<userId>`.
- ✅ **Privacy-toggles**: `users.savesVisibility` (`friends`|`private`) + `users.discoverable` (boolean) op schema. PATCH /me ondersteunt partial updates. `buildFriendsByEvent` + `GET /friends/:id` filteren saves van `private`-users; `GET /users/search` skipt non-discoverable. Twee Switches in nieuwe Privacy-sectie op Jij. Friend-detail toont "X heeft saves op privé staan." als de friend het uitstaat.
- ✅ **QR-code voor handle**: `react-native-qrcode-svg` op profiel (modal-sheet met Andreas-X als logo-overlay, ECL=H zodat scan blijft werken). `expo-camera` scanner op `/add-friend` (parse-regex voor `andreas://u/<handle>` + `https://andreas.amsterdam/u/<handle>`). Server `GET /u/:handle` share-pagina + AASA `/u/*` zodat een gescande QR direct in de app opent. Vier action-pills op Jij (Mijn QR / Scan QR / Vrienden zoeken / Bewerk profiel) + Uitloggen onderaan, allemaal full-width met `bgChip`-border en medium-font normale-case.
- ✅ **Agenda filtering**: alleen events vanaf vandaag 00:00 (server-side `from`-query). Geen verleden events meer.
- ✅ **PendingRow X-knop**: uitstaand vriendschapsverzoek terugtrekken via confirm-alert + bestaande DELETE /friends/:userId endpoint.
- ✅ **Venue-features** — `venue_follows.state` enum (volgen|blokken; geen rij = normaal) + `venues.categories[]` array. Endpoints: `POST /venue-follows`, `GET /venues` (q+category filter), `myFollowState` op `/venues/:slug` + lijst-rijen, `venueFollowed` op events. Kaart uit tab-bar (`href:null`); nieuwe **Venues-tab** met kicker+title hero, chip-row (Alles · Volgend · 4 categorieën, agenda-styling), zoekveld + categorie-tags op rijen + follow-badge. Venue-detail: action-sheet met drie opties (Volgen/Niet volgen/Blokkeren) + uitleg per optie. Avond: photoBand vervangen door **Kaart-banner** met accent-tinted icon-tile; events nu gegroepeerd in "Venues die je volgt" + "Ook interessant" secties.
- ✅ **Admin webview + JSON-API** — `/admin/*` op de bestaande Hono-API. Wachtwoord-auth (`ADMIN_PASSWORD` Fly secret) zet httpOnly cookie; n8n-koppeling via `Authorization: Bearer <ADMIN_API_KEY>`. Webview is server-rendered HTML met Pico.css (CDN, geen build), JSX via `hono/jsx`. Pages: dashboard met counts, en CRUD voor events/venues/series met "uitzetten"-toggle. Series-detail koppelt/ontkoppelt events. JSON-mirror onder `/admin/api/*` (`GET/POST /events`, `PATCH/DELETE /events/:id`, idem voor venues + series, plus `POST/DELETE /series/:id/events/:eventId`). Alle entiteiten hebben een `published` boolean (default true) — public endpoints (`/events`, `/venues`, `/series`, `/saves`, friend-detail) filteren erop. Bestaande saves/invites/series-koppelingen blijven intact wanneer iets wordt uitgezet.
- ✅ **Bunny image-uploads via admin API** — `POST /admin/api/uploads` ondersteunt twee modi: JSON met `{ sourceUrl, kind }` (server fetcht externe URL → uploadt naar Bunny) of multipart `file` field. Returnt `{ url }` op CDN (`https://andreas-x.b-cdn.net/media/<kind>/<ts>-<rand>.<ext>`). Gebruikt door n8n-flows om externe foto's op onze EU-CDN te zetten. Limiet 8 MB, alleen `image/*` MIME. Documentatie + voorbeelden in [docs/n8n.md](docs/n8n.md).
- ✅ **Landing + privacy/voorwaarden** — `/` rendert een gecentreerde landing in [share.ts](apps/api/src/routes/share.ts): Archivo-wordmark + acid ✕ (CSS-rechthoeken zoals Cross-component), kicker "Amsterdam · 2026", twee outline-buttons (App Store + Google Play, via `APP_STORE_URL` / `PLAY_STORE_URL` env vars), footer met privacy/voorwaarden + "Gemaakt in Amsterdam · gehost in Frankfurt, Ljubljana en Amsterdam". `/privacy` en `/voorwaarden` in [legal.ts](apps/api/src/routes/legal.ts) — neutrale toon, sub-verwerker-tabel (Neon Frankfurt, Fly AMS, Bunny Ljubljana, Bird AMS, Apple IE), bewaartermijnen, AVG-rechten, contact `wij@andreas.amsterdam`. Datum-stempel in `LAST_UPDATED`-constant — bumpen bij elke wijziging.
- ✅ **App icon + splash** — Andreas-X kruis op noir achtergrond. Master assets in `assets/icons/{ios,android}/{dag,nacht}/` + `assets/splash/{dag,nacht}/`. Statische default = nacht (matcht app-default), iOS via 1024 App Store source, Android via adaptive foreground/background, splash-screen plugin met nacht-icon op `#0a0a0b` voor zowel light als dark system-mode. Live in TestFlight via native EAS build.
- ✅ **Series (festivals/cycli)** — `series` tabel + `events_in_series` M:N join. Endpoints: `GET /series` (lijst met eventCount, q+category filter, default alleen `featured=true`), `GET /series/:slug` (detail incl. events). `series[]` ook genest op `GET /events*` en `GET /venues/:slug`. Mobile: `/series/[slug]` detail-scherm (hero, datum-range, programma met EventListRow inclusief venue-naam). Series staan nu als **klikbare border-pill in de label-strip bovenaan event-detail** (naast de genres) — niet meer onderaan. Horizontale Series-sectie boven Venues-tab toont alleen `featured=true` series, voor periode-festivals zoals ADE/Holland Festival; mini-series rond een opening blijven default off zodat ze niet de hero-strook kapen. **Auto-expiry**: alle series-pills/lijsten filteren op `series.endsAt > now()` (NULL = doorlopend). Geen follow-systeem in v1. Seed-script `scripts/seed-series.ts` met ADE 2026 + Lenteballet 2026.

**Fase 5 — Occurrences-model + content-features** (sessie 2026-05-05): ✅ klaar.
- ✅ **events.kind + occurrences-tabel** — events zijn nu master-records met 1+ occurrences (= momenten). `kind` enum: `show` (concert/film/club/voorstelling/opening) of `exhibition` (doorlopende tentoonstelling). `occurrences` tabel: id, eventId, startsAt, endsAt, priceCents, priceNote, ticketUrl, room, lineup (jsonb), status (scheduled/cancelled/sold_out). `invites.eventId` → `invites.occurrenceId` — uitnodigen gebeurt voor een specifiek moment, niet abstract event. Saves blijven op event-niveau. Dataset gemigreerd via 0013+0014 met data-migratie ertussen.
- ✅ **Per-occurrence rendering** in Avond/Agenda/Kaart — `occurrencesInRange[]` op list-responses, mobile flat-mapt naar één rij per moment. Een 3-daagse festival verschijnt op alle 3 dagen, een wekelijks feest op elke maandag.
- ✅ **`?o=<occurrenceId>` targeting** — Agenda-tap geeft de specifieke avond door aan de detail-page (meta-rij + lineup + tickets-button + invite-target schakelen mee), met geanimeerde scroll-to-top + datum-pulse bij switch via `router.setParams`. Tap op een rij in de "Alle voorstellingen"-lijst werkt hetzelfde — geen page-reload.
- ✅ **Lineup-block** op event-detail — wie er optreedt voor de geselecteerde occurrence; per-occurrence-hint in de "Alle voorstellingen"-lijst (Mama Snake +2) zodat je per maandag ziet wie er speelt.
- ✅ **Effectieve eindtijd-cutoff** — Avond/Agenda/genres-buckets filteren op `COALESCE(endsAt, startsAt + 4u) >= NOW()`. Een ochtend-event tot 10:00 verdwijnt om 10:01, een feest 22:00-04:00 blijft tot 04:00 zichtbaar. Frontend `useNowMinute()`-hook tikt elke 60s zodat het ook tussen server-refetches automatisch werkt; `useEvents` heeft `staleTime: 60s` + `refetchOnWindowFocus`.
- ✅ **Tickets inline** ipv sticky dock — prijs links + Tickets-button rechts (occurrence-aware: `sold_out` toont muted "Uitverkocht"-pill; verberg helemaal als event afgelopen). Detail-page volgorde: hero → labels (genres + series) → algemene info → beschrijving → lineup → vrienden → tickets → alle voorstellingen.
- ✅ **Vrienden-blok** combineert crew (gesavde vrienden + verstuurde invites) en "Nog iemand uitnodigen"-CTA in één container, alleen de CTA krijgt achtergrond. Invite-modal toont expliciet "Je nodigt uit voor [datum]" voor multi-occurrence events.
- ✅ **Kunst-categorie** — `event_category` enum krijgt `'Kunst'` erbij (migration 0016). Showcase-events (Vincent in Auvers, Sara Sallam tentoonstelling + opening) staan onder Kunst met sub-genres als fotografie/modern/klassiek/schilderkunst. CATEGORY_TICK + CATEGORY_DOT, Avond-tabs en Agenda-filter ondersteunen 'm.
- ✅ **Multi-select category-filter** in Agenda — chip-toggle ipv exclusieve radio, URL-state `?cat=Muziek,Kunst`, SavedSearch.cats array, genre-buckets filteren op alle gekozen categorieën samen.
- ✅ **Series.featured flag** — alleen featured-series in de Venues-tab top-strook (festivals); mini-series rond een opening (zoals tentoonstelling+opening combo) blijven default off maar tonen nog wel als label-pill bij events. Migration 0015 + admin-toggle.
- ✅ **Showcase-seed** (`scripts/_seed-showcase.ts`) — film met 7 sessies, theater-residency met sold-out, museum-tentoonstelling 90 dagen, opening met DJ-set, wekelijks feest met wisselende lineup, sold-out concert, drie-daags festival-blok. Alle features in één voorbeeld.
- ✅ **Inventarisatie-script** (`scripts/_inventory-ingest.ts`) — checkt per venue website op iCal/JSON-LD/RSS/ticketing-platforms. CSV in `inventory.csv`. Clusters: 5 iCal · 5 JSON-LD · 5 Stager · 4 RA/Shotgun/Eventix/Paylogic · 25 RSS · 8 Eventbrite · 77 long-tail · 28 unreachable.
- ✅ **Push notificaties** — `push_tokens` tabel (migration 0017) + `expo-notifications` permissie-flow + token-registratie via PushManager component. Achtergrond-deliveries werken vanaf de API.
- ⬜ Native build nodig zodra associatedDomains/intentFilters wijzigen — bv. extra share-paden toevoegen. iOS pakt AASA-changes server-side op binnen ~24h.
- ⬜ Niet-leden uitnodigen via deeplink (full token-flow + auto-friendship op signup).

**Fase 6 — Imports + productie polish** (sessie 2026-05-07): in uitvoering.
- ✅ **Stager-scraper-pipeline** — 5 venues (Radion, Splendor, Cinetol, Mediamatic, If I Can't Dance) via `apps/api/src/scrapers/stager.ts`. 3-call pipeline (session/new → events met `offset+limit` pagineren → publicity + tickets-overview), Bunny image-mirror op deterministische paden, Claude Haiku 4.5 enrich-step (lineup/genres/room/priceNote/cleanedDescription) met strict prompt + tool-use. `venues.scraperConfig` jsonb-kolom (migration 0018) maakt elk platform plug-and-play. `POST /admin/api/scrapers/run/:name` endpoint, GitHub Actions cron daily 04:00 UTC. 60+ events live. Mediamatic uitgesteld tot er een tweede bron (website-scrape) is voor publicity.
- ✅ **Auth: cookie max-age 180d + client expires-check weg** — gebruikers werden na ~7 dagen onverwacht uitgelogd ondanks 180-dagen sliding-window server-side. Server zet nu expliciet `defaultCookieAttributes.maxAge = 180d`; mobile `getSessionBearer` vertrouwt server (geen client-side TTL-check meer). Internationaal telefoonnummer + iOS SMS-autofill (Apple domain-bound code) ook live.
- ✅ **Tap-target-pass** — alle filter-chips, tab-switches en kleine icon-buttons door de hele app op Apple HIG-minimum 44pt. fontSize 11/12/13 → 14, CHIPROW_HEIGHT 48 → 60, SUB_TAB_HEIGHT op Social 44 → 60. Search-chip in collapsed state een echt rondje (icon centered, geen left-edge offset). Filter-popup × sluit drawer altijd (ook zonder selectie).
- ✅ **X-thickness consistent op ratio 0.25** — logo, splash, SpinningCross (alle sizes), ModeCurtain. SpinningCross default = `Math.round(size / 4)` zodat call-sites geen thickness meer hoeven specificeren.
- ✅ **Header-titel naast Andreas-X** (Vandaag/Agenda/Venues/Sociaal/Kaart/Profiel) + Venues-pagina-kop weg (overbodig met header-titel).
- ✅ **Featured-carousel** op Vandaag — meerdere featured events vandaag worden een page-snap horizontale carousel met dots. Bij één featured: gewone hero-card.
- ✅ **Filter-knop op Kaart** in active-state vol fg (niet meer half-transparant met blur eronder); event-detail bottom-sheet sluit automatisch bij blur.
- ✅ **Mocks-folder uitgefaseerd** — `BadgeTone` + `Friend` types verhuisd naar `lib/types.ts`, `FEED` runtime-import weg uit avond.tsx. `apps/mobile/mocks/` volledig verwijderd (1961 regels weg).
- ✅ **Filter-bookmark-icoon** in accent-kleur voor extra opvallendheid.

---

## Volgende slices — volgorde

**Vulling & content** — open import-pipelines:
1. **iCal-pipeline** ⬜ — 5 venues uit `inventory.csv` (high-confidence): bajesdorp-grond, de-ateliers, plantagedok, ru-pare, ruigoord. Eén parser leest WordPress `?ical=1`-feeds, zelfde architectuur als Stager (`scrapers/ical.ts` + `scraperConfig.ical = { url }`). Geen pagineren, geen JWT — server-side gerenderde `.ics` files. Volgende slice.
2. **JSON-LD-pipeline** ⬜ — 5 venues (filmhallen, kriterion, lofi, the-movies, w139). Schema.org Event-blocks parsen via fetch + cheerio/regex op `<script type="application/ld+json">`. Kriterion levert al ~138 events per fetch.
3. ✅ **Stager-pipeline** — afgerond in Fase 6 (zie boven).
4. **Platform-ingesters** ⬜ — Eventbrite (8 venues), Eventix (2), Paylogic (2), Ticketmaster (Melkweg), Ticketkantoor (Perdu), Active-tickets (Bimhuis). Per platform één scraper-module.
5. **RA + Shotgun** ⬜ — vereist Playwright/Browserless (Cloudflare 403 op platte fetches) of API-keys. Aparte beslissing — start met Garage Noord als RA-pilot.
6. **Mediamatic-website-scrape** ⬜ — Mediamatic vult Stager niet rijk (geen description/image). Tweede bron op `mediamatic.net`: HTML-fetch + Claude-extract per event-titel. Activeer Mediamatic's Stager-config zodra tweede bron werkt.
7. **Long-tail / nieuwsbrief-pipeline** ⬜ — `ingest@andreas.amsterdam` → LLM-extractor (Claude Haiku) → admin review-queue. Voor de 77 venues zonder feed. n8n-workflow `CHIhtPcjY0Gsw0SJ` is een eerste schets maar niet productief — opnieuw bekijken na iCal/JSON-LD slices.
8. **Kapotte venue-URLs fixen** ⬜ — 28 venues in `inventory.csv` met dood domein (Volta, Nachbar, SEXYLAND, Bret, etc.) — snel door admin lopen of een script dat per venue-naam een DuckDuckGo-search doet.
9. **Festival-flows** ⬜ — ADE, Lenteballet, London Calling die events koppelen aan series met `featured=true`.

**App-features**:
10. **Niet-leden uitnodigen — token-flow** ⬜ (zie `## Toekomstige slice` hieronder voor design).
11. **Dynamic app-icon (iOS)** ⬜ — `expo-alternate-app-icons` plugin + JS-call vanuit `useMode()` om het home-screen-icoon mee te laten kleuren met nacht/dag. Vereist native rebuild + brengt iOS-systeem-popup bij elke wissel. Optioneel.

---

## Toekomstige slice — niet-leden uitnodigen via token

Ontworpen 2026-05-03, niet ingebouwd omdat de basis (share-buttons + universal-links) al volstaat voor v1.

**User-flow:**
- Inviter tikt share-button → app vraagt server om een share-token → URL = `https://andreas.amsterdam/{e|v}/<id>?ref=<TOKEN>`.
- Ontvanger tikt link:
  - **Heeft app, ingelogd, al bevriend** → claim creëert alleen een save voor het event.
  - **Heeft app, ingelogd, nog geen vriend** → claim creëert friendship (direct accepted, klik IS bevestiging) + save.
  - **Heeft app niet** → App Store fallback → na install + re-tap op de WhatsApp-link → zelfde flow als hierboven.
- Niet meegenomen v1: deferred deep-link voor scenario zonder re-tap (App Store carrieert de URL niet door op iOS).

**Schema:**
```sql
share_invites (
  id text primary key,
  from_user_id text not null references users(id) on delete cascade,
  event_id text references events(id) on delete cascade,
  venue_id text references venues(id) on delete cascade,
  token text not null unique,
  claimed_by_user_id text references users(id) on delete set null,
  claimed_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
)
```
Token = random URL-safe string van 16-24 chars, expiry default 30 dagen.

**Endpoints:**
- `POST /share-invites { eventId? venueId? }` — auth-only, retourneert `{ token, url }`.
- `POST /share-invites/:token/claim` — auth-only, idempotent. Effecten: friendship upsert (accepted), event-invite upsert (accepted, auto-save), share_invite.claimedBy/At zetten.

**Mobile:**
- Share-button niet meer client-side een URL bouwen — `POST /share-invites` → URL → share-sheet.
- `app/e/[id].tsx` + `app/v/[slug].tsx` redirect-routes lezen `ref` uit URL-params, saven token in AsyncStorage.
- Nieuwe `useClaimPendingShare` hook in root-layout: bij app-launch checkt op token in AsyncStorage, claim-call als ingelogd, toast met "Je bent nu vrienden met X en gaat naar Y."

Geschat: ~150 regels backend, ~80 regels mobile, ~2-3u.

---

## Status van de productie-stack

| Onderdeel | Waar | Hoe te bereiken |
|---|---|---|
| API | Fly.io app `andreas-api`, regio `ams` | `fly deploy --config apps/api/fly.toml --dockerfile apps/api/Dockerfile` (vanuit repo-root) |
| API URL | `https://api.andreas.amsterdam` | DNS via je registrar, TLS via Fly |
| Public share + AASA | `https://andreas.amsterdam` (root) | Zelfde Fly-app, host-routed |
| Database | Neon Postgres (Frankfurt) | `pnpm studio` lokaal, of Neon-dashboard |
| Avatar storage | Bunny.net storage zone `andreas-x`, pull `https://andreas-x.b-cdn.net` | API doet uploads via `POST /me/avatar` |
| SMS / OTP | Bird (voorheen MessageBird) Channels API | Live keys in Fly secrets |
| TestFlight | App Store Connect "Andreas" | EAS Cloud builds + `eas submit` |
| OTA-updates | Expo Updates, channel `production` | `cd apps/mobile && eas update --branch production --message "..."` |
| Admin-panel | `https://api.andreas.amsterdam/admin` | Wachtwoord-login (`ADMIN_PASSWORD`), één-user superadmin |

**Fly secrets** (live in andreas-api): `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL=https://api.andreas.amsterdam`, `BUNNY_STORAGE_ZONE`, `BUNNY_STORAGE_PASSWORD`, `BUNNY_PULL_ZONE_URL`, `MESSAGEBIRD_ORIGINATOR=Andreas`, `MESSAGEBIRD_ACCESS_KEY`, `BIRD_WORKSPACE_ID`, `BIRD_CHANNEL_ID`, `APPLE_TEAM_ID=ZV933BZL7W`, `APPLE_BUNDLE_ID=amsterdam.andreas.app`, `ADMIN_PASSWORD`, `ADMIN_API_KEY`.

**Admin + n8n koppeling**:
- Webview: `https://api.andreas.amsterdam/admin/login` → wachtwoord → 30-dagen httpOnly cookie. CRUD voor events/venues/series met "uitzetten"-toggle.
- n8n: `Authorization: Bearer <ADMIN_API_KEY>` op `https://api.andreas.amsterdam/admin/api/*`. Endpoints: `GET/POST /events`, `PATCH/DELETE /events/:id`, idem voor `venues` en `series`. Plus `POST /series/:id/events/:eventId` (koppel) en `DELETE` (ontkoppel). Velden zijn 1-op-1 de DB-kolommen; alle ints/dates worden gepareerd, categorie-arrays gefilterd op de 4 enum-waardes.
- Voor go-live: `fly secrets set ADMIN_PASSWORD=... ADMIN_API_KEY=$(openssl rand -hex 32) -a andreas-api`. Nieuwe API-deploy nodig om `/admin`-routes te activeren.

**Belangrijk** — als `app.json` `ios.associatedDomains`, `android.intentFilters`, plugins, of `bundleIdentifier` wijzigen, is het géén OTA maar een nieuwe `eas build`. Pure JS / styling / copy-veranderingen → OTA.

---

## Te fixen / technical debt

- **Privacy-gates**: `buildFriendsByEvent` en `GET /friends/:id` zien alle saves van vrienden. Zodra users een privacy-flag krijgen ("vrienden mogen mijn saves zien" toggle) moeten beide endpoints daarop checken.
- **Apple Maps mapType**: `mutedStandard` is alleen iOS — Android krijgt nog steeds standaard kaart. MapLibre swap voor echt-zwart Andreas-style staat als open punt.
- **Lokale `apps/api/.env`** kan nog leeg zijn — productie draait alleen op Fly secrets. Voor lokaal werken: handmatig dezelfde keys overnemen of Bird key vrij laten (SMS-module logt OTP dan naar console).
- **Connection string + Bunny key + Bird key** zijn ooit in chat-history beland. Rotaten voor publieke launch (Neon → Reset password, Bunny → Reset FTP password, Bird → nieuwe access key + oude revoken). Daarna `fly secrets set` met de nieuwe waardes.
- **`MESSAGEBIRD_ACCESS_KEY` env-naam** is een legacy: nieuwe naam zou `BIRD_ACCESS_KEY` zijn. Werkt fijn zoals 't is, ooit clean te trekken in `apps/api/src/sms/messagebird.ts`.
- **Drizzle Studio** (`pnpm studio`) is een handige DB-browser tijdens dev. Niet uitchecken.
- **Kaart-tab dev-scripts**: `apps/api/scripts/{drop-all,clear-users,show-friendships,show-sessions,check-friends-pill}.ts` zijn dev-utilities. Niet automatisch draaien tijdens shared dev — `clear-users` wist sessies en haalt je inlog onderuit.

---

## Wensen — als alles klaar is

- **Kaart in venues-context** — zoals events nu een map+list-toggle hebben op de Kaart-route, zou een "venues op kaart"-modus ook fijn zijn (pins voor alle venues geografisch, niet beperkt tot vandaag-events). Nu via de Venues-tab als alfabetische lijst.
- **Series volgen/blokken** — zelfde 3-state-systeem als venues (`series_follows.state` enum). Gevolgde series boosten in Avond, geblokkeerde verbergen al hun events overal. Post-v1.

### Post-launch SEO / analytics-vervolg

- **Plausible (of Simple Analytics) toevoegen** — privacy-vriendelijke pageview/referrer-tracking. Search Console laat alleen Google-traffic zien; voor inzicht in ChatGPT/Perplexity/Reddit-referrers, conversie op "Open in App"-knop en welke event/venue-pagina's populair zijn is een analytics-tool nodig. Plumbing kan via env-var (`PLAUSIBLE_DOMAIN`) zodat één Fly-secret de tracking activeert. Toevoegen wanneer ~paar duizend pageviews/maand binnenkomen.
- **Bunny CDN edge-rules** — Image Optimizer aanzetten (anders heeft de `srcset`-werk op event-thumbs geen effect), plus `X-Robots-Tag: noai, noimageai` als response-header voor `/media/*` paden. Beide via Bunny dashboard, geen code-werk.
- **Wikidata-entries voor grote venues** — voeg `https://andreas.amsterdam/v/<slug>` toe als external identifier op Wikidata-entries van Paradiso, Stedelijk, Concertgebouw, Bimhuis etc. AI-engines resolven entiteiten via Wikidata; sterk signaal voor brand-recognition.
- **Search Console: sitemap submitten** — als nog niet gedaan na CNAME-verificatie. In Search Console → Sitemaps → `sitemap.xml`. Versnelt indexering substantieel.
- **Per-hub app-deeplinks** — nu opent `andreas://` algemeen; voor `/muziek` zou `andreas://agenda?category=Muziek` direct de juiste filter in de app openen. Vereist deeplink-handler in `apps/mobile/app/(tabs)/agenda.tsx` die query-params leest.

---

## Niet meegenomen / opzettelijk gesloopt

- **Custom Andreas-iconen** — Ionicons doet het werk, custom set is design-iteratie.
- **Apple Sign-In** — niet nodig zolang phone-only login. Toevoegen bij social-login.
- **Sticky date-anchors** in Agenda — day-strip is sticky, anchors scrollen mee.
- **Bottom-sheet snap-points** op Kaart — manual drag voldoet voor V1.
- **Settings toggles + Algemeen-sectie op Jij** — past pas bij preferences-store.
- **`expo-linear-gradient` op Avond featured card** — vlakke overlay nu, gradient is implementatie-stapje.
- **Saffron blob rechtsonder op Avond featured in dag-mode** — visueel detail uit de mock.

---

## Werkdocumenten

- [HANDOFF.md](HANDOFF.md) — oorspronkelijke briefing van de designer. Niet aanpassen tenzij scope echt verandert.
- [app.html](app.html) — master-mockup, bron van waarheid voor copy + visual design. Lees per `phone-<naam>` blok.
- [start-screen.html](start-screen.html) — splash + welkom-flow.
- [CLAUDE.md](CLAUDE.md) — briefing voor elke nieuwe Claude-sessie.
