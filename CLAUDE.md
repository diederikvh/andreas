# Andreas — Claude

Briefing voor elke nieuwe Claude Code-sessie in dit project. Lees dit eerst, daarna [TODO.md](TODO.md) voor de stand en [HANDOFF.md](HANDOFF.md) voor de oorspronkelijke designer-briefing.

## Wat is Andreas

Een uitgaansapp voor Amsterdam die leert wat jij leuk vindt en helpt om dat sneller te vinden. Vrienden, gevolgde venues en je eigen saves zijn de input; persoonlijke spiegel en relevante voorstellen zijn de output. Twee modi:

- **Nacht** — donker, noir/acid-geel. "Wat doe ik nu?"
- **Dag** — paperachtig, cream/karmijn. "Wat plan ik?"

Modus is een bewuste keuze van de gebruiker, geen tijd-gebaseerde toggle. De toggle zit in de app-header (de dn-switch).

> **Eerdere positionering**: Andreas is opgezet als "anti-algoritme" (geen feed, geen aanbevelingen op gedrag). Diederik heeft die positie expliciet losgelaten (mei 2026). Personalisatie, profiling en aanbevelingen zijn nu actief in scope, mits ze "goed worden ingezet" — transparant, gebruikersvriendelijk, niet engagement-maximizing tot het walgelijk wordt. Letterboxd / Spotify Wrapped / Strava year-in-sport zijn de referenties, niet TikTok For You.

## Repo-structuur

Monorepo met **pnpm workspaces**:

- [`apps/mobile/`](apps/mobile/) — de Expo-app (was voorheen `andreas/`)
- [`apps/api/`](apps/api/) — Hono + Drizzle backend (Neon Postgres in Frankfurt)
- [`packages/shared/`](packages/shared/) — gedeelde TS-types tussen mobile en api

Root `package.json` heeft scripts: `pnpm dev:mobile`, `pnpm dev:api`, `pnpm db:generate`, `pnpm db:migrate`.

## Stack

### Mobile (`apps/mobile`)
- **Expo SDK 54+** met **expo-router** (file-based routing).
- **React Native 0.81**, **TypeScript** strict.
- **NativeWind** is geïnstalleerd maar in praktijk gebruiken we vooral `StyleSheet.create({...})` met tokens uit [`apps/mobile/theme/tokens.ts`](apps/mobile/theme/tokens.ts).
- **Zustand** voor client state (mode-store, en straks save-store).
- **Reanimated v4** + **gesture-handler** voor de curtain-transition, drawer-drag, sticky title bar, pull-to-zoom.
- **expo-blur** + **expo-linear-gradient** + **@react-native-masked-view/masked-view** voor de gradient-blur header en map-toolbar.
- **react-native-maps** (Apple Maps default).
- **@expo/vector-icons** (Ionicons) voor system-iconen; **`components/Cross.tsx`** voor het brand-kruis.

**Expo Go werkt niet meer** — `kaart.tsx` importeert `@maplibre/maplibre-react-native`, en die native module zit niet in Expo Go (`MLRNCameraModule could not be found`, faalt bij het registreren van de route dus de héle app blijft zwart). Draai een dev build:

```
npx expo run:ios --device <udid>
```

Let op: `expo-dev-client` zit **niet** in de deps, dus de build heeft geen dev-launcher en zoekt Metro altijd op poort **8081** — `--port 8082` wordt genegeerd en je krijgt "No script URL provided". Zorg dat 8081 vrij is.

### Backend (`apps/api`)
- **Hono** op Node (start lokaal op `:8787`).
- **Drizzle ORM** + **Neon Postgres** (Frankfurt). Schema in [`apps/api/src/db/schema.ts`](apps/api/src/db/schema.ts).
- **better-auth** met de phone-number plugin voor OTP-login (geen wachtwoord).
- **MessageBird** (HQ Amsterdam) als SMS-provider voor OTPs. In dev zonder `MESSAGEBIRD_ACCESS_KEY` worden codes naar de console gelogd.
- **Bunny.net** (Slovenië, EU CDN) voor image storage + transformatie. Storage zone `andreas-x`, pull zone `https://andreas-x.b-cdn.net`.
- Auth-stack draait volledig **EU-self-hosted**; geen Amerikaanse SaaS in het auth-pad.

