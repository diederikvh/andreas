# Andreas — Handoff naar Claude Code

> Briefing om van de hi-fi designs in dit project een werkende **Expo + React Native** app te bouwen.
> Lees dit eerst, daarna de bestanden in dit project (zie sectie 8).

---

## 1. Wat is Andreas?

Een **anti-algoritme uitgaansapp** voor Amsterdam. Geen feed met oneindig scrollen, geen aanbevelingen op basis van je gedrag. Alleen plannen die *vrienden van vrienden* hebben gered, plus de programmering van venues die jij volgt. Twee modi:

- **Nacht** — donker (noir/acid-geel). Voor 's avonds, "wat doe ik nu?"
- **Dag** — paperachtig (cream/karmijn). Voor overdag, "wat plan ik?"

De gebruiker switcht tussen modi via een hardwareknop-achtige toggle. Niet automatisch op tijd — bewuste keuze.

Kerngebruiker: 25–40, Amsterdam, kent de stad, wil minder scrollen en meer doen. Niet voor toeristen.

---

## 2. Tech-stack aanbeveling

### Core
- **Expo SDK 51+** met **expo-router** (file-based routing, deep linking, web build voor preview)
- **React Native 0.74+**
- **TypeScript** strict mode
- **EAS Build** voor TestFlight/Play

### Design system / UI
- **NativeWind v4** (Tailwind voor RN) — voor utility styling die 1-op-1 vertaalt vanuit de HTML mocks. Werkt met design tokens via CSS vars.
- **react-native-reanimated v3** — voor de curtain transition tussen nacht/dag, sheets, en alle micro-interactions
- **react-native-gesture-handler** — voor bottom sheets, swipe-to-save, kaart-pan
- **expo-haptics** — voor de "rood" save-tap, mode switch, en confirmaties
- **@shopify/flash-list** — agenda en evenementenlijsten (lange lijsten, performant)

> **Niet aanbevolen**: Tamagui, Gluestack, NativeBase, React Native Paper. De app heeft een zeer eigen visuele taal (anti-Material, anti-iOS-default). Een opinionated UI-kit gaat in de weg zitten. NativeWind + custom componenten = volledige controle, weinig overhead.

### Maps & locatie
- **react-native-maps** met custom map style (zwart/cream achtergrond past bij modi)
- **expo-location** voor "in de buurt"-functionaliteit op Kaart-scherm

### Data & state
- **Zustand** voor client state (mode, gerede plannen, vriendenlijst lokaal)
- **TanStack Query** voor server state (venues, evenementen, vrienden-feed)
- **expo-secure-store** voor auth tokens
- **MMKV** voor lokale persistentie van de "Gered"-lijst (offline-first; je moet je geredde plannen ook zonder internet kunnen zien)

### Backend
- **Neon** (neon.tech) — serverless Postgres met branching. Database laag.
- **Drizzle ORM** — TypeScript-first ORM, werkt fijn met Neon's HTTP/serverless driver (`@neondatabase/serverless`). Schema in code, type-safe queries, makkelijke migrations.
- **API laag**: dunne **Hono** of **tRPC** server (op Vercel/Cloudflare/Railway), die met Drizzle praat. Niet vanuit de RN app rechtstreeks naar Neon — altijd via een eigen API.
- **Auth**: **Clerk** of **better-auth**. Clerk is simpelst (e-mail magic link, social, JWT), better-auth is open-source en ligt dichter bij je eigen Postgres. Beide schrijven naar Neon.
- **Realtime** (vriend redt iets → notificatie): begin zonder. Pollen op tab-focus is genoeg voor V1. Later: Pusher Channels of een eigen WS via Cloudflare Durable Objects.

### Fonts
- **Archivo** (900/800/700/500/400) — display + body
- **JetBrains Mono** (400/500) — kickers, meta, micro-caps

Beide via `expo-font` of `@expo-google-fonts/archivo` + `@expo-google-fonts/jetbrains-mono`.

---

## 3. Design tokens

Volledig gedefinieerd in **`tokens.css`**. Vertaal naar TypeScript:

