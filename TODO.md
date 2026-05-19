# Andreas — TODO

Live status van het project. Cross-checken met `HANDOFF.md` voor de oorspronkelijke briefing en met de huidige codebase voor de waarheid. Per open punt staat genoeg context om een agent zelfstandig te laten werken.

Laatste sync: 2026-05-16 · branch `main`.

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

**Fase 7 — SEO/GEO + App Store launch** (sessie 2026-05-12 / 2026-05-13): ✅ klaar.
- ✅ **SEO-pagina's voor events** (`/e/:id`) — uitgebreid van minimal share-redirect naar volledige SEO-pagina met `?ref=`-split: share-context houdt redirect, anders volledige pagina met JSON-LD (MusicEvent/TheaterEvent/ScreeningEvent/VisualArtsEvent/ExhibitionEvent), antwoord-capsule, facts-`<dl>` (datum/aanvang/locatie/prijs/genres/zaal/tickets), lineup, komende voorstellingen, FAQ, vergelijkbare events.
- ✅ **SEO-pagina's voor venues** (`/v/:slug`) — idem als events: JSON-LD (MusicVenue/Museum/ArtGallery/MovieTheater/CafeOrCoffeeShop/EventVenue), facts-tabel, komende events, FAQ, vergelijkbare venues (zelfde type + scene).
- ✅ **12 hub-pagina's** — `/muziek`, `/theater`, `/film`, `/kunst`, `/literatuur` (categorie), `/clubs`, `/musea`, `/podia`, `/bioscopen`, `/galeries` (venue-type), `/vandaag`, `/dit-weekend` (tijd). CollectionPage + ItemList JSON-LD, per-hub specifieke H2 voor venues-sectie. Top-nav-strip op homepage linkt alle 12.
- ✅ **Homepage uitgebreid** — tagline "Heel Amsterdam, in één agenda" + intro, hub-nav strip, "Komende events" (12 shows) + "Lopende exhibitions" (8) + "Venues in Amsterdam" (30 + `<details>` voor de overige ~167) + homepage FAQ (4 vragen, JSON-LD FAQPage). Download-buttons altijd in acid-geel.
- ✅ **Twee-koloms `page-grid` layout** op alle detail/hub-pagina's — events/venues-lijst links, sticky CTA-aside rechts op desktop (≥900px). Op iPad-portrait en mobile valt 't terug naar single column met sticky bottom-CTA i.p.v. aside.
- ✅ **Sticky mobile CTA-bar** onderaan op alle SEO-pagina's incl. homepage. Top-banner (renderAppBanner) niet meer sticky op mobile — sticky-bottom dekt de prominente actie af.
- ✅ **Event-thumbnails op homepage + hubs** — 56×56 lijn-stijl rijen met srcset (Bunny `?width=96/192` voor retina), lazy-loaded, placeholder met acid-kruisje voor events zonder image. Layout: thumb links, kicker (datum/tijd) boven titel, venue + genres in meta.
- ✅ **Internal link-clusters** — "Vergelijkbare events" op event-detail (zelfde venue + zelfde category, dedupe op event-id) + "Vergelijkbare venues" op venue-detail (zelfde type + scene). Plus "Venues op deze pagina" sectie op hubs met per-hub specifieke H2 ("Alle clubs in Amsterdam", "Musea & galeries in Amsterdam" etc.).
- ✅ **Ticket-link** in event-facts-rij + klikbare HTML FAQ-entry "Waar koop ik tickets voor X?" + JSON-LD FAQPage answer. Domain-extractor `ticketDomain()` toont `ot301.nl ↗` i.p.v. hele URL.
- ✅ **ImageObject met `creditText` + `copyrightHolder`** op event/venue JSON-LD + visuele "FOTO VIA X" credit rechtsonder hero-image. Plus `sourceOrganization` op event JSON-LD voor content-credit.
- ✅ **OG-image + favicon** — `/icon.png` (1024×1024 PNG van app-icoon, default OG-image), `/og.svg` (1200×630 brede card), `/favicon.png` + `/apple-touch-icon.png`. App-icons gekopieerd vanuit `apps/mobile/assets/` naar `apps/api/static/`; Dockerfile kopieert mee.
- ✅ **`/auteursrecht`** legal-pagina met formele takedown-procedure (NL). Footer-link op alle SEO-pagina's + nav-link in legal-shell.
- ✅ **Engelse versies** van privacy/voorwaarden/auteursrecht onder `/en/privacy`, `/en/terms`, `/en/copyright`. Hreflang-alternates koppelen NL- en EN-varianten; topnav heeft NL↔EN-toggle. Sitemap-venues bevat alle 6 legal-URLs.
- ✅ **Camera-permissie** + foto-bibliotheek + notificaties expliciet vermeld in privacy NL+EN (vereist door Google Play voor permission-review).
- ✅ **AI-crawler signaling** — `X-Robots-Tag: noai, noimageai` headers op eigen image-assets (`/icon.png`, `/og.svg`, `/favicon.png`, `/apple-touch-icon.png`); `<meta name="robots" content="index,follow,max-image-preview:large">` + `<meta name="ai-content-declaration" content="no-ai-training">` op alle SEO-pagina's.
- ✅ **Sitemap-architectuur** — `/sitemap.xml` index wijst naar `sitemap-hubs.xml` (12 + homepage), `sitemap-events.xml` (~2500) en `sitemap-venues.xml` (~200 + legal-URLs). Per-URL `<lastmod>`/`<changefreq>`/`<priority>`.
- ✅ **`robots.txt`** met expliciete `Allow:` voor Googlebot, Google-Extended, GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-Web, anthropic-ai, PerplexityBot, Perplexity-User, meta-externalagent, MistralAI-User. `/llms.txt` voor AI-crawler-overview.
- ✅ **ANDREAS in capitalen** op alle SEO-pagina's en homepage (consistent met app-conventie). Top-banner wordmark + ✕ in volgorde "ANDREAS ✕ {pagina-label} [Open in app]".
- ✅ **`PAGE_GRID_STYLES` gedeelde CSS** in `_seo.ts` voor hub/detail-page grid. `LIST_STYLES` voor lijn-rijen. `renderThumb()`/`renderEventMeta()`/`renderHeroImage()`/`renderMobileStickyCta()` helpers.
- ✅ **App Store knop activatie** — `APPLE_APP_ID=6765957164` + `APP_STORE_URL=https://apps.apple.com/nl/app/andreas/id6765957164` als Fly secrets. Alle download-buttons + smart-app-banner (`apple-itunes-app` meta) wijzen nu naar de echte App Store ID.
- ✅ **Google Search Console** geactiveerd via CNAME-DNS-verificatie. Submit `sitemap.xml` in Search Console nog open (zie post-launch sectie).

