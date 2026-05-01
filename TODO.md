# Andreas — TODO

Live status van het project. Cross-checken met `HANDOFF.md` voor de oorspronkelijke briefing en met de huidige codebase voor de waarheid. Per open punt staat genoeg context om een agent zelfstandig te laten werken.

Laatste sync: 2026-05-01 · branch `main` op commit `870a2ad`.

## Stand

**Fase 1 — Fundament**: ✅ klaar. Expo + expo-router + NativeWind + fonts, design tokens in [`andreas/theme/tokens.ts`](andreas/theme/tokens.ts), Zustand mode-store met curtain-transition (`components/ModeCurtain.tsx`), custom tabbar met 5 tabs + placeholder schermen.

**Fase 2 — Statische schermen**: ✅ klaar voor de zes hoofdroutes (Avond / Detail / Agenda / Gered / Jij / Kaart). Alle data komt uit `mocks/*.ts`. Mode-driven: nacht en dag hebben elk hun eigen content-set.

**Fase 3 — Interactie**: ⬜ nog niet aangevangen. Zie open punten hieronder.

**Fase 4 — Backend**: ⬜ nog niet aangevangen.

---

## Gedeelde primitives

Worden hergebruikt over de schermen heen. Bij refactor-werk: pas de gedeelde component aan in plaats van per-scherm te dupliceren.

- [`components/AppHeader.tsx`](andreas/components/AppHeader.tsx) — floating Andreas-wordmark + dn-switch met blur fade-out. Accepteert `children` om een sticky tweede regel te tonen (Agenda day-strip, Gered segmented, Kaart toolbar).
- [`components/EventListRow.tsx`](andreas/components/EventListRow.tsx) — uniforme row voor Avond, Agenda, Gered: thumb 64×64 of 76×76 (varieert per scherm), title/venue/tags inline, optionele `friends`-pill, accent tick rechts.
- [`components/ModeCurtain.tsx`](andreas/components/ModeCurtain.tsx) — horizontale curtain-sweep + `useModeSwitch()` hook voor mode-toggle.
- [`components/Cross.tsx`](andreas/components/Cross.tsx) — Andreas-kruis als view-based icoon (geen SVG dep nodig).
- [`components/icons/TabIcons.tsx`](andreas/components/icons/TabIcons.tsx) — vijf tab-iconen, view-based.

## Bekende valkuilen (lees voor je begint)

- **`Pressable` met function-style `({ pressed }) => [...]`** breekt regelmatig de rendering op kleine cirkelvormige buttons (border verdwijnt, kinderen renderen niet, layout valt om). Default naar direct `style={[...]}`. Gebruik `onPressIn`/`onPressOut` met state of `TouchableOpacity` als je pressed-state nodig hebt. Geraakt in Jij twin-buttons en Kaart sheet rows.
- **react-native-gesture-handler** vereist `GestureHandlerRootView` als root in [`app/_layout.tsx`](andreas/app/_layout.tsx). Staat er al — maak deze niet kapot.
- **Expo Go** ondersteunt de huidige native deps (maps, blur, masked-view, gesture-handler). Voor toekomstige native modules eerst checken of ze in Expo Go zitten, anders eerst een dev client builden.
- **Custom tabbar emit `tabPress` op elke klik** — schermen kunnen luisteren met `navigation.addListener('tabPress')` voor "re-tap"-gedrag (zie Kaart recentre, Avond/Agenda/Gered useScrollToTop).

---

## Fase 3 — Interactie (open)

