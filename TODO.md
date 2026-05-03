# Andreas — TODO

Live status van het project. Cross-checken met `HANDOFF.md` voor de oorspronkelijke briefing en met de huidige codebase voor de waarheid. Per open punt staat genoeg context om een agent zelfstandig te laten werken.

Laatste sync: 2026-05-03 (avond) · branch `main`.

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
- ⬜ Native build nodig zodra associatedDomains/intentFilters wijzigen — bv. extra share-paden toevoegen. iOS pakt AASA-changes server-side op binnen ~24h.
- ⬜ Push notificaties (`expo-notifications`).
- ⬜ Niet-leden uitnodigen via deeplink (full token-flow + auto-friendship op signup).

---

## Volgende slices — volgorde

1. **Venue-features** (scope nog vast te stellen): doorzoekbare venue-lijst + venue-volgen in drie stadia (volgen / normaal / blokken) — zie Wensen-sectie hieronder.
2. **Push notificaties** — `expo-notifications` + Apple Push Key (al via EAS gegenereerd) + server endpoint dat tokens registreert + verstuurt bij invite-accept, friend-request, etc.
3. **Niet-leden uitnodigen — token-flow** (zie `## Toekomstige slice` hieronder voor design).

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

**Fly secrets** (live in andreas-api): `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL=https://api.andreas.amsterdam`, `BUNNY_STORAGE_ZONE`, `BUNNY_STORAGE_PASSWORD`, `BUNNY_PULL_ZONE_URL`, `MESSAGEBIRD_ORIGINATOR=Andreas`, `MESSAGEBIRD_ACCESS_KEY`, `BIRD_WORKSPACE_ID`, `BIRD_CHANNEL_ID`, `APPLE_TEAM_ID=ZV933BZL7W`, `APPLE_BUNDLE_ID=amsterdam.andreas.app`.

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
- **Mock-files**: `apps/mobile/mocks/{feed,agenda,gered,jij,kaart}.ts` worden alleen nog op een paar plekken in Avond/Jij gebruikt voor copy-fallbacks (hero-strings, photoBand). Volledig uitfaseren wanneer die strings server-side komen.

---

## Wensen — als alles klaar is

- **Doorzoekbare venue-lijst** — een eigen route/scherm waar je alle venues kan browsen + zoeken (op naam, buurt, type). Nu zijn venues alleen indirect bereikbaar via events of de kaart.
- **Volgen van een venue in drie stadia** — `volgen` (boost: programmering komt extra omhoog in Avond/Vandaag), `normaal` (default, geen voorkeur), `blokken` (venue + diens events worden nergens meer getoond). Vervangt de huidige binaire follow-toggle op `/venue/[slug]`. Schema: `venue_follows.state` enum, of een aparte `venue_blocks` tabel.
- **Kaart venue ↔ events switch** — toolbar-toggle op de Kaart-tab tussen "venues" (één pin per locatie, samengevoegde info) en "events" (één pin per event, kan meerdere op zelfde venue tonen). Beide modi delen de bestaande sheet/listrow.

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
