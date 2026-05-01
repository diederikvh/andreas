# Andreas — TODO

Live status van het project. Cross-checken met `HANDOFF.md` voor de oorspronkelijke briefing en met de huidige codebase voor de waarheid. Per open punt staat genoeg context om een agent zelfstandig te laten werken.

Laatste sync: 2026-05-02 · branch `main`.

## Stand

**Fase 1 — Fundament**: ✅ klaar.

**Fase 2 — Statische schermen**: ✅ klaar — alle hoofdroutes zijn live op echte data.

**Fase 3 — Interactie**: ✅ klaar.
- ✅ Save-flow op event-detail (server-backed, heart toggle met optimistic update + haptic).
- ✅ `/friend/[id]` detail met avatar/handle + ontvolgen-knop + lijst van toekomstige saves.
- ✅ `/venue/[slug]` venue-detail met programma, "Route openen" naar device maps, lokale venue-save.
- ⬜ `/event/[id]/invite` modal — staat als open punt voor volgende slice (zie hieronder).
- ⬜ `/add-friend` heeft nu handle-search; QR-genereren + scannen nog niet (later).

**Fase 4 — Backend**: ⚙️ in werk, grootste delen klaar.
- ✅ Monorepo (`apps/mobile`, `apps/api`, `packages/shared`) met pnpm workspaces + `node-linker=hoisted` voor RN+Metro.
- ✅ Neon Postgres (Frankfurt) + Drizzle schema. Tabellen: users · friendships · venues · events · saves · venue_follows · session · account · verification.
- ✅ Hono API op `:8787` met better-auth (phone-OTP via MessageBird, expo + bearer plugins, 180-dagen sliding session).
- ✅ Bunny.net storage zone `andreas-x` + pull zone (avatar uploads via `POST /me/avatar`).
- ✅ API-routes: `/health`, `/me` (GET + PATCH + avatar), `/events` (incl. `friendsSaved`), `/events/:id`, `/venues/:slug`, `/saves` (toggle + list), `/friends` (list + request + accept + decline + remove + detail), `/users/search`.
- ✅ Mobile auth-flow: Jij is single auth surface (phone → OTP-code → naam + handle → profielpagina), inclusief avatar-upload + edit.
- ✅ Mobile data-laag: TanStack Query hooks (`useEvents`, `useEvent`, `useVenue`, `useMySaves`, `useFriends`, `useFriendRequests`, `useFriend`, `useUserSearch`).
- ✅ Avond + Agenda + Kaart + Gered + Detail allemaal live op de API.
- ✅ Friend-pill op event-rijen + friends-blok op event-detail. Privacy-gates moeten later (TODO-comment in `buildFriendsByEvent` en `GET /friends/:id`).
- ⬜ Invite-modal (zie volgende slice).
- ⬜ QR genereren + scannen op `/add-friend`.
- ⬜ Privacy-toggles op profiel (zichtbaarheid van saves voor vrienden).
- ⬜ Push notificaties (`expo-notifications`).
- ⬜ EAS build → TestFlight.

---

## Volgende slice

### Invite-flow — "Vraag iemand mee"

1. **API**:
   - Schema: `invites` tabel toevoegen (`fromUserId`, `toUserId`, `eventId`, `message`, `status` enum `pending|accepted|declined`, `createdAt`).
   - `POST /invites` met `{ eventId, toUserIds: string[], message? }` — schrijft één rij per ontvanger; weiger duplicates en self-invites.
   - `GET /invites` — mijn ontvangen invites (status pending), met inviter-profiel + event-info gejoind.
   - `POST /invites/:id/accept` + `POST /invites/:id/decline` — ontvanger only.
2. **Mobile**:
   - `/event/[id]/invite` route (modal-presentatie). Vrienden-checklist (uit `useFriends`), optionele message-textarea, "Stuur uitnodiging".
   - Op detail-screen: de bestaande "Vraag iemand anders mee" pill triggert deze route.
   - Op Jij: nieuwe "Uitnodigingen" sectie boven Vrienden, lijstje van ontvangen invites met accept/decline.
3. **Optioneel later**: bij accept ook automatisch een save aanmaken voor de ontvanger.

---

## Te fixen / technical debt

- **Privacy-gates**: `buildFriendsByEvent` en `GET /friends/:id` zien alle saves van vrienden. Zodra users een privacy-flag krijgen ("vrienden mogen mijn saves zien" toggle) moeten beide endpoints daarop checken.
- **Apple Maps mapType**: `mutedStandard` is alleen iOS — Android krijgt nog steeds standaard kaart. MapLibre swap voor echt-zwart Andreas-style staat als open punt.
- **MESSAGEBIRD_ACCESS_KEY** in `apps/api/.env` is leeg — OTP-codes loggen naar console. Vullen zodra een echte SMS-flow nodig is.
- **Connection string + Bunny key** zijn ooit in chat-history beland. Rotaten voor go-live (Neon → Reset password, Bunny → Reset FTP password).
- **Drizzle Studio** (`pnpm studio`) is een handige DB-browser tijdens dev. Niet uitchecken.
- **Kaart-tab dev-scripts**: `apps/api/scripts/{drop-all,clear-users,show-friendships,show-sessions,check-friends-pill}.ts` zijn dev-utilities. Niet automatisch draaien tijdens shared dev — `clear-users` wist sessies en haalt je inlog onderuit.
- **Mock-files**: `apps/mobile/mocks/{feed,agenda,gered,jij,kaart}.ts` worden alleen nog op een paar plekken in Avond/Jij gebruikt voor copy-fallbacks (hero-strings, photoBand). Volledig uitfaseren wanneer die strings server-side komen.

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