**Fase 8 — Profielinzicht + personalisatie + admin-insights** (sessies 2026-05-15 / 2026-05-16): in uitvoering. Plan-bestand: `/Users/vanhuijstee/.claude/plans/even-een-totaal-andere-smooth-frog.md`. **Belangrijk**: deze fase markeert een directionele wijziging weg van het "anti-algoritme"-frame uit de oorspronkelijke briefing — Andreas mag nu personaliseren, profileren en aanbevelen, mits transparant + niet engagement-maximizing. CLAUDE.md is op dat punt al bijgewerkt. UI-label is "Profielinzicht" / "Profile insight" (intern in de code nog `mirror*` om refactor-churn te voorkomen).

- ✅ **Schema-uitbreidingen** — `saves.source` enum (`venue`/`friend`/`search`/`op-gevoel`/`avond`/`agenda`/`kaart`/`series`/`gered`/`other`), `dismisses` tabel (left-swipes uit /op-gevoel persistent), `users.mirrorVisibility` enum, `friend_favorites(userId, friendId)` tabel. Beide visibility-enums uitgebreid met `'favorites'`-waarde. Migrations 0024–0026.
- ✅ **Source-attributie** — `toggleSave` accepteert source-string; alle 9 call-sites (avond/agenda/kaart/social/venue/friend/series/op-gevoel/RunningStrip) sturen het door via `?source=` URL-param naar `/event/[id]`. Heartbutton op event-detail leest source uit URL.
- ✅ **`GET /mirror/me` endpoint** — geaggregeerde data: top venues + isFollowed, top genres, wijken, venueTypes, categories, discovery-mix, monthly timeline, weekday-histogram, totals. (URL-pad nog `/mirror/*` voor compat met live mobile.)
- ✅ **`GET /mirror/u/:handle` endpoint** — vriend-zichtbare subset (top 3 venues + genres, géén counts) met privacy-gate (accepted friendship + `mirrorVisibility='friends'`, of `'favorites'` + target heeft mij gefavoreerd).
- ✅ **Profielinzicht-sectie op `/jij`** — identity-zin (template, geen LLM), top venues (klikbaar), top genres (chips in `bgTag`), wijken-bar (percentages), weekday-histogram, monthly timeline-bar, discovery-mix, micro-copy "Dit is wat je hebt gedaan." Empty-state als nog geen saves. Kopjes in display-stijl (rails-look), 18pt, `roles.fg`.
- ✅ **Persistent dismisses** — left-swipes op `/op-gevoel` → `POST /dismisses` (toggle). Filtert toekomstige stack-builds én scoring in `/events/for-you`.
- ✅ **`GET /events/for-you` scoring** — linear-weighted (+1 per genre-overlap-save, +2 per venue-overlap-save, +5 bonus voor gevolgde venue). Filters: al-gesavede events, dismisses, geblokte venues, score=0, geen occurrence in komende 21 dagen. Cap 30. Sort: score desc, dan eerstvolgende occurrence asc.
- ✅ **"Voor jou"-rail op Avond** — `useForYouEvents()` hook, rail boven heroDivider (omdat range 3 weken is, niet alleen vandaag). Kicker "Voor jou · komende 3 weken". Cards met `showDate` zodat dow + datum + tijd zichtbaar zijn ("Za 31 mei · 21:00"). Rail verbergt zichzelf bij lege data.
- ✅ **Bewerk profiel-scherm** — Notificaties + Privacy + Taal verplaatst hierheen (waren op Jij). Knop op `/jij` compact (pill + ✏️ pencil), zelfde footprint als RelationButton op vriend-profielen. Hoofdtitel "Profiel"; Cancel-knop weg (X rechtsboven sluit modal). Alle keuzes via generieke `SegmentPicker<T>`:
  - Wie ziet mijn saves — Favorieten / Vrienden / Niemand
  - Wie ziet mijn spiegel — Favorieten / Vrienden / Niemand
  - Vindbaar via zoeken — Aan / Uit
  - Taal — Automatisch / Nederlands / English