```ts
// theme/tokens.ts
export const palette = {
  // Nacht
  noir:     '#0a0a0b',
  noir2:    '#17171a',
  noir3:    '#1f1f23',
  ink:      '#f2f2ef',
  inkMuted: '#9a9a94',

  // Dag
  paper:     '#d9d1bf',
  paper2:    '#ebe6d8',
  paper3:    '#f5f1e8',
  soil:      '#1a1410',
  soilMuted: '#5a4e3f',

  // Brand accents
  acid:    '#d4ff3a',  // nacht-only
  flare:   '#ff4d2e',  // nacht-only
  plum:    '#c441ff',
  azure:   '#4d7cff',
  red:     '#c9453a',  // dag primary
  forest:  '#2d4a3e',
  cobalt:  '#2b4b9c',
  saffron: '#e89b2e',
};

export const radii = { xs:4, s:8, m:12, l:18, pill:999, phone:46 };
export const motion = {
  ease: 'cubic-bezier(.65,0,.35,1)',
  fast: 220,
  base: 400,
  curtain: 900,
};
```

**Kleurregel**: acid en flare verschijnen NOOIT in dag-mode. Karmijn (red) en forest verschijnen NOOIT in nacht-mode. Plum/azure/cobalt/saffron zijn neutraal en mogen in beide.

Configureer NativeWind met deze tokens als utilities (`bg-noir`, `text-ink`, `bg-acid`, etc.) plus een `mode-nacht` / `mode-dag` class op de root view (zie sectie 4).

---

## 4. Mode systeem (kritiek)

De app heeft **twee modes** — niet "dark mode" in de iOS-zin, maar twee karakters van dezelfde app.

### Implementatie
```tsx
// store/mode.ts (Zustand)
type Mode = 'nacht' | 'dag';
const useMode = create<{mode: Mode; toggle: () => void}>((set) => ({
  mode: 'nacht',
  toggle: () => set((s) => ({ mode: s.mode === 'nacht' ? 'dag' : 'nacht' })),
}));
```

### Curtain transition
Wanneer de gebruiker switcht: een verticaal "gordijn" van de NIEUWE mode-kleur veegt over het scherm in 900ms (`--dur-curtain`). Inhoud onder het gordijn wordt al omgewisseld. Zie de switch-animatie in `index.html` / `app.html` voor referentie. Gebruik **Reanimated** met een full-screen `Animated.View` die van top → bottom transleert.

```tsx
// Pseudo
const offset = useSharedValue(-1); // -1 = bovenaan buiten beeld, 0 = vol, 1 = onderaan buiten
// op toggle: offset.value = withTiming(0, { duration: 450 }, () => {
//   setMode(newMode);
//   offset.value = withTiming(1, { duration: 450 });
// });
```

### Toggle UI
Hardwareknop-achtige cilinder bovenin of in profiel-scherm. Niet zomaar een switch — het is een betekenisvolle keuze. Zie `switch-ideas.html` voor varianten.

---

## 5. Schermen / routes

10 schermen ontworpen, te zien in `app.html`. Mapping naar expo-router:

| # | Scherm | Route | Component (id in app.html) | Doel |
|---|---|---|---|---|
| 01 | Feed (Avond) | `/(tabs)/index` | `phone-feed` | Wat is er nu — featured + lijst kleine zalen + foto-band |
| 02 | Detail evenement | `/event/[id]` | `phone-detail` | Datum/tijd/venue, line-up, vrienden, reserveer-CTA |
| 03 | Agenda | `/(tabs)/agenda` | `phone-agenda` | Vooruit kijken — komende plannen op datum |
| 04 | Kaart | `/(tabs)/kaart` | `phone-kaart` | Geo-view — venues + plannen om je heen |
| 05 | Gered | `/(tabs)/gered` | `phone-gered` | Wat je hebt gered — toekomstige eigen plannen |
| 06 | Jij (profiel) | `/(tabs)/jij` | `phone-jij` | Profiel, vrienden, mode-toggle, instellingen |
| 07 | Venue detail | `/venue/[id]` | `phone-venue` | Programmering van 1 venue |
| 08 | Vriend detail | `/friend/[id]` | `phone-vriend` | Wat heeft vriend X gered |
| 09 | Toevoegen | `/add-friend` (modal) | `phone-toevoegen` | QR + zoeken + inkomende verzoeken |
| 10 | Vraag iemand mee | `/event/[id]/invite` (modal) | `phone-vraag` | Vrienden-picker met persoonlijke message |