## Bestanden waar je vaak zult komen

| Pad | Wat |
|---|---|
| [`apps/mobile/app/_layout.tsx`](apps/mobile/app/_layout.tsx) | Root Stack — mount `<ModeCurtain />`, `<GestureHandlerRootView>` als wrapper, fonts laden. |
| [`apps/mobile/app/(tabs)/_layout.tsx`](apps/mobile/app/(tabs)/_layout.tsx) | Tabs met custom `<TabBar />`. |
| [`apps/mobile/app/(tabs)/{avond,agenda,kaart,gered,jij}.tsx`](apps/mobile/app/(tabs)/) | De vijf hoofdschermen. |
| [`apps/mobile/app/event/[id].tsx`](apps/mobile/app/event/[id].tsx) | Event-detail met parallax hero + sticky title + pull-to-zoom + CTA-dock. |
| [`apps/mobile/components/AppHeader.tsx`](apps/mobile/components/AppHeader.tsx) | Floating header (logo + dn-switch) met blur fade-out. Accepteert `children` voor secundaire rij. |
| [`apps/mobile/components/EventListRow.tsx`](apps/mobile/components/EventListRow.tsx) | Gedeelde row voor Avond/Agenda/Gered. Time + duration / thumb / title + venue + tags + friends-pill / accent tick. Optionele props zorgen dat dezelfde component drie schermen dient. |
| [`apps/mobile/components/TabBar.tsx`](apps/mobile/components/TabBar.tsx) | Custom 5-tab pill aan de onderkant met BlurView. Emit `tabPress` op elke klik (ook re-tap) — schermen kunnen luisteren via `navigation.addListener('tabPress')`. |
| [`apps/mobile/components/ModeCurtain.tsx`](apps/mobile/components/ModeCurtain.tsx) | Horizontale curtain-sweep + `useModeSwitch()` hook. |
| [`apps/mobile/components/Cross.tsx`](apps/mobile/components/Cross.tsx) | View-based Andreas-kruis (twee gedraaide rechthoeken). Gebruikt op de splash, de curtain, op markers. |
| [`apps/mobile/store/mode.ts`](apps/mobile/store/mode.ts) | Zustand store + `useMode()`, `useRoles()`, `useHasOnboarded()`. |
| [`apps/mobile/theme/tokens.ts`](apps/mobile/theme/tokens.ts) | Palette + roles per mode + radii + motion + fontFamily. |
| [`apps/mobile/mocks/`](apps/mobile/mocks/) | Per scherm een mock-bestand. Real data komt in fase 4 — types blijven 1-op-1 bruikbaar als API shapes. |

## Conventies

### Mode-systeem
Lees nooit `mode === 'nacht'` direct voor een kleur — gebruik `useRoles()` waardoor de role-tokens automatisch vertalen. Hardcode hex-waarden alleen voor randgevallen (rgba met alpha bv).

```ts
const roles = useRoles();
<Text style={{ color: roles.fg }}>...</Text>
<View style={{ backgroundColor: roles.accent }}>...</View>
```

Voor nacht-vs-dag conditional waarden die je niet via tokens kan dekken (bv. een per-mode override van een tone): `const mode = useMode(); const x = mode === 'nacht' ? a : b;`.

### Layout
- Standaard horizontal padding: **22** voor secties die rij-gebaseerd zijn (Agenda, Gered, Kaart sheet rows). **18** voor de AppHeader interne row + Avond hero. Hou de keuze consistent binnen één scherm.
- Schermen pinnen `<AppHeader />` als laatste child boven de scroll content. ScrollView krijgt `paddingTop: insets.top + HEADER_HEIGHT (+ children-height)` zodat content er onder doorloopt met de blur fade-out.
- Tabbar is `position: 'absolute'`, content scrollt eronder door dankzij `paddingBottom: insets.bottom + 96` op de scroll content.

### Pressable function-style — niet doen
**`<Pressable style={({ pressed }) => [...]}>`** breekt regelmatig de rendering op kleine cirkelvormige buttons (border verdwijnt, kinderen renderen niet, layout valt om). Default naar **direct array**:

```tsx
<Pressable style={[styles.btn, { borderColor: roles.fgMuted }]}>...</Pressable>
```