- ✅ **Favorieten-systeem** — `PUT /friends/:id/favorite { favorite }` toggle endpoint. Friend-list (`GET /friends`) include `favorite: boolean`, sorteert favorieten eerst (alfabetisch), rest erna (alfabetisch). Ster (`Ionicons star` in accent) naast naam in sociaal-tab.
- ✅ **Visibility-gates op 'favorites'** — `allowedViewerIds()` helper in `_helpers.ts`. Gate-logic toegepast in `buildFriendsByOccurrence` (friend-pills), `/social/feed` (sociaal-feed), `/friends/:id` (savesPrivate + mirrorShared booleans), `/mirror/u/:handle`. `'favorites'` = alleen vrienden die mij in `friend_favorites` hebben.
- ✅ **Friend-detail vernieuwd** — RelationButton onder handle (state-label "Volgend" / "Favoriet" + chevron). Tap → custom bottom-drawer (Modal `transparent` + `animationType="fade"`) met drie rijen (`★ Favoriet` / `👤 Volgend` / hairline / `🚫 Niet meer volgen`), checkmark op actieve state, dark backdrop tap-to-close. Segmented tabs (Aankomend / Profielinzicht) bovenaan, zelfde animated-blob look als Sociaal. Tabs alleen tonen als beide gedeeld worden; alleen-mirror of alleen-saves toont direct die pane; geen-van-beide toont "X deelt niks."
- ✅ **Admin-insights dashboard** — `/admin/insights` achter admin-auth, server-rendered (Pico.css + hono/jsx), via Insights-tab in admin-nav. Zes secties:
  - **Growth** — DAU / WAU / MAU / totaal-users stat-tiles op basis van `users.lastSeenAt` (nieuw veld, migration 0027; throttled-update 1×/u in GET /me). Uitklap-detail: dagelijkse signups + saves over 30 dagen met inline bar-visualisatie.
  - **Discovery-channel mix** — saves per source (venue/friend/op-gevoel/avond/...) met aandeel %. Legacy saves vóór attributie = "onbekend".
  - **Trending events · 7d** — top 25 op save-velocity, met uniek-user-count + ✓-pill als er nog upcoming occurrences zijn.
  - **Trending venues** — volgers, +30d nieuwe volgers, totaal saves, saves/volger ratio.
  - **Cat-trends · 6 maanden** — pivot maand × category.
  - **Wijken-heatmap · 6 maanden** — pivot maand × wijk met halftransparante acid-tint per cel (intensiteit relatief aan max).
  - **Editorial radar** — events met ≥5 saves in 7d waarvan savers in ≥3 verschillende vriend-clusters zitten (union-find op friendship-edges). Sorteert op clusters desc, dan saves desc. Top 20.