### Tabbar
**5 tabs**: Avond / Agenda / Kaart / Gered / Jij. Custom tabbar (zie `logo-tabbar.html`) — niet de default expo-router tabbar. Karakter: dunne lijn-iconen (stroke 3.6, géén rounded caps), labels in mono.

### Modals
Bottom-sheet stijl voor `add-friend`, `invite`, en de filter/sheet op Kaart. Gebruik `@gorhom/bottom-sheet` of een custom Reanimated implementatie.

---

## 6. Componenten-inventaris

Te extraheren uit `app.html`. Bouw ze als losse RN componenten in `components/`:

### Atomen
- `<Kicker>` — mono uppercase metalabel (bv. "— Avondkeuze")
- `<Pill>` — chip, accent of neutraal, met optionele icon
- `<MetaRow>` — datum / tijd / venue / prijs als compacte regel
- `<Avatar>` met `<AvatarStack>` — circel met overlap voor "vrienden gaan ook"
- `<Icon>` — custom set met stroke 3.6, GEEN ronde caps. Gebruik **lucide-react-native** met `strokeWidth={3.6}` en `strokeLinecap="butt"` als basis, maar overschrijf de kruis/plus/x naar het Andreas-kruis (zie design-system.html).
- `<DotDivider>` — middendot voor meta-strings

### Cellen
- `<EventCard>` — feed-item, met photo, title, kicker, meta. Variant: `featured` (groot, kleurblok), `compact` (lijst-rij), `photo-card` (kleine foto in band)
- `<AgendaRow>` — datum-link in agenda, met side-rail kleur per categorie
- `<MapPin>` — kleur per venue-categorie, met getallen-label
- `<FriendRow>` — avatar + naam + handle + actie
- `<VenueCard>` — venue tegel met categorie-tag

### Schermdelen
- `<HeroBlock>` — Feed-bovenkant met groot kicker + display title (bv. "47 dingen die nu tellen")
- `<SectionTitle>` — "Kleine zalen — 6 evenementen" header met links/rechts
- `<DetailHero>` — full-bleed photo + tag + h2 op detail-scherm
- `<CtaDock>` — vaste onderbalk met prijs + reserveer-knop
- `<AgendaHeader>` — datumkop met sub-meta
- `<KaartSheet>` — bottom-sheet met "in de buurt"-lijst over de kaart
- `<TabBar>` — custom 5-tab bottom bar met Andreas-iconen

### Patronen
- **Photo-band** — horizontale strip van foto-cards (3:4 ratio), in detail- en feed-schermen
- **Meta-row** — drie cellen (Datum / Aanvang / Venue / Prijs) als grid met labels in mono boven values
- **Lineup** — verticale rijen met `b` (artiest) en `span` (tijd), 6px gap
- **Vrienden gaan ook** — avatar-stack + tekst + "Vraag iemand anders mee" secundair

---

## 7. Interacties & micro-details

Niet weglaten — dit is wat de app karakter geeft:

1. **Save (red) animatie** — tap op hart → schaal-pop + haptic + de save vliegt naar de Gered-tab (Reanimated layout-anim of `withSequence`)
2. **Mode-curtain** — 900ms verticale veeg bij mode-switch (zie sectie 4)
3. **Tabbar-icon switch** — actieve tab heeft kleur-fill (acid in nacht, karmijn in dag), niet alleen opacity
4. **Pull-to-refresh** — custom met mono-tekst "Vernieuw" → "Loslaten" → "Bezig" (geen iOS-default spinner)
5. **Inline copy-edit** — niet meenemen, was alleen voor de mock
6. **Bottom sheets** — snap points, swipe-to-dismiss, met handle bovenaan
7. **Status bar** — light-content in nacht, dark-content in dag (`expo-status-bar`)
8. **Geen splash slop** — splash is gewoon een vol scherm met het logo gecentreerd, mode = laatst gekozen

---

## 8. Bronnen in dit project

