# Andreas — Claude

Briefing voor elke nieuwe Claude Code-sessie in dit project. Lees dit eerst, daarna [TODO.md](TODO.md) voor de stand en [HANDOFF.md](HANDOFF.md) voor de oorspronkelijke designer-briefing.

## Wat is Andreas

Een anti-algoritme uitgaansapp voor Amsterdam. Geen oneindige feed, geen aanbevelingen op gedrag — alleen wat vrienden(-van-vrienden) hebben gered en de programmering van venues die jij volgt. Twee modi:

- **Nacht** — donker, noir/acid-geel. "Wat doe ik nu?"
- **Dag** — paperachtig, cream/karmijn. "Wat plan ik?"

Modus is een bewuste keuze van de gebruiker, geen tijd-gebaseerde toggle. De toggle zit in de app-header (de dn-switch).

## Stack

- **Expo SDK 54+** met **expo-router** (file-based routing).
- **React Native 0.81**, **TypeScript** strict.
- **NativeWind** is geïnstalleerd maar in praktijk gebruiken we vooral `StyleSheet.create({...})` met tokens uit [`andreas/theme/tokens.ts`](andreas/theme/tokens.ts).
- **Zustand** voor client state (mode-store, en straks save-store).
- **Reanimated v4** + **gesture-handler** voor de curtain-transition, drawer-drag, sticky title bar, pull-to-zoom.
- **expo-blur** + **expo-linear-gradient** + **@react-native-masked-view/masked-view** voor de gradient-blur header en map-toolbar.
- **react-native-maps** (Apple Maps default).
- **@expo/vector-icons** (Ionicons) voor system-iconen; **`components/Cross.tsx`** voor het brand-kruis.

Native deps werken in **Expo Go** — geen dev client nodig totdat we een native module gebruiken die niet in Expo Go zit.

## Bestanden waar je vaak zult komen

| Pad | Wat |
|---|---|
| [`andreas/app/_layout.tsx`](andreas/app/_layout.tsx) | Root Stack — mount `<ModeCurtain />`, `<GestureHandlerRootView>` als wrapper, fonts laden. |
| [`andreas/app/(tabs)/_layout.tsx`](andreas/app/(tabs)/_layout.tsx) | Tabs met custom `<TabBar />`. |
| [`andreas/app/(tabs)/{avond,agenda,kaart,gered,jij}.tsx`](andreas/app/(tabs)/) | De vijf hoofdschermen. |
| [`andreas/app/event/[id].tsx`](andreas/app/event/[id].tsx) | Event-detail met parallax hero + sticky title + pull-to-zoom + CTA-dock. |
| [`andreas/components/AppHeader.tsx`](andreas/components/AppHeader.tsx) | Floating header (logo + dn-switch) met blur fade-out. Accepteert `children` voor secundaire rij. |
| [`andreas/components/EventListRow.tsx`](andreas/components/EventListRow.tsx) | Gedeelde row voor Avond/Agenda/Gered. Time + duration / thumb / title + venue + tags + friends-pill / accent tick. Optionele props zorgen dat dezelfde component drie schermen dient. |
| [`andreas/components/TabBar.tsx`](andreas/components/TabBar.tsx) | Custom 5-tab pill aan de onderkant met BlurView. Emit `tabPress` op elke klik (ook re-tap) — schermen kunnen luisteren via `navigation.addListener('tabPress')`. |
| [`andreas/components/ModeCurtain.tsx`](andreas/components/ModeCurtain.tsx) | Horizontale curtain-sweep + `useModeSwitch()` hook. |
| [`andreas/components/Cross.tsx`](andreas/components/Cross.tsx) | View-based Andreas-kruis (twee gedraaide rechthoeken). Gebruikt op de splash, de curtain, op markers. |
| [`andreas/store/mode.ts`](andreas/store/mode.ts) | Zustand store + `useMode()`, `useRoles()`, `useHasOnboarded()`. |
| [`andreas/theme/tokens.ts`](andreas/theme/tokens.ts) | Palette + roles per mode + radii + motion + fontFamily. |
| [`andreas/mocks/`](andreas/mocks/) | Per scherm een mock-bestand. Real data komt in fase 4 — types blijven 1-op-1 bruikbaar als API shapes. |

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
"Roos & Milan gaan ook" / "Roos +2 ook" — gestapelde 18px avatars + label in tone-color. Patroon zit in `EventListRow.tsx` (helper `friendsLabel`). Optioneel veld in alle list-mocks (`feed.ts`, `agenda.ts`, `gered.ts`, `kaart.ts`).

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