- ✅ **UI-polish ronde (2026-05-16)**:
  - `/jij` is nu een normaal pushed scherm (geen modal-presentation meer); BackButton top-left. Edit-profile is een echte `<Modal presentationStyle="pageSheet">` overlay. Onboarding-stages blijven full-page.
  - Modal-chrome consistent: iOS toont een drag-handle bovenaan (44×5 pill), Android een 36×36 ✕-knop linksboven. Toegepast op zowel edit-profile als de invite-modal. Invite-modal titel "Uitnodigen" verwijderd uit header.
  - `/jij` MirrorSection: top venues nu chips (i.p.v. rijen), tikbaar naar venue-detail. Genres ook tikbaar → `/agenda?q=<genre>` (agenda accepteert `?q=` URL-param als nieuwe deeplink-merge). Top venues op friend-detail Profielinzicht ook chips.
  - Friend-detail avatar tap opent lightbox-modal (donkere backdrop, foto contain-fit, tap-anywhere-to-close).
  - "Aankomend"-tab op friend-detail hernoemd naar **"Liked"** (NL + EN); empty-state "Nog niks geliket." / "Nothing liked yet."
  - Invite-modal vrienden-lijst sorteert nu favorieten eerst (alfabetisch) met ⭐-icoon naast naam; daarna rest alfabetisch; pending-requests onderaan.
  - "Spiegel"/"Mirror"-naam in UI vervangen door "Profielinzicht"/"Profile insight" (interne code-identifiers blijven `mirror*` om refactor-churn te voorkomen).
  - Bewerk-profielknop compact (pill + ✏️ pencil-icoon), zelfde footprint als de Volgend/Favoriet-knop op vriend-profielen.

**Fase 9 — Observability + groei** (sessie 2026-05-17): in uitvoering.

- ✅ **Sentry error-tracking wired** — `@sentry/react-native` met Expo config plugin (org `pluvo-bv` op EU-region), init in `_layout.tsx` met release=app-version + dist=updateId, `SentryUserBinder` koppelt user-id via `useMe()`, Metro via `getSentryExpoConfig` voor debug-id stempeling. API: `@sentry/node` v8 met `app.onError` + better-auth user-tagging, gated op `NODE_ENV === 'production'`. Beide DSNs hardcoded. Werkt: eerste issue zichtbaar in Sentry-dashboard direct na deploy.
- ✅ **Version bump 1.1.0 → 1.1.1 + native builds** — Sentry config plugin in `app.json` = native-config change → vereist `eas build` (niet OTA). iOS build #21 ingediend bij App Store Connect, Android AAB klaar voor download.
- ⬜ **iOS TestFlight-distributie afronden** — Apple processed build 21 (~5-10 min na submit), daarna verschijnt 'ie in TestFlight. Op TestFlight-tab een korte release-note: "Crash-reporting via Sentry — als de app onverwacht crasht zien we 'm nu meteen." Internal-testers groep ongewijzigd; external-testers groep weet ik niet wat de status is.
- ⬜ **Android Play Store submit** — AAB op `https://expo.dev/accounts/diederikvh/projects/andreas/builds/c70fb427-5e29-487a-ade6-b8dfceb89c00` handmatig naar Play Console, of `eas.json` aanvullen met submit-config (`submit.production.android.serviceAccountKeyPath` + Google Play API setup).
- ⬜ **Sentry release-notes per OTA** — bij elke `eas update` automatisch de commit-SHA + message als Sentry-release tag setten zodat per OTA-bundle de groep gevonden wordt.
- ⬜ **`/deze-week`-dashboard op andreas.amsterdam** (groei-prio, later) — publieke wekelijkse snapshot van top-saves van afgelopen 7 dagen (events + venues + genres). Cron-job vriest maandag 00:00 in; archief via `/deze-week/<jaar>-w<nr>`. Doel: pers-haakje (Parool, Subbacultcha, 3voor12), authority-signaal voor AI/Google ("wat was druk in Amsterdam?"), socially-shareable artefact, weekly fresh content voor SEO. Hergebruik `_seo.ts`-helpers. Voor: zie groei-checklist hieronder.