Voor pressed feedback: `onPressIn`/`onPressOut` met state, of `<TouchableOpacity activeOpacity={0.6}>`. Reserve function-style alleen voor cases die het écht nodig hebben en verifieer in simulator dat het rendert.

### Mocks
Per scherm één file, met types die toekomstige API responses 1-op-1 dekken. Bij wijzigingen in een scherm: pas de types aan, vul nieuwe velden in alle items, daarna laat de UI consumeren via die types. Niet ad-hoc inlinen in de component.

### Friends-pill
"Roos" / "Roos & Milan" / "Roos +2" — gestapelde 18px avatars + label in tone-color. Geen "ook"/"too"-suffix: een save is een interesse-signaal, geen belofte-om-te-gaan. Patroon zit in `EventListRow.tsx` (helper `friendsLabel`).

`friendsSaved` zit op **occurrence-niveau**, niet event-niveau. Filteren op `event.friendsSaved` over-includeert (5 voorstellingen tonen omdat 1 vriend de woensdag heeft gered). Gebruik `occurrence.friendsSaved` voor per-voorstelling-pills.

## Werkflow

1. **Lees [TODO.md](TODO.md)** voor de stand en open punten. Pak iets dat een duidelijk afgekaderd item is.
2. **Lees `app.html`** als je een nieuwe schermlayout maakt — dat is de visuele bron van waarheid (zoek het juiste `phone-<naam>` blok).
3. **Run `npx expo start --ios -c` als hot-reload niet pakt** — het project hot-reloadt meestal goed, maar een verse Metro-cache voorkomt mysterieuze "ik zie m'n edit niet" momenten.
4. **Verifieer in de simulator**, niet alleen typecheck. Visuele bugs (border onzichtbaar, layout vervormd) ontsnappen TypeScript altijd.
5. **Committen in lowercase scope-style**: `feat(scope): ...`, `fix(scope): ...`, `refactor(scope): ...`. Zie `git log` voor stijl.

## Voor user-feedback

De gebruiker is **diederik@wend.nl**, designer/founder. Communiceer in het Nederlands. Hij wil **kort en concreet** — geen samenvattingen achteraf, geen narratie van het denkproces. Toon resultaten, vraag terug bij ambiguïteit.

Hij **hot-reload-test elke wijziging direct in simulator** — als zijn feedback "nope" is na een fix, herstart Metro met `-c` voor je iets anders probeert. Hij vraagt soms refresh, soms herstart hij zelf via terminal.

Hij waardeert het als je **memory bijhoudt** voor terugkerende valkuilen (zoals de Pressable function-style bug) en het pas raakt zodra hij erom vraagt.

## Belangrijke "niet doen"-lijst

- **Niet `home` als route gebruiken** — die is verwijderd. Avond is `/avond` (binnen `(tabs)`-groep), `/` is de start-flow.
- **Niet de `welkom` modal openen op een ander tijdstip dan via expliciete user-actie**. Hij zit op een just-in-time route, niet meer in de onboarding.
- **Niet `react-native-svg` introduceren tenzij echt nodig** — view-based primitives (zoals `Cross.tsx`) hebben de voorkeur.
- **Niet de Andreas-X branding wijzigen** zonder vragen. De wordmark is "Andreas" in de UI, het kruis (✕) staat ernaast als logo.

## Domain-valkuilen

Dingen die we al een keer hebben gefiksd en niet meer terug willen.

### Multi-day events — span-based, niet kalenderdag
Gebruik `isMultiDay(startsAt, endsAt)` (span ≥ 24h) i.p.v. kalender-dag-vergelijking. Een 22:00 → 03:00 event passeert middernacht maar is geen multi-day — het is een single-night-event met cross-midnight overflow. `isLongRunning` (> 7d) onderscheidt doorlopende exhibitions van weekend-festivals.

### Logische dag wisselt om 06:00
Events vóór 06:00 horen bij de avond/nacht ervoor. `groupOccurrenceRowsByDay` en `todayWindow` shiften daarop — clubs die 02:00 op zaterdag nog draaien groeperen onder vrijdag. Constante: `LOGICAL_DAY_BOUNDARY_HOUR = 6` in [`eventDisplay.ts`](apps/mobile/lib/eventDisplay.ts).