| Bestand | Wat erin staat |
|---|---|
| `app.html` | **Master mockup** met alle 10 schermen naast elkaar in een design-canvas. Lees de classes en structuur per `phone-<naam>` blok. |
| `tokens.css` | **Design tokens** — kleur, radii, motion, fonts. Bron van waarheid. |
| `design-system.html` | **Component-overzicht** — pills, iconen, kaarten, type. |
| `index.html` | Eerste verkenningsscherm — context + visuele DNA. |
| `dag.html` | Dag-mode hero scherm losstaand. |
| `nacht.html` | Nacht-mode hero scherm losstaand. |
| `switch-ideas.html` | Varianten voor de mode-toggle. |
| `logo-tabbar.html` | Custom tabbar + logo verkenningen. |

---

## 9. Build-volgorde (aanbevolen)

### Fase 1 — Fundament (week 1)
1. Expo project opzetten met expo-router, NativeWind, fonts (Archivo + JetBrains Mono)
2. Design tokens naar `theme/tokens.ts` + Tailwind config
3. Mode-store (Zustand) + curtain-transition component
4. Custom tabbar met de 5 tabs (placeholder schermen)
5. Atomen: Kicker, Pill, MetaRow, Avatar, Icon, DotDivider

### Fase 2 — Statische schermen (week 2)
6. Feed-scherm (mock data) — HeroBlock, featured EventCard, lijst, photo-band
7. Detail-scherm (mock data) — DetailHero, meta-row, lineup, vrienden, CTA-dock
8. Agenda-scherm (mock data)
9. Kaart-scherm met react-native-maps + custom style + sheet
10. Gered-scherm met persistente lijst (MMKV)
11. Jij-scherm met mode-toggle prominent + vriendenlijst

### Fase 3 — Interactie (week 3)
12. Save-flow (hart-animatie + naar Gered)
13. Detail → Vraag-iemand-mee modal
14. Toevoegen modal (QR genereren + scannen, search)
15. Vriend-detail
16. Venue-detail
17. Mode-curtain transition definitief

### Fase 4 — Backend (week 4+)
18. Neon project + Drizzle schema (users, friendships, venues, events, saves, invites) + migrations
19. API server (Hono of tRPC) gedeployed, met Drizzle queries
20. Auth (Clerk of better-auth) — JWT door naar API
21. Push (expo-notifications) — nieuwe save van een vriend triggert notificatie via API
22. EAS build → TestFlight

---

## 10. Wat NIET overnemen uit de mocks

- De copy-swap functionaliteit (`.swap` / `data-copy`) — was alleen voor design-iteratie
- De inline-edit features in de design-canvas
- De multi-screen naast elkaar layout — in de echte app is het één scherm tegelijk
- Hardcoded namen (Lewsberg, OCCII, etc.) — gebruik echte data uit Supabase

---

## 11. Open vragen voor mij (de designer)

Stel deze aan de designer voordat je begint:

1. Reserveer-flow gaat naar externe ticketing (link uit) of in-app? Mock toont "Reserveer" maar niet wat erna komt. (Suggestie: V1 = externe link, want eigen ticketing is een bedrijf op zich.)
2. Hoe komt content in het systeem? Scrapen van venue-sites, of handmatig curated, of venues hebben eigen login? (Voor V1 lijkt curated het simpelst — admin-route in de API, één Notion-achtige interface.)
3. Push-notificaties: alleen voor vriendenactiviteit of ook voor venue-programma?
4. Onboarding bestaat nog niet als design — splash → mode-keuze → 3 vrienden toevoegen → klaar?
5. Empty states (geen vrienden, geen plannen vandaag) — nog te ontwerpen.

---

## 12. Claude Code prompt suggestie

Plak dit als startprompt:

> Lees `HANDOFF.md` en daarna `app.html` (de master mockup) en `tokens.css` (design tokens) volledig. Dit is de design-bron voor een Expo + React Native app. Begin met fase 1 uit het build-plan: project setup, tokens, mode-store, custom tabbar, en de 5 atoom-componenten. Daarnaast bouw je het start/splash-scherm uit `start-screen.html` als eerste scherm dat de gebruiker ziet. Lever het op in kleine PR-achtige commits per onderdeel zodat ik kan reviewen. Gebruik TypeScript strict, NativeWind v4, en Reanimated v3. Database = Neon + Drizzle ORM, geen Supabase. Geen UI-library zoals Tamagui of Gluestack — de visuele taal is te eigen.

---

*Vragen, scope-uitbreidingen, of als de schermen veranderen: update `app.html` en `tokens.css`, niet dit doc — laat Claude Code het verschil oppakken.*