### Save-flow
- [ ] **Hart-tap op Detail/Avond → Gered**. Tikken op het hart in de circle-buttons-rij van [`app/event/[id].tsx`](andreas/app/event/[id].tsx) moet visueel een "save"-pop geven (scale + haptic) en de save persistent vasthouden zodat het event in de Gered-tab verschijnt. HANDOFF zegt: layout-anim die naar de Gered-tab vliegt.
  - Voor de state: nieuwe Zustand-store `useSavedStore` met `Set<string>` van event-ids, `toggle(id)`, optionele MMKV-persist.
  - Voor de animatie: Reanimated `withSequence(scale 1.3 → 1)` + `expo-haptics` `impactAsync(Light)`.
  - Gered haalt nu uit `mocks/gered.ts`. Optie: `up`-lijst combineren met de saved-store ids om een echte "wat-heb-ik-opgeslagen" view te krijgen.

### Modals
- [ ] **`/event/[id]/invite` — Vraag iemand mee**. Bottom-sheet met vrienden-picker en een tekstveld voor een persoonlijke message. HANDOFF tabel rij 10. Patroon: zelfde modal-flow als `welkom` route (`presentation: 'modal'` in `app/_layout.tsx`'s Stack).
- [ ] **`/add-friend` modal**. QR-code genereren, QR scannen (camera), zoekveld voor handle. Nieuwe deps nodig: `expo-camera` voor scan, `react-native-qrcode-svg` (of vergelijkbaar) voor genereren. Zie `JIJ_REQUESTS` mock in [`mocks/jij.ts`](andreas/mocks/jij.ts) voor het inkomende-verzoeken patroon.

### Detail-schermen voor relations
- [ ] **`/friend/[id]` — Vriend detail**. Wat heeft die vriend gered, gemeenschappelijke plannen. Mock kan via een aparte `mocks/friends-detail.ts` of door uitbreiding van `JIJ_FRIENDS`. Layout-inspiratie: detail-scherm patroon uit [`app/event/[id].tsx`](andreas/app/event/[id].tsx) (parallax hero + sticky title + body sections), maar dan zonder reserveer-CTA.
- [ ] **`/venue/[id]` — Venue detail**. Programmering van één venue. HANDOFF tabel rij 07. Mock in `app.html` lines 1944-2038 toont structuur: detail-hero met venue-naam + tag, address-block, "Route openen" / "Opslaan" actions, beschrijving, programma-lijst per zaal. Reuse `EventListRow` voor de programma-rijen.

### Mode-curtain afronding
- [ ] **dn-switch op Jij óók aanwezig naast in de header**. HANDOFF noemt "mode-toggle prominent op Jij" expliciet. Nu zit hij alleen in `AppHeader`. Beslissing nodig: dubbel maken of alleen header-versie houden? Vraag eerst de user.

---

## Fase 4 — Backend (open)

Volgorde uit HANDOFF sectie 9, fase 4:

- [ ] **Neon + Drizzle schema + migrations**. Tables: `users`, `friendships`, `venues`, `events`, `saves`, `invites`. Zie HANDOFF sectie 2 voor stack-keuze.
- [ ] **API server (Hono of tRPC) op Vercel/Cloudflare/Railway**. Praat met Neon via `@neondatabase/serverless` + Drizzle.
- [ ] **Auth (Clerk of better-auth)**. JWT door naar API. HANDOFF zegt Clerk = simpelst, better-auth = open-source en dichter bij eigen Postgres.
- [ ] **TanStack Query in app**. Mock-imports vervangen door `useQuery`-hooks, één scherm tegelijk. Begin met Avond (`mocks/feed.ts`), dan Agenda, etc. De huidige mock-types blijven 1-op-1 bruikbaar als API response shapes.
- [ ] **Push notificaties (expo-notifications)**. "Vriend redt iets" → notificatie via API.
- [ ] **EAS build → TestFlight**. Eerst dev client met alle native deps, dan production builds.

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

---

## Werkdocumenten

- [HANDOFF.md](HANDOFF.md) — oorspronkelijke briefing van de designer. Niet aanpassen tenzij scope echt verandert.
- [andreas/app.html](andreas/app.html) — master-mockup, bron van waarheid voor copy + visual design. Lees per `phone-<naam>` blok.
- [andreas/start-screen.html](andreas/start-screen.html) — splash + welkom-flow.
