# Andreas — TODO

Live status van het project. Cross-checken met `HANDOFF.md` voor de oorspronkelijke briefing en met de huidige codebase voor de waarheid. Per open punt staat genoeg context om een agent zelfstandig te laten werken.

Laatste sync: 2026-05-01 · branch `main`.

## Stand

**Fase 1 — Fundament**: ✅ klaar.

**Fase 2 — Statische schermen**: ✅ klaar voor de zes hoofdroutes (Avond / Detail / Agenda / Gered / Jij / Kaart). Alle data komt uit `apps/mobile/mocks/*.ts`.

**Fase 3 — Interactie**: ⚙️ in progress.
- ✅ Save-flow op event-detail (Zustand + AsyncStorage in [`apps/mobile/store/saved.ts`](apps/mobile/store/saved.ts), heart met scale + haptic, "Net opgeslagen" sectie in Gered).
- ⬜ Modals (`/event/[id]/invite`, `/add-friend`) — geparkeerd tot na fase 4 want vereist auth + friends-data uit DB.
- ⬜ `/friend/[id]` en `/venue/[id]` detail-schermen — geparkeerd tot na fase 4 (data-driven).
- ⬜ dn-switch óók op Jij — designvraag, nog niet beantwoord.

**Fase 4 — Backend**: ⚙️ in progress.
- ✅ Monorepo restructure (`apps/mobile`, `apps/api`, `packages/shared`) met pnpm workspaces. `.npmrc` heeft `node-linker=hoisted` voor RN+Metro compat.
- ✅ Neon Postgres (Frankfurt, `andreas_x`) + Drizzle schema voor 9 tabellen (users · friendships · venues · events · saves · venue_follows · session · account · verification). Migration `0000_misty_swarm.sql` is applied.
- ✅ Hono API draait op `:8787` met `/health`. better-auth + phone-OTP plugin geconfigureerd (sendOTP via MessageBird; in dev zonder access key worden codes naar console gelogd).
- ✅ Bunny.net storage zone `andreas-x` + pull zone `https://andreas-x.b-cdn.net` aangemaakt (Force SSL aan).
- ⬜ **Volgende slice**: seed-script + `GET /events` + mobile api-client (zie hieronder).
- ⬜ TanStack Query setup in mobile, Avond-tab live op `/events`.
- ⬜ Phone-OTP login UI in mobile + better-auth client wiring.
- ⬜ Resterende API-routes (`/venues`, `/saves`, `/friends`, `/invites`).
- ⬜ EAS build + TestFlight.

---

## Volgende slice (in werk)

1. **Seed-script** — `apps/api/src/db/seed.ts` met 4-5 echte Amsterdamse venues (OCCII, Paradiso, Perdu, EYE, Frascati) en ~10 events. Idempotent (delete-first, dan insert). Run: `pnpm --filter @andreas/api seed`.
2. **`GET /events`** — Hono route, joint events met venues, gesorteerd op `starts_at` ascending, default limit 50. Ook `GET /events/:id` voor detail.
3. **Mobile api-client** — `apps/mobile/lib/api.ts` met `EXPO_PUBLIC_API_URL` (default `http://localhost:8787`). Helpers `getEvents()` en `getEvent(id)` voor straks.

Verwachte test: `curl http://localhost:8787/events` retourneert JSON-array.

---

## Te fixen na deze slice (technical debt)

- **`apps/mobile/store/saved.ts`** slaat nu snapshots op zodat saves van detail naar Gered kunnen renderen ondanks dat detail.tsx altijd dezelfde per-mode mock toont. Zodra detail echt per-id data fetcht, wordt dit een simpele `Set<string>` van event-ids en lookup via TanStack Query.
- **`apps/mobile/app/event/[id].tsx`** gebruikt nu `DETAIL[mode]` ongeacht de route-id. Moet worden vervangen door `useEvent(id)` zodra de API-route er is.
- **Avond/Agenda/Gered/Kaart** halen nog uit `mocks/`. Migreren één voor één naar `useQuery`.
- **`MESSAGEBIRD_ACCESS_KEY`** in `apps/api/.env` is leeg — OTP-codes loggen nu naar console. Aanmaken zodra phone-OTP UI live moet.
- **Connection string + Bunny key** zijn in chat-history beland tijdens setup. Rotaten voor go-live (Neon → Reset password, Bunny → Reset FTP password). Niet kritisch voor V1-development.
- **`packages/shared`** heeft alleen base types. Zodra DB-routes draaien, hier de response-shapes definiëren zodat client en server gegarandeerd in sync zijn.
- **Drizzle Studio** (`pnpm studio`) is een handige DB-browser tijdens dev. Niet uitchecken in repo.