- ⬜ **"Voor jou" op Agenda** — copy van Avond-rail of natuurlijker geïntegreerd in tijdslijn. Plan noemde "/avond of /agenda".
- ⬜ **"Omdat je X volgt..."-venue-suggesties** — light collaborative filtering op venue-follows (welke venues hebben overlap met jouw save-patroon). Apart endpoint `/venues/for-you` of als sectie op Avond/Jij.
- ⬜ **Push voor matches** — match-logic + scheduler. Alleen voor events die hoog scoren tegen jouw profiel, en alleen bij gevolgde venues of genres met N≥3 saves. Géén "deze week speelt er..."-broadcast. `push_tokens` tabel bestaat al.
- ⬜ **Email digest** — wekelijks/maandelijks. Custom header-block met top-3 voorgestelde events, daarna editorial keuzes. Vereist mail-provider (Resend/Postmark) + cron.
- ⬜ **Reactivation-flow** — cron-scan op `users.lastSeenAt` na 2+ weken inactief. Stille trigger naar push of digest gebaseerd op profiel.
- ⬜ **Dag/nacht-split op profielinzicht** — was open designer-keuze uit het plan; bewust geparkeerd ("geen filter op de spiegel nodig nu").
- ⬜ **Wrapped-pagina** (uit plan-fase 4) — jaarlijkse terugblik in dag-mode paper-stijl, lange print-achtige scroll. Geen viral-mechanisme; rustig.
- ⬜ **Fase 4 — Sociaal & viraal** — friend-profile profielinzicht-uitbreiding ("samen gered" sectie), year-in-review export, "crossings" als één bericht in social feed ("5 vrienden hebben dit gered"), publiek `/deze-week`-dashboard op andreas.amsterdam (wekelijks bevroren top-saves, SEO/GEO + pers-stakeholder).

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

**Fly secrets** (live in andreas-api): `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL=https://api.andreas.amsterdam`, `BUNNY_STORAGE_ZONE`, `BUNNY_STORAGE_PASSWORD`, `BUNNY_PULL_ZONE_URL`, `MESSAGEBIRD_ORIGINATOR=Andreas`, `MESSAGEBIRD_ACCESS_KEY`, `BIRD_WORKSPACE_ID`, `BIRD_CHANNEL_ID`, `APPLE_TEAM_ID=ZV933BZL7W`, `APPLE_BUNDLE_ID=amsterdam.andreas.app`, `APPLE_APP_ID=6765957164`, `APP_STORE_URL=https://apps.apple.com/nl/app/andreas/id6765957164`, `APPLE_REVIEW_DEMO_PHONE`, `APPLE_REVIEW_DEMO_CODE`, `ADMIN_PASSWORD`, `ADMIN_API_KEY`, `EXPO_ACCESS_TOKEN`, `ANTHROPIC_API_KEY`.

**Admin + n8n koppeling**:
- Webview: `https://api.andreas.amsterdam/admin/login` → wachtwoord → 30-dagen httpOnly cookie. CRUD voor events/venues/series met "uitzetten"-toggle.
- n8n: `Authorization: Bearer <ADMIN_API_KEY>` op `https://api.andreas.amsterdam/admin/api/*`. Endpoints: `GET/POST /events`, `PATCH/DELETE /events/:id`, idem voor `venues` en `series`. Plus `POST /series/:id/events/:eventId` (koppel) en `DELETE` (ontkoppel). Velden zijn 1-op-1 de DB-kolommen; alle ints/dates worden gepareerd, categorie-arrays gefilterd op de 4 enum-waardes.
- Voor go-live: `fly secrets set ADMIN_PASSWORD=... ADMIN_API_KEY=$(openssl rand -hex 32) -a andreas-api`. Nieuwe API-deploy nodig om `/admin`-routes te activeren.

**Belangrijk** — als `app.json` `ios.associatedDomains`, `android.intentFilters`, plugins, of `bundleIdentifier` wijzigen, is het géén OTA maar een nieuwe `eas build`. Pure JS / styling / copy-veranderingen → OTA.

---

## Te fixen / technical debt

- **Sentry — sourcemap mapping verifiëren** (2026-05-17). Wiring + auth-tokens (shell + EAS-secret) staan; eerste events stromen binnen op `pluvo-bv.sentry.io`. Te checken bij eerste issue: zijn de stack-frames mapped naar bron-bestanden, of nog geminified? Bij geminified → sourcemap-upload niet doorgekomen (token-scopes, of debug-ids niet meegekomen). Native build #21 (v1.1.1) heeft sourcemaps via EAS-secret; OTA's daarna moeten via shell-env-token uploaden.
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
- [docs/groei-checklist.md](docs/groei-checklist.md) — 12 aspecten om bij elke product/strategie-keuze langs te lopen.
- [docs/n8n.md](docs/n8n.md) — admin-API + Bunny-uploads voor n8n-flows.