### Daytime cutoff: zowel start- als eindtijd
`isDaytimeOccurrence` checkt start ≥ 06:00 ÉN start < 18:00 ÉN end < 20:00 zelfde dag. Een 16:00 → 02:00 event passeert de start-check maar valt af op de eindtijd — terecht, want primair een avond-event.

### Cmode is puur tijd-gestuurd, niet cat-gestuurd
Op Vandaag bepaalt `cmode` welke rails worden gerenderd (uit = clubs/podia/theater/film, expo = overdag + musea/galleries). Per-rij filters draaien op tijd én cat, niet op cmode. Op Agenda is cmode puur cosmetisch — alle 5 cats zijn altijd beschikbaar als filter, geen mode-gating.

### Genre-filters bestaan niet meer
Search-veld (`query`) zoekt ook in `event.genres`. Geen genre-chip-UI in filter-sheets. `activeGenres`-state is uit alle stores verwijderd; `gn`-veld op SavedSearch blijft als legacy (lege array).

## Component-valkuilen

### EventListRow padding-collision
`EventListRow` heeft eigen `paddingHorizontal: 22`. Parents die ook 22 padding hebben (bv. de body van een page) verdubbelen naar 44 → rijen worden te smal. Fix met `marginHorizontal: -22` op de lijst-container om de parent-padding te canceleren.

### AppHeader-uitlijning
AppHeader's logo-row heeft `paddingHorizontal: 18`. Sub-labels die onder de "Andreas"-wordmark moeten uitlijnen (zoals het maand-label op de Agenda day-strip) gebruiken óók `paddingHorizontal: 18`, niet de 22 die voor chip-gutters geldt.

### KeyboardAvoidingView werkt niet voor absolute kinderen
KAV `behavior='padding'` shrinkt z'n eigen contentArea via padding-bottom — dat duwt normale flex-children omhoog, maar `position: absolute` children blijven plakken aan de oude bottom. Voor sticky docks: listen direct op `Keyboard` events en zet `bottom: keyboardHeight` op de dock-View.

### `automaticallyAdjustKeyboardInsets` scrollt te weinig
Deze prop zorgt dat het focused `TextInput` zichtbaar wordt — maar niet wat eronder staat (Accept/Decline-knoppen onder een veld). Voor zulke composities: `measureInWindow` op de wrapper-View, en `scrollRef.current?.scrollTo` zodat de hele banner boven het keyboard staat.

### useMemo deps op `events` reshuffelt op elke refetch
React Query geeft bij refetch een nieuwe array-reference terug, zelfs als de content identiek is. Een `useMemo` met `events` in deps + een Fisher-Yates shuffle erin = stack-flits bij elke focus/refresh. Gebruik een stable string-key (`stackKey = 'have-' + cmode + '-' + refreshKey`) of een refresh-counter om expliciet te bepalen wanneer een memo opnieuw draait.

## Scraper-valkuilen

### HTML-entities op title-niveau
Scrapers die uit WP REST / sitemap-HTML lezen krijgen rauwe entities binnen (`&amp;`, `&#8211;`, `&#x27;`, `&nbsp;`, `&#xE9;`). Iedere scraper heeft een `decodeEntities`-helper — pas 'm toe op **álle user-facing strings**, niet alleen description. Helper moet decimal (`&#nnn;`), hex (`&#xNNN;`) én named entities (`&amp;` etc.) afhandelen.

### Multi-locale sites — check `<html lang>`
Concertgebouw exposeert dezelfde voorstelling op zowel `/concerten/<nl-slug>` als `/concerten/<en-slug>` in z'n sitemap. URL-pattern-matching pakt beide. Lees na de fetch `<html lang="...">` en skip alles dat niet met `nl` begint. Pattern zit in [`theater.ts`](apps/api/src/scrapers/theater.ts).

### Migrations: `psql` voor one-off, niet `drizzle-kit push`
`pnpm db:push` doet een schema-diff over de hele DB en vraagt interactief over álle changes (vaak ongerelateerd aan jouw migration). Voor één-kolom-toevoegingen: schrijf het SQL-bestand in `apps/api/src/db/migrations/` én voer 'm direct uit met `psql "$DATABASE_URL" -c "ALTER TABLE ..."`. Gebruik `IF NOT EXISTS` voor idempotentie.