---

## Fase 3 — Interactie (geparkeerd tot fase 4)

Reden: deze features leunen ≥80% op data; een mock-versie is grotendeels weggegooid werk.

- [ ] **`/event/[id]/invite` — Vraag iemand mee**. Bottom-sheet met vrienden-picker + persoonlijke message. Heeft `friendships` + `users` data nodig.
- [ ] **`/add-friend` modal**. QR genereren + scannen + zoek op handle. Nieuwe deps: `expo-camera` voor scan, `react-native-qrcode-svg` voor genereren. Heeft user-handle uit DB nodig.
- [ ] **`/friend/[id]` — Vriend detail**. Wat heeft die vriend gered, gemeenschappelijke plannen. Heeft `saves` + `friendships` join nodig.
- [ ] **`/venue/[id]` — Venue detail**. Programmering van één venue. Heeft `events` waar `venue_id = ?` nodig. Layout-mock in `app.html` lines 1944-2038. Hergebruik `EventListRow`.

## Fase 4 — Backend (open na huidige slice)

- [ ] **TanStack Query in mobile**. Mock-imports vervangen door `useQuery`-hooks, één scherm tegelijk. Begin Avond → Agenda → Gered → Kaart.
- [ ] **Auth-routes wiring in mobile**. better-auth client + phone-OTP UI. Inlog-route op `/` (start-flow), gebruiker landt na succesvolle OTP op `/avond`.
- [ ] **API-routes**: `/venues` (lijst + detail), `/saves` (toggle, list mine), `/friends` (list mine, request, accept), `/invites` (send, list received).
- [ ] **Push notificaties (expo-notifications)**. "Vriend redt iets" → notificatie via API.
- [ ] **EAS build → TestFlight**. Eerst dev client met alle native deps, dan production.

---

## Niet meegenomen / opzettelijk gesloopt

Bewust geskipte features die later kunnen — agenten die hier aan willen werken vinden de info hier:

- **`expo-linear-gradient` op Avond featured card**. Nu een vlakke rgba-overlay; mooier zou een `LinearGradient` zijn die naar onder donker wordt. Dep is al geïnstalleerd, dus puur een implementatie-stapje.
- **Saffron blob rechtsonder op Avond featured in dag-mode**. Visueel detail uit de mock, geskipt voor V1.
- **Cat-tabs filter op Avond** (Vanavond / Muziek / Theater / Lit / Film). Geskipt — past pas bij echte data.
- **Filter chips + zoek op Agenda en Gered** (Alles / Met vrienden / Muziek …). Idem.
- **Sticky date-anchors op Agenda en Gered**. Day-strip is sticky in Agenda; date-anchors zelf scrollen mee.
- **Custom map-style** op de Kaart. Apple Maps default ondersteunt geen `customMapStyle`; voor donker/cream-tint moet je naar `PROVIDER_GOOGLE` (vereist Google Maps API key).
- **Bottom-sheet swipe-to-dismiss / snap-points** op Kaart. Drawer is binair (open/dicht) met manual drag — voor V1 voldoende, geen `@gorhom/bottom-sheet` toegevoegd.
- **Settings toggles + Algemeen-sectie op Jij** (notify-toggles, taal, thema). Past pas zinvol bij echte preferences-store.
- **Custom Andreas-iconen** voor heart, share-outline, locate, person-add, checkmark, chevron-back. Op dit moment leunen we op `@expo/vector-icons` (Ionicons). HANDOFF noemde `lucide-react-native` als basis met Andreas-kruis override — pas relevant als design echt afwijkt.
- **Apple Sign-In**. Niet nodig zolang we phone-only blijven (Apple's social-login eis triggert alleen bij Google/Facebook). Toevoegen wanneer we social-login willen.

---

## Werkdocumenten

- [HANDOFF.md](HANDOFF.md) — oorspronkelijke briefing van de designer. Niet aanpassen tenzij scope echt verandert.
- [app.html](app.html) — master-mockup, bron van waarheid voor copy + visual design. Lees per `phone-<naam>` blok.
- [start-screen.html](start-screen.html) — splash + welkom-flow.
