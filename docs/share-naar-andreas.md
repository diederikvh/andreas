# Share naar Andreas — werkplan

Bron: featurelijn "van ontdekken naar gaan" (Shazam voor events). Dit document is
de to-do lijst: één item per sessie, van boven naar beneden. Elk item is af als
het in de simulator werkt op een dev build.

## Wat er al staat (niet opnieuw bouwen)

Eerst geïnspecteerd, daarna gepland. Dit zit er al in en verandert de scope:

| Handout | Status in de repo |
|---|---|
| **Feature 7 — Mijn events** | **Bestaat al.** [`app/going.tsx`](../apps/mobile/app/going.tsx) rendert upcoming + "Geweest"; `useMySaves` (= ♡ wil ik heen) en `useMyGoing` (= ✓ ik ga) in [`lib/queries.ts`](../apps/mobile/lib/queries.ts), server-side `POST /saves` en `POST /going` met een `source`-veld. Alleen `SaveSource` uitbreiden. |
| **Feature 17 — Samen gaan** | **Grotendeels af.** `share-invites`, universal links op `andreas.amsterdam/{e,v,u}`, [`app/i/[token].tsx`](../apps/mobile/app/i/[token].tsx), `app/event/[id]/invite.tsx`. |
| **Feature 12 — signalen** | Half: `SaveSource` legt al vast waar een save vandaan komt; bekeken/going/geweest zijn er. Alleen ticket-alert als niveau mist. |
| QR/barcode uit een **stilstaande afbeelding** | Zit al in `expo-camera@17` — `CameraView.scanFromURLAsync(uri, { barcodeTypes })`. Geen nieuwe dependency nodig. |
| Lokale bestandsopslag | `expo-file-system@19` staat al in node_modules (transitief), alleen nog niet als dependency gedeclareerd. |
| Push-infra | `lib/push.ts` + `apps/api/src/routes/push.ts` draaien. Feature 9 hangt aan bestaande infra, niet aan nieuwe. |
| Camera-shell | `/add-friend` heeft al een `expo-camera`-scanner. Feature 13 hergebruikt dat scherm-patroon. |

Twee architectuur-feiten die de aanpak bepalen:

1. **`ios/` en `android/` zijn gitignored** (CNG / prebuild). Een share extension mag
   dus **nooit** met de hand in `ios/` — het moet via een config plugin in `app.json`,
   anders is hij weg bij de volgende prebuild.
2. Elke native dependency = **nieuwe native build**. Een share extension kan niet
   via OTA/expo-updates. Lokaal is dat `npx expo run:ios`; voor testers een nieuwe
   TestFlight-build.

---

## Fase 1 — Share → Andreas (de infrastructuur)

Doel: Instagram / Safari / Foto's / Mail / Files → Deel → Andreas → app opent op
een importscherm met een preview. Geen AI, geen OCR, niets naar de backend.

- [x] **1.1 — `expo-share-intent@5.1.1` geïnstalleerd en geconfigureerd.**
      Plugin-entry in [`app.json`](../apps/mobile/app.json) met activation rules voor
      web-URL, webpagina, afbeelding, bestand en tekst, en Android-intentfilters voor
      `text/*`, `image/*`, `application/pdf`. `expo prebuild -p ios` genereert de
      ShareExtension-target; app group `group.amsterdam.andreas.app` staat op zowel de
      app als de extensie, en de bestaande entitlements (push, associated domains)
      bleven staan. De `patch-package`-stap uit de README bleek niet meer nodig.
- [x] **1.2 — Native build + rooktest (11 sep 2026, iPhone 16 Pro sim).**
      Geverifieerd: Safari → Deel → **Andreas** staat in de sheet → `/import` opent
      met `LINK` + de URL. Foto's → Deel → Andreas → preview rendert uit **onze eigen
      kopie** in `Documents/import/` (`1789117838256-IMG_0004.JPG`), en Sluiten wist
      dat bestand weer — geen verweesde bestanden. Files → Deel → Andreas met een
      PDF geeft `PDF` + `application/pdf · 18 kB` en landt net zo lokaal. Losse
      tekst is nog niet met de hand getest; loopt door hetzelfde pad.
      **Valkuil:** `expo run:ios` moet met `LANG=en_US.UTF-8` — zonder die locale
      klapt CocoaPods op `Unicode Normalization not appropriate for ASCII-8BIT`,
      en `expo run:ios` exit dan alsnog met **code 0**. Het lijkt dus te lukken
      terwijl er niks gebouwd is.
- [x] **1.3 — [`lib/pendingShare.ts`](../apps/mobile/lib/pendingShare.ts).** Persisted
      Zustand-store (zelfde opzet als `store/sessionTimestamps.ts`) in plaats van
      losse AsyncStorage-helpers, plus `normalizeShareIntent()` die de payload van de
      lib naar onze eigen vorm brengt en meteen het bestand kopieert.
- [x] **1.4 — Bestanden lokaal wegzetten.** `expo-file-system` als dependency
      gedeclareerd; gedeelde bestanden gaan naar `${Paths.document}/import/` — buiten
      de cache-dir, want die mag het systeem opruimen en een ticket wil je houden.
- [x] **1.5 — [`app/import.tsx`](../apps/mobile/app/import.tsx) (modal).** Type,
      preview, bestandsnaam/URL/tekst, en een regel die zegt dat er nog niets
      verstuurd is. Sluiten wist de payload én het bestand.
- [x] **1.6 — [`app/+native-intent.ts`](../apps/mobile/app/+native-intent.ts) +
      [`ShareImportCapture`](../apps/mobile/components/ShareImportCapture.tsx).**
      De officiële expo-router-route: de share-deeplink (`andreas://dataUrl=…`) wordt
      omgeleid naar `/import` vóór expo-router hem als route leest, anders krijg je een
      404 op je eigen poster. `ShareIntentProvider` staat bovenaan in `_layout.tsx`
      (moet boven de andere providers) en `<ShareImportCapture />` schrijft de payload
      in de store. Het scherm leest alléén uit de store: de provider reset zichzelf
      als de app naar de achtergrond gaat, en anders valt je import leeg zodra je even
      terugklikt naar Instagram.
- [x] **1.7 — De privacy-grens hard gemaakt.**
      [`lib/importPayload.ts`](../apps/mobile/lib/importPayload.ts) is een whitelist:
      alleen `title`/`artists`/`venue`/`date`/`time`/`city` komen erdoor, meerregelige
      waarden en cijferreeksen van 8+ (ticket-, order-, barcodenummers) worden
      gedropt. `pnpm --filter @andreas/mobile test` draait de zelfcheck op
      `node:test` — 4 tests, geen framework. Sentry heeft een `beforeBreadcrumb` die
      alles met de import-map of de share-extension weggooit; `sendDefaultPii: false`
      dekt console-breadcrumbs namelijk niet.
- [x] **1.8 — Android-pariteit** (12 sep 2026, emulator API 36). Delen vanuit de
      Files-app: kopie, herkenning, koppeling, ticket bewaren en de viewer met
      tik-zoom werken hetzelfde als op iOS. Vier dingen waren anders:
      - Het risico klopte: Android geeft een `content://`-URI en de nieuwe
        `File`-API van expo-file-system kan die niet lezen. `copyAsync` uit
        `expo-file-system/legacy` wél (die gaat via de ContentResolver). Het
        mimetype is daarbij vaak `application/octet-stream`, dus `kind` komt uit
        de extensie van de bestandsnaam.
      - `scanFromURLAsync` geeft op Android de ruwe ML Kit-constante terug (256,
        32) waar iOS "qr" zegt — vertaald in `importBarcode.ts`.
      - ML Kit leest een 0 aan het eind van een tijd als `)`: "21:00" kwam binnen
        als "21:0)" en dan won de deurtijd. `parseTime` repareert dat nu.
      - De blokvolgorde is een andere dan op iOS: de datumregel staat middenin de
        kleine lettertjes, dus "de titel staat boven de datum" pakte een regel
        voorwaarden. De bestandsnaam wijst nu de titelregel aan
        (`titleLineFor`) — die weet wát er staat, de OCR hóe het geschreven wordt.
        Fixture `PARADISO_ANDROID` in `importMetadata.test.ts` houdt dit vast.

      Let op bij testen: fast refresh pakt een wijziging in `lib/` hier niet altijd,
      een volle Reload uit het dev-menu wel. En een `am start`-intent met een
      `content://`-URI uit de shell werkt niet (`SecurityException`) — delen moet
      echt via de share-sheet van de Files-app.

### Een bewaard pad overleeft geen update (12 sep 2026)

Een ticket bewaarde het volledige pad naar z'n bestand, en op iOS zit daar de
UUID van de app-container in:

```
.../Application/90666336-1A06-.../Documents/import/poster.PNG
```

Die UUID verandert bij **elke installatie** — dus ook bij elke update uit de
App Store. Het bestand verhuist mee, het opgeslagen pad niet. Gevolg: de viewer
toonde niets, en erger, `pruneImportDir` herkende het bestand niet meer als
ticket (`isTicketFile` vergeleek hele paden) en gooide het bij de eerstvolgende
navigatie weg. Van vijf bewaarde tickets op het testtoestel wezen er vier naar
een container die niet meer bestond.

Opgelost door het pad **bij het lezen** opnieuw op te bouwen: `ticketFileUri()`
in `store/tickets.ts` pakt de bestandsnaam en zet die tegen de huidige
`Documents/import/`. `isTicketFile` vergelijkt sindsdien op bestandsnaam. Geen
migratie nodig, oude tickets werken weer — mits het bestand nog bestaat.

Regel voor de toekomst: **bewaar nooit een absoluut pad in de document-dir.**
Alleen de naam, en resolven bij gebruik.

### Wat een tourposter kapotmaakt (12 sep 2026)

Een Ben Folds-tourposter door de pijplijn gehaald. De OCR was niet het probleem —
die las álles — maar er kwam uit:

```json
{"title":"PAPER ►","date":null,"time":"14:11","city":"Amsterdam"}
```

Drie dingen, en samen zijn ze het recept voor "Andreas kent dit nog niet":

1. **De artiestnaam stond verticaal.** ML Kit las `B / E / N / F / D` en `S` — met
   de O en de L eruit. Daar valt niets aan te repareren. Maar onderaan stond
   `benfolds.com/tour`, en dát is te lezen. Sindsdien haalt `siteFromLines()` de
   naam uit een webadres (ticketboeren en social eruit gefilterd) en zoekt
   `/import` daarop als de titel niets oplevert. Tegen de echte database:
   `?q=benfolds` → **Ben Folds, Het Concertgebouw, 29 nov** — precies de datum van
   de poster. Dat werkt alleen dankzij trigram; zonder fuzzy geeft "benfolds" nul
   rijen tegen "Ben Folds".

   Dit is een **afgeleide artiestnaam**, geen nieuw veld: `site` staat niet in
   {@link ALLOWED_KEYS} en gaat nooit als veld mee. Hij wordt alleen als zoekterm
   gebruikt, en bij het wegen als extra artiest meegegeven — anders scoort
   "benfolds" tegen "Ben Folds" een nul (geen gedeeld woord) en gooit de drempel
   het juiste antwoord eruit. `textScore` vergelijkt daarom ook zonder spaties.

2. **"14.11 DUBLIN" werd 14:11.** Een puntpaar is een tijd én een datum. Staan er
   drie of meer in het document, dan is het een datumlijst: `parseTime` negeert de
   punt en `parseDate` léést 'm juist (dag.maand, jaar erbij geraden). Eén signaal,
   twee kanten op.

3. **Zestien steden, zestien data.** De eerste (Dublin) won omdat hij bovenaan
   staat. `dateForCity()` zoekt nu eerst de regel met jóuw stad en leest de datum
   daar: "29.11 AMSTERDAM, NL".

Wat er niet is opgelost: de titel blijft "PAPER ►" (ML Kit knipt "PAPER" los van
"AIRPLANE REQUEST TOUR", en dat vliegtuigje is een ►). Dat hoeft ook niet zolang
het domein het event vindt — maar bij *zelf aanmaken* staat die onzin wel in het
formulier.

### En de tweede tourposter (12 sep 2026)

Stevie Wonder, "Songs In The Key of Life". De OCR las de naam gewoon goed —
`151px · STEVIE / WONDER` — en tóch kwam eruit:

```json
{"title":"Screenshot 2026-09-12 at 16.37.56-CF5494B2-C01A-4025-B1C7-E04DDB361641",
 "date":"2026-11-11"}
```

Drie oorzaken, alle drie generiek:

1. **De bestandsnaam van een screenshot won.** `FILE_NOISE` matchte alleen een
   segment dat exact "screenshot" ís. iOS deelt een screenshot als "Screenshot
   2026-09-12 at 16.37.56-<UUID>". Nu vallen namen die een toestel zelf verzint
   af op hun begin (`FILE_DEVICE`), en losse hex-brokken op `FILE_HASH`.
2. **De datum liep over een regeleinde.** "NOV. 11" met "NOV. 19" eronder: de 11
   van de ene regel plus de NOV van de volgende leken samen 11 november. De
   dag-eerst-regex accepteert nu alleen spaties en tabs tussen dag en maand,
   geen `\n`.
3. **Engelse posters zetten de maand voorop** ("OCT. 28 AMSTERDAM, NL"). Die
   vorm kenden we niet, dus `dateForCity` vond niets op de Amsterdam-regel.
   `parseDate` leest 'm nu ook maand-eerst.

En één die pas zichtbaar werd toen de bestandsnaam wegviel: ML Kit knipt "STEVIE
WONDER" in twee regels binnen hetzelfde blok, en dan hield je "STEVIE" over.
`findTitle` plakt nu de volgende regels uit hetzelfde blok eraan, mits ze
ongeveer even hoog zijn en zelf ook een titel zouden mogen zijn. Een tijd eronder
valt af op `ok` — "Open 19:30" is geen titelregel — dus die plakt niet mee.

Resultaat: **Stevie Wonder — 'Songs in The Key of Life' — Ziggo Dome, 28 okt**,
de avond die op de poster naast Amsterdam staat.

### Een ingezoomd ticket bleef ingezoomd — ook na sluiten (12 sep 2026)

Zoom in op pagina 3, sluit het ticket, open het opnieuw: zwart scherm met
paginanummers. Uitzoomen hielp niet, de app afsluiten wel.

Wat er gebeurde: de zoom van een pagina zetten we met `scrollResponderZoomTo`,
en dat is **native state van de scrollview, geen prop van ons**. React Native
hergebruikt native views uit een pool, dus een verse `ZoomablePage` kan een
scrollview krijgen die nog op 3× staat, gecentreerd op een punt van een andere
pagina. Je ticket staat dan buiten beeld. De cyaan/magenta debugranden lieten het
precies zien: de pagina zat op z'n plek, de inhoud erbinnen niet.

Drie dingen opgelost:

1. **Elke pagina zet zichzelf bij de eerste layout op z'n uitgangspunt**
   (`onPageLayout`). Ná de layout, want zoomen naar een rechthoek in een view
   zonder maat rekent met nul en geeft exact dezelfde scheve stand.
2. **Een pagina die nét geboren wordt krijgt geen overgenomen uitsnede.**
   `applied` begint op de focus die er bij de mount ligt. De zoom reist dus mee
   naar kaartjes die al openstaan — precies wat er gebeurt als je veegt — en
   niet naar pagina's die nog moeten renderen.
3. **`zoom.current` houdt bij wat we zélf zetten.** `onScroll` vuurt niet
   betrouwbaar bij een zoom die wij opdragen (zeker niet zonder animatie), en
   dan denkt de volgende tik dat je uitgezoomd bent en zoomt hij nóg een keer
   in — waarna je je ticket kwijt bent.

Plus: een nieuw document (andere pagina-URI's) begint altijd zonder uitsnede.

### Meerdere bestanden in één share (11 sep 2026)

Je koopt drie kaartjes en krijgt drie losse PDF's. Dat kon niet: iOS liet de
extensie alleen zien bij één item (`MaxCount: 1`) en Android had geen
`SEND_MULTIPLE`-filter, dus Andreas stond niet eens in het deelmenu. Nu staan
de iOS-counts op 6 en geeft `androidMultiIntentFilters` de tweede filter.

`PendingShare` draagt de rest in `extraFiles`. De herkenning draait op het
eerste bestand — drie kaartjes zijn één avond, dus één OCR-pass en één match —
en `attachTicket()` koppelt ze allemaal aan dezelfde occurrence. `MAX_FILES = 6`
in [pendingShare.ts](../apps/mobile/lib/pendingShare.ts): wie meer deelt, deelt
een fotoalbum. Opruimen (`pruneImportDir`) en `clearPending` gaan over de hele
lijst via `shareFileUris()`; op één uri laten staan zou de rest de volgende
launch wissen.

**Let op bij plugin-wijzigingen:** `expo run:ios` heeft de config-plugin *niet*
opnieuw gedraaid — de plist bleef op `MaxCount: 1` staan en de extensie bleef
weg uit het deelmenu bij twee foto's, terwijl app.json al 6 zei. Een wijziging
in de plugin-opties vraagt een expliciete `npx expo prebuild -p ios`
(of `-p android`) vóór de build. De gegenereerde bestanden zijn de waarheid:
`ios/ShareExtension/ShareExtension-Info.plist` en
`android/app/src/main/AndroidManifest.xml` — controleer daar, niet in app.json.

## Fase 2 — Lokale herkenning

Tweede native build. Alles on-device.

- [x] **2.1 — QR/barcode-detectie.** [`lib/importBarcode.ts`](../apps/mobile/lib/importBarcode.ts)
      gebruikt `scanFromURLAsync` uit expo-camera — nul nieuwe dependencies.
      Geeft **alleen de types** terug, nooit de inhoud: de waarde in een ticket-QR is
      precies wat het toestel niet mag verlaten, en wat we niet vasthouden kan ook
      niet lekken. Voor "toon ticket" (fase 8) laten we het originele bestand zien,
      dus die waarde hebben we nergens voor nodig. `upc_a`/`upc_e` staan bewust niet
      in de lijst — dat zijn winkelproducten, en een streepjescode op een bierblikje
      in je posterfoto moet geen ticket-signaal worden.
      **Platformverschil dat fase 6 raakt:** iOS gebruikt intern `CIDetector` en
      vindt daar **alleen QR** (de meegegeven typelijst wordt genegeerd); Android
      laat ML Kit de hele lijst doen. Een ticket met alleen een streepjescode of een
      Aztec-code valt op iOS dus door deze route heen — de ticket-heuristiek mag
      "geen code gevonden" niet lezen als "geen ticket".
- [x] **2.2 — OCR op afbeeldingen.** `@react-native-ml-kit/text-recognition@2.0.0`
      in [`lib/importOcr.ts`](../apps/mobile/lib/importOcr.ts). Geeft blokken mét
      bounding box, dus fase 3 kan op tekstgrootte werken. **Geen confidence** — de
      RN-wrapper exposeert het niet, dus fase 3 doet het met tekst + geometrie.
      Twee dingen die dit meebracht:
      1. **iOS-deployment target van 15.1 → 15.5** (ML Kit 8.0 eist het), via
         `expo-build-properties` in `app.json`. Geen praktisch gevolg in 2026.
      2. De podspec trekt **alle vijf** script-modellen binnen (Latijn, Chinees,
         Devanagari, Japans, Koreaans) terwijl we alleen Latijn nodig hebben. Zie
         "App-grootte" hieronder.
- [x] **2.3 — PDF → afbeelding → OCR.** `react-native-pdf-thumbnail@1.3.1` in
      [`lib/importPdf.ts`](../apps/mobile/lib/importPdf.ts): PDFKit op iOS,
      `PdfRenderer` op Android. `/import` rendert pagina 1 lokaal, stuurt die door
      dezelfde OCR- en barcode-route, en gooit de render daarna weg — die landt in de
      cache-dir en een uitgeklede ticketpagina laat je niet langer staan dan nodig.
      **Resolutie is de beperking:** de lib rendert op mediaBox-maat (A4 ≈ 595×842px)
      en heeft geen scale-parameter, alleen JPEG-kwaliteit (staat op 100). Grote tekst
      leest prima; de kleine regels op een e-ticket zitten rond 8-10px en dat is voor
      OCR aan de ondergrens. Als dat op echte tickets tekortkomt is de enige knop een
      eigen Expo-module die op 2× rendert.
      *Embedded PDF-tekst lokaal uitlezen slaan we nog steeds over* — `pdfjs-dist` in
      RN is een DOM-gevecht, en een eigen parser strandt op subset-fonts. Maar let op:
      voor een digitaal gegenereerd e-ticket zou embedded tekst *perfect* zijn waar
      OCR moet gokken. Als PDF-tickets belangrijk worden, is `page.string` uit PDFKit
      in diezelfde eigen module de betere investering dan 2× renderen.
- [x] **2.5 — Opruimen van de import-map.** Niet gepland, wel nodig gebleken: zie
      "Wat de PDF-test aan het licht bracht" hieronder. `pruneImportDir()` in
      [`pendingShare.ts`](../apps/mobile/lib/pendingShare.ts) gooit bij elke launch
      alles uit `Documents/import/` behalve het bestand van de huidige share.
- [x] **2.4 — Debug-view op `/import`.** De herkende blokken staan onder de preview
      met de hoogte van hun grootste regel ervoor (`114px · PLOEGENDIENST`), alleen
      in dev-builds. Dat is het enige gereedschap waarmee fase 3 te tunen is — en het
      leverde meteen twee correcties op, zie hieronder.

### Getest op de simulator (11 sep 2026)

Testposter: grote titel, support-regel, venue, stad, datum, deuren/aanvang, een QR
en een ticket- + ordernummer. Foto's → Deel → Andreas gaf:

```
Ticket code found · QR
8 text blocks
  114px · PLOEGENDIENST
   64px · PARADISO
   54px · support: Library Card
   51px · zaterdag 18 oktober 2026 / deuren 19:30 / aanvang 20:30
   38px · Amsterdam
  160px · D
   27px · Ticket 4417993-02
   27px · Ordernunmmer 3391827
```

Twee dingen die fase 3 moet weten, allebei uit deze ene test:

1. **Werk op regelhoogte, niet op blok-hoogte.** ML Kit groepeert bij elkaar
   horende regels tot één blok, dus `block.frame.height` is de hoogte van de hele
   groep. In de eerste meting kwam de datum daardoor op **153px** uit — hoger dan de
   titel op 114px, terwijl de titel in veel groter font staat. `maxLineHeight()` in
   [`importOcr.ts`](../apps/mobile/lib/importOcr.ts) geeft de bruikbare proxy: dan
   zakt de datum naar 51px en staat de titel bovenaan.
2. **De QR produceert een spookblok** — `160px · D`, één verdwaalde letter uit het
   QR-vlak, en dus meteen de "grootste tekst" als je niet filtert. Fase 3 moet
   blokken van 1-2 tekens weggooien. (Alternatief: de bounds van de gevonden barcode
   bewaren en dat gebied uitsluiten — bounds zijn geometrie, geen ticketdata, dus dat
   mag. Pas doen als het lengtefilter tekortkomt.)

Ook gezien: de OCR maakte van "Ordernummer" *"Ordernunmmer"*. Fase 6 moet dus op
patronen matchen die tegen een typfout kunnen, niet op exacte woorden.

### De PDF-route getest (11 sep 2026)

Ticket-PDF (A4, `cupsfilter`-tekst) via Files → Deel → Andreas:

```
5 text blocks
  10px · E- / TICKET
  10px · PLOEGENDIENST / support : Library Card
  14px · PARADISO / Weterings chans 6-8, Amsterdam
  12px · zaterdag 18 oktober 2026 / deuren 19:30 - aanvang 20:30
  12px · Ticket 4417993-02 / Ordernummer 3391827
```

Alle inhoud komt eruit. Drie dingen om te onthouden:

1. **Op een PDF zegt tekstgrootte niets.** Alle regels komen op 10-14px uit — de
   titel (10px) is *kleiner* dan de venue-regel (14px). De layout-heuristiek van
   fase 3 werkt op posters en screenshots, niet op een tekst-PDF; daar moet het van
   patronen komen (labels als "E-TICKET", venuenamen uit `venues.json`,
   datumpatronen).
2. **Woorden vallen uiteen** — "Weteringschans" werd "Weterings chans". Matchen moet
   fuzzy, ook op venuenamen.
3. `E- / TICKET` als eerste blok is meteen een sterk ticket-signaal voor fase 6.

### Wat de PDF-test aan het licht bracht

In de import-map stonden na een dag testen **vier** bestanden: twee posters en twee
ticket-PDF's, waaronder een echte. Opruimen gebeurde alleen bij "Sluiten", en die
tik komt er niet als de app tussendoor gekilld wordt of je hem direct wegswipt. Voor
een ticket-PDF is dat precies het verkeerde soort restafval.

Nu ruimt `pruneImportDir()` bij elke launch alles op behalve de huidige share —
niet per aanroeper gerepareerd maar op de map zelf, want dat is de gedeelde staat.
Draait pas als `isReady` van de share-provider aangeeft of er een nieuwe share
binnenkomt; eerder zou de prune het bestand kunnen wissen dat net gekopieerd is.

Ook: de gerenderde PDF-pagina in de cache-dir bleef één keer staan zonder dat we
het merkten, omdat de opruimfout werd weggeslikt. `discardPdfRender()` geeft nu de
foutmelding terug en `/import` toont die in dev-builds. Daarna twee keer
gecontroleerd: render weg, import-map leeg.

### App-grootte

`@react-native-ml-kit/text-recognition` hangt in z'n podspec aan alle vijf de
ML Kit-scriptmodellen. Andreas is een Amsterdamse uitgaansgids: Latijn is genoeg.
Twee routes om dat terug te brengen als het te zwaar blijkt:

- de podspec patchen tot alleen `GoogleMLKit/TextRecognition` (vraagt
  `patch-package`, dus extra machinerie);
- op iOS Apple's eigen Vision-framework gebruiken via een klein eigen Expo-module —
  zit al in het OS, dus nul modelgewicht, maar Android blijft ML Kit.

Niet nu doen. Eerst meten wat het in een release-build werkelijk kost.

## Fase 3 — Metadata eruit halen

- [x] **3.1 — [`lib/importMetadata.ts`](../apps/mobile/lib/importMetadata.ts)** —
      blokken → `{ title, artists, venue, date, time, city }`. Puur, zonder
      React-Native-imports, zodat de test er op echte OCR-uitkomsten op kan.
      De opzet volgt uit de twee bronnen: eerst alles wat op patronen te vinden is
      (datum, tijd, venue, support), en de titel als laatste uit wat overblijft — op
      grootte als die informatie er is, anders op leesorde.
- [x] **3.2 — Zelftest**
      ([`importMetadata.test.ts`](../apps/mobile/lib/importMetadata.test.ts)) —
      9 tests op `node:test`, met de échte OCR-uitkomsten van 11 sep als fixtures,
      inclusief de fouten die ML Kit maakte. Plus een integratiecheck dat het
      concept heel door de whitelist van fase 1.7 komt en de ticketnummers van de
      poster er niet in meeliften. Draaien: `pnpm --filter @andreas/mobile test`
      (13 tests in totaal).
- [x] **3.3 — Velden editeerbaar op `/import`.** Zes invulvelden onder de
      herkenning. Corrigeren moet kunnen omdat OCR er structureel naast zit op
      precies de plekken die voor het matchen uitmaken; het is ook de goedkoopste
      manier om fase 4 te laten werken bij matige herkenning — liever één tik van de
      gebruiker dan een slimmere parser.

### Geverifieerd op de simulator (11 sep 2026)

Testposter → Deel → Andreas geeft, zonder handmatige correctie:

| veld | waarde |
|---|---|
| title | PLOEGENDIENST |
| artists | PLOEGENDIENST, Library Card |
| venue | **Paradiso** (canonieke naam uit de venue-lijst, niet het OCR-woord) |
| date | 2026-10-18 |
| time | 20:30 (aanvang, niet deuren) |
| city | Amsterdam |

Typen in de velden werkt en her-extraheert niet over je correctie heen. Het
software-keyboard is niet getest — de simulator gebruikt het hardware-keyboard, dus
of `automaticallyAdjustKeyboardInsets` genoeg is voor het onderste veld moet op een
toestel blijken.

### Wat de tests eruit haalden

Twee bugs die zonder de fixtures pas op een echte poster waren opgevallen:

1. **De adresregel werd de titel.** ML Kit stopt "PARADISO" en "Weteringschans 6-8,
   Amsterdam" in één blok, en die adresregel was 14px tegen 10px voor de titel.
   Opgelost door bij een venue-match ook de regels *eronder in hetzelfde blok* uit
   te sluiten — alleen naar beneden, want op een poster kan de titel bóven de
   venuenaam in hetzelfde blok staan.
2. **"Bret" matchte in "Bretagne Sessions".** Het negeren van spaties (nodig om de
   OCR-woordbreuk "Weterings chans" te overleven) maakte de match te grijpig.
   Nu twee passes: eerst hele woorden, daarna pas spatie-negerend en alleen voor
   namen van 8+ tekens, waar zo'n match geen toeval meer is.

Daarnaast bleek de grootte-drempel te soepel: een absoluut verschil van 4px telde
als hiërarchie, terwijl op een PDF alles tussen 10 en 14px zit. Nu moet de hoogste
regel er 1,4× bovenuit springen, anders wint leesorde.

### Wat fase 4 moet weten

- Het concept is een *concept*. Stuur het via `toServerMetadata()`, nooit rechtstreeks.
- `artists[0]` is de titel zelf — dat is de vorm die de featurelijn voorschrijft
  (`artists: ["Ploegendienst"]`), niet een tweede herkenning.
- `city` wordt alleen gevuld als de tekst het zegt óf als de venue uit onze
  (Amsterdamse) lijst kwam. Geen gok.
- Het datumjaar is geïnterpoleerd als de poster er geen noemt: het eerstvolgende
  voorkomen vanaf vandaag. Bij matchen dus niet hard op het jaar filteren.

## Fase 4 — Matchen met de Andreas-database

- [x] **4.1 — Bestaand endpoint, client-side weging.** `GET /search?q=<titel>` (bestond
      al voor de zoekbalk, ilike op titel én venuenaam) levert de kandidaten;
      [`lib/importMatch.ts`](../apps/mobile/lib/importMatch.ts) scoort ze lokaal:
      titel/artiest 40%, venue 30%, datum 20%, tijd 10% — **genormaliseerd over de
      onderdelen die we kunnen beoordelen**. Heeft de poster geen tijd, dan verdwijnt
      die 10% uit de noemer in plaats van als nul mee te tellen; anders haalt een
      perfecte match met ontbrekende tijd de drempel nooit.
      Alleen de titel gaat mee als `q`, via `toServerMetadata()` — geen datum, geen
      bestandsnaam, geen OCR-dump in een querystring.
- [x] **4.2 — Drie uitkomsten.** Hoog → "Dit event staat in Andreas". Midden →
      "Bedoel je deze?" met max 3 opties. Laag → "Nog niet in Andreas" (fase 5/6).
      Tikken opent het bestaande event-detail met `?source=share`; daar staat de
      ♡/✓-machinerie al, inclusief de occurrence-keuze. Dat scheelt een tweede
      save-pad en het is de enige plek waar de gebruiker bij meerdere datums de
      juiste avond kan kiezen.
- [x] **4.3 — `SaveSource` uitgebreid** met `'share'` en `'scan'`.
      Onderweg opgeruimd: er stonden **twee** lijsten — de union in `lib/api.ts` én
      een `VALID_SAVE_SOURCES` in het event-detail-scherm waar `'new'` in ontbrak,
      waardoor een link met `?source=new` stil z'n attributie verloor. Nu één
      `SAVE_SOURCES`-array met `isSaveSource()` als enige runtime-check.
      Server: `save_source` is een Postgres-enum, dus dit vraagt een migratie —
      **[`0053_save_source_share_scan.sql`](../apps/api/src/db/migrations/0053_save_source_share_scan.sql)
      moet lopen vóór je de API deployt.** Tot dan slaat de server een onbekende
      source stil op als `null`; de mobile-kant kan dus los shippen.
- [ ] **4.4 — `/import/match` als eigen endpoint** — nog niet nodig, maar we weten nu
      precies wanneer wel. Zie hieronder.

### Wat `/search` niet kan, en wat we daarmee doen

Het endpoint geeft per event alleen de **eerstvolgende** occurrence, geen datumlijst
(zie de subquery in `apps/api/src/routes/search.ts`). Bij een film die dertig keer
speelt of een wekelijks feest matcht de posterdatum dus vaak niet, terwijl het event
wél klopt. Een niet-matchende datum is daar geen bewijs van ongelijk.

Daarom: een datum die niet matcht **straft niet af** maar levert deelscore (0,3), en
een datum-match is wél een *voorwaarde* voor hoge confidence. Zonder harde datum
stellen we niets automatisch voor — we vragen het, met de regel "andere datum dan op
je poster, kies de juiste avond op het event". Dat is precies het gedrag dat je wil
en het kost geen nieuw endpoint.

`/import/match` wordt interessant zodra we occurrences willen meewegen (dan verdwijnt
die hele onzekerheid) of wanneer de weging server-side moet om andere redenen.

**Fuzzy zoeken staat er sinds 12 sep 2026** (migratie `0056_trgm_search.sql`:
`pg_trgm` + GIN-index op `events.title` en `venues.name`). Dat loste het
onderste gat op: `/search` deed alleen `ILIKE '%naald%'`, dus één verkeerd
gelezen letter gaf **nul rijen** — en dan valt er aan de clientkant niets meer
te wegen, hoe slim de score ook is. Op de echte database:

| gezocht | gevonden |
|---|---|
| Pagadiso | Paradiso (0,50) |
| The Afghan Wighs | The Afghan Whigs (0,55) |
| Melkwec | Melkweg (0,60) |

Er zijn twee manieren om erbij te komen:

- **De import vráágt erom** (`?fuzzy=1`). Die heeft het ook nodig als het exacte
  woord toevallig íéts oplevert — de goede match kan nog steeds achter een
  verkeerd gelezen letter zitten. Eigen react-query-sleutel
  (`['search', q, 'fuzzy']`), anders geeft de cache de smallere lijst terug die
  het zoekveld van de app voor hetzelfde woord ophaalde.
- **Voor een mens is het een terugval.** Levert de zoekopdracht niets op, dan
  draaien we hem nog een keer los. Een goede zoekopdracht houdt zo z'n rustige,
  chronologische lijst — geen ruis erbij — en een typefout geeft geen leeg
  scherm. Vanaf 3 tekens; korter fuzzy zoeken levert alleen ruis.

Gemeten op de draaiende API, zonder vlag: "Pagadiso" → Paradiso (terugval),
"Paradiso" → dezelfde lijst als voorheen (geen terugval, want er was al
resultaat), "Lowertow" → Lowertown (dat kon ILIKE al), "xq" → niets.

De weging blijft expres op het toestel: de geleerde zaal-vertaling (logo →
Paradiso) is lokaal en moet dat blijven.

### Geverifieerd op de simulator, tegen de productie-database (11 sep 2026)

Testposter met een echt event erop (Lowertown, Paradiso, 12 sep 19:30):

> **MATCH** — Dit event staat in Andreas
> **Lowertown** · Paradiso · Sa 12 SEP · 19:30 — **100%**

En de andere kant van de drempel, zonder dat ik het zo gepland had: de
verzonnen testposter "Ploegendienst · Paradiso · 18 oktober" bleek een *bestaand*
Paradiso-event — maar op **7 november**. Uitkomst:

> **MATCH** — Bedoel je deze?
> **Ploegendienst** · Paradiso · Sa 7 NOV · 19:00 — **80%**
> *andere datum dan op je poster — kies de juiste avond op het event*

Precies het bedoelde gedrag: zelfde event, verkeerde avond → vragen, niet
voorstellen. Tikken opent het echte event-detail met de ♡ erin.

### De privacy-regel moest mee veranderen

Onderaan `/import` stond "Andreas heeft nog niets verstuurd". Dat klopte niet meer
zodra de matcher draait: de titel gaat dan wél naar de server. De regel wisselt nu
naar "Je bestand blijft op je toestel. Alleen titel, venue en datum gingen naar
Andreas om te matchen." Een belofte die niet meer klopt is erger dan geen belofte —
en dit is de enige plek in de flow waar iets de deur uit gaat.

## Fase 5 — Ticketherkenning en intentie

- [x] **5.1 — Ticket-heuristiek** in
      [`lib/importTicket.ts`](../apps/mobile/lib/importTicket.ts): barcode (0,45),
      ticketwoorden (0,3), ticketnummer (0,3), ordernummer (0,25), stoel/rij/vak
      (0,25), PDF (0,15), drempel 0,5. 7 tests op echte ticket- én postertekst.
      Drie keuzes die de tests afdwongen:
      - **Het losse woord "tickets" telt niet.** Dat staat net zo goed op een poster
        ("Tickets vanaf vrijdag 10:00") en dat is verkoopinformatie — fase 10, geen
        kaartje. Alleen `e-ticket`, `admit one`, `toegangsbewijs` en familie tellen.
      - **Een poster met alleen een QR haalt de drempel niet** (0,45). Veel posters
        hebben een QR naar de ticketshop; zou dat genoeg zijn, dan zet Andreas
        "Ik ga" op iets wat je nog moet kopen.
      - **Een ontbrekende barcode is geen bewijs van geen-ticket**, want op iOS
        vindt `scanFromURLAsync` alleen QR (zie 2.1). De tekstsignalen halen de
        drempel daarom op eigen kracht: ticketwoord + ticketnummer = 0,6.
- [x] **5.2 — Intentie voorstellen.** Ticket → ✓ Ik ga, poster/screenshot →
      ♡ Wil ik heen, en een gedeelde **link of tekst blijft altijd** ♡ — een link is
      een ontdekking, geen bewijs van een kaartje, ook niet als er "ticket" in de URL
      staat. Het voorstel staat gemarkeerd met een stip; de chips zijn de actie
      (tikken bewaart, nog eens tikken haalt weg) met `source: 'share'`.
      Ze verschijnen alleen als er een occurrence is om op te landen — bij twijfel
      staat er "kies eerst het juiste event hierboven", geen knop die niets doet.
      De occurrence-id komt uit `GET /events/:id`, alleen opgehaald bij hoge
      confidence: `/search` levert geen occurrence-id's, en bij twijfel is die
      request toch verspild.
- [x] **5.3 — Mijn tickets (Feature 8).**
      [`store/tickets.ts`](../apps/mobile/store/tickets.ts) koppelt één bestand aan
      één occurrence (persisted Zustand, zoals de andere stores). De regel voor de
      gebruiker is voorspelbaar: **✓ Ik ga met een bestand erbij = dat bestand hoort
      bij dit moment**, of het nu een ticket-PDF is of een foto van een papieren
      kaartje. Wat je meegeeft krijg je terug.
      - **Het opruimen draait om.** `clearPending()` en `pruneImportDir()` gooien
        alles weg wat niet bij de huidige share hoort; `isTicketFile()` is nu de
        uitzondering. Een ticket wissen omdat iemand een scherm sluit is precies het
        verkeerde, dus de store is de eigenaar zodra het bestand hangt.
      - [`app/ticket/[occurrenceId].tsx`](../apps/mobile/app/ticket/[occurrenceId].tsx)
        is de viewer: **altijd wit**, nooit nacht-modus — een scanner leest een code
        van een scherm en donkergrijs helpt daar niet. En hij toont het **originele
        bestand**, geen nagemaakte QR: Andreas leest de inhoud van die code niet uit
        (2.1), dus we kúnnen hem niet reconstrueren. Dat is de bedoeling.
      - `🎟 Toon ticket` op event-detail, boven de koop-CTA — heb je al een kaartje,
        dan is "Tickets €24" niet meer het interessantste op die pagina.
      - Verwijderen zit erin, met bevestiging. Jouw ticket, jouw keuze; zonder die
        knop is "lokaal bewaard" een belofte zonder uitgang.

#### Feedback-ronde (11 sep 2026)

Vier dingen uit de eerste versie die niet klopten, plus één gat dat daaruit volgde:

1. **`'going'` bestond niet als save-source** terwijl `/going` er al mee navigeerde.
   Nu toegevoegd aan migratie 0053 (die nog niet gedraaid is), de pgEnum, beide
   server-lijsten, de client-union en `SOURCE_LABEL`.
2. **`🎟 Toon ticket` stond te laag.** Nu direct onder de datum/tijd/venue-cellen en
   in accent: dat is wat je nodig hebt als je bij de deur staat, niet iets om eerst
   een beschrijving en een lineup voor door te scrollen.
3. **Going kon je uitzetten met een ticket eraan** — één tik en je kaartje is weg,
   want tickets hangen aan "ik ga". Nu blokkeert dat met een uitleg en een knop naar
   je ticket; de omgekeerde route (eerst ticket weg, dan going uit) is bewust een
   stap meer. Zit op zowel event-detail als `/import`.
4. **De ticket-vraag stond aan het eind.** "Bij het begin van koppelen moet je
   bepalen of dit tickets zijn" — dus nu een expliciete keuze **vóór** het koppelen:
   een aanvinkregel "Dit is mijn ticket — bewaar het bij dit event", vooringevuld
   door de heuristiek. Zonder vinkje wordt er niets gekoppeld.
5. **Daaruit volgde een gat:** die keuze verscheen alleen bij een 100%-match, want
   zonder gekozen event is er geen occurrence. Een ticket dat op 80% matcht kon dus
   nooit bewaard worden. Nu **selecteert** een tik op een "Bedoel je deze?"-rij die
   kandidaat (radio + accent-rand) in plaats van meteen weg te navigeren; daarna
   verschijnen de keuze en de chips. Navigeren heeft een eigen "Naar het event →"
   gekregen, zodat de rij één taak heeft.

#### Waar je je ticket terugvindt

Eerste versie zat te diep: alleen via event-detail, en op je eigen plannen-lijst zag
je niet eens *dát* je er een had. Nu op drie plekken, allemaal één tik:

- **Homepage → Jouw plannen**: een ticket-hoekje rechtsboven op de tegel, tegenover
  de datum-sticker linksonder.
- **`/going` (Alles →)**: een `🎟 TICKET`-pill in de tag-row, in de toon van de rij.
  Tikken op de pill opent de viewer, tikken op de rij gaat naar het event — twee
  doelen in één rij, want je wil soms het een en soms het ander.
- **Event-detail**: `🎟 Toon ticket` boven de koop-CTA.

Die pill is de enige gevulde accent-kleur in de rij. Dat is bewust: een kaartje dat
je al hebt is precies het ene ding dat eruit mag springen in een lijst met plannen.

#### Twee dingen die 5.3 niet doet

- **Helderheid wordt niet automatisch opgezet.** `expo-brightness` zit niet in de
  deps en dat zou een vierde native rebuild kosten voor een gemak. De viewer vraagt
  het nu aan de gebruiker ("zet je helderheid hoog"). Kandidaat om mee te liften met
  de volgende native wijziging die er toch is.
- **Een PDF-ticket wordt op 1× gerenderd** (A4 ≈ 595px breed), dus de QR komt op
  100-150px uit. Groot genoeg om te zien, maar of een scanner aan de deur dat leest
  is **niet getest**. Dat moet één keer met een echt ticket aan een echte deur; lukt
  het niet, dan is 2× renderen de fix (zie `lib/importPdf.ts`).

### Geverifieerd op de simulator (11 sep 2026)

Poster gedeeld → ✓ Ik ga getikt → "Je ticket staat nu bij Lowertown — alleen op dit
toestel." Daarna, in deze volgorde nagekeken:

1. Sluiten wist het bestand **niet** meer (dat deed het eerst wel).
2. Na een volledige herstart laat de prune het staan.
3. Event-detail toont `🎟 Toon ticket` boven de koop-CTA.
4. De viewer toont het bestand op wit, met "Alleen op dit toestel bewaard".
5. Verwijderen + bevestigen haalt het bestand echt van het toestel.



### Geverifieerd op de simulator (11 sep 2026)

**Poster met een echt event** (Lowertown, Paradiso, 12 sep 19:30) → hoge
confidence → chips verschijnen met ♡ voorgesteld → ♡ getikt → knop wordt accent en
"Staat op Lowertown." De save overleefde (geen rollback), dus de server nam hem aan.
Daarmee is de hele lus rond: **delen → OCR → metadata → match → ♡**, zonder de app
zelf open te doen.

**Ticketachtige content** (dezelfde testposter mét QR en ticket-/ordernummer) →
🎟 "Dit lijkt een ticket", en omdat de match daar maar 80% is: "kies eerst het
juiste event hierboven, dan kan ✓ Ik ga erop."

## Het importscherm als flow (11 sep 2026)

Diederiks bezwaar, en hij had gelijk: *"heel erg techno, veel niet heel
gebruikersvriendelijk."* Wat er stond was het gereedschap waarmee de herkenning is
getuned, per ongeluk tot product gepromoveerd — `8 text blocks`,
`114px · PLOEGENDIENST`, `image/png · 1007 kB · 1600×2400`, `80%`, en zes
invulvelden altijd open. Alles zichtbaar, niets gevraagd.

Nu **twee schermen** met een echte overgang. Eerst was het één scherm dat zich
stap voor stap uitvouwde, maar dat werd te druk: je zag je keuze, de vraag eronder,
de knoppen daaronder en de velden daar weer onder. Een keuze maken schuift nu naar
een volgend scherm waar alleen de volgende stap staat, en de **pijl linksboven gaat
terug** — precies wat je van die pijl verwacht, en geen breadcrumb die niemand mooi
vindt.

1. **Wat je gaf** — de afbeelding groot en gecentreerd, tikken maakt hem fullscreen.
   Geen bestandsnaam eronder bij een afbeelding: die zegt niets wat het beeld niet
   al zegt. Daarna een divider, en de rest eronder.
2. **Welk event is dit** (zelfde scherm, onder de divider) — "Klopt dit?" bij één
   duidelijke kandidaat, "Bedoel je een van deze?" bij meer, "Dit kent Andreas nog
   niet" bij geen. Laatste rij van de lijst is altijd "Geen van deze +" /
   "Zelf toevoegen +".
3. **Scherm 2 — wat wil je hiermee?** Alleen het gekozen event staat er nog, daarna
   ✓ Ik ga en ♡ Wil ik heen in vaste volgorde (alleen het accent beweegt met het
   voorstel mee), plus "Dit is mijn ticket" als er een bestand bij zit. Of, bij
   "geen van deze": het formulier met de aanmeldknop.
4. **Klaar** — "Staat in je plannen" of "Ticket staat erbij", met 🎟 Toon ticket en
   een link naar het event. Terug kan altijd met de pijl.

Wat waar naartoe ging:

- **Percentages zijn weg.** Dat cijfer is onze interne weging. Wat de gebruiker moet
  weten is of hij moet kiezen of alleen bevestigen — en dat zegt de vraag al.
- **De zes velden** zitten achter de laatste keuze in de lijst: "Geen van deze +".
  Eerst stond daar een los mono-linkje "Details aanpassen" naast de keuzes — twee
  ingangen naar hetzelfde, en precies het soort UI-bijproduct waar de rest van deze
  ronde over ging. Nu is de lijst pas compleet mét "geen van deze", en die opent
  meteen het zelf toevoegen: velden nakijken + één knop *Aanmelden bij Andreas*.
- **De ruwe herkenning** (tekstblokken met regelhoogtes, bestandsgegevens,
  barcodetypes, het JSON-concept) zit in een dichtgeklapt `herkenning (dev)`-paneel
  dat alleen in dev-builds bestaat. Onmisbaar om fase 3 te tunen, niets voor een
  gebruiker.
- **Bestandsnamen** staan er niet meer bij een afbeelding: het beeld zegt al wat je
  gaf. Bij een PDF blijft de naam staan, want "ticket.pdf" is wél informatie.
- **De privacyregel is één zin**: "Dit bestand blijft op je toestel en wordt niet met
  Andreas gedeeld." Alleen zichtbaar als er een bestand ís. De langere versie over
  welke velden wél naar de matcher gaan stond er omdat de oude tekst ("Andreas heeft
  nog niets verstuurd") niet meer klopte; deze zin is kort én waar.
- **`insets.top` eruit.** Dit scherm is een sheet, geen fullscreen pagina: de
  safe-area van het toestel optellen gaf een gat van een halve centimeter onder de
  notch. De bottom-inset blijft wel nodig — een volle sheet loopt door tot de
  onderrand.
- **De occurrence-fetch wacht op je keuze.** Eerst haalde hij bij hoge confidence al
  het event-detail op; nu pas na een expliciete bevestiging. Geen verspilde request
  bij twijfel, en de UI doet niet alsof er al iets gekozen is.

De logica eronder is niet veranderd — zelfde OCR, zelfde extractie, zelfde matcher,
zelfde privacygrens. Alleen de vraagstelling.

## Fase 6 — Onbekend event

- [x] **6.1 — Aanmelden.** `POST /submissions`
      ([`routes/submissions.ts`](../apps/api/src/routes/submissions.ts)) → een rij in
      **`event_submissions`**, met migratie
      [`0054_event_submissions.sql`](../apps/api/src/db/migrations/0054_event_submissions.sql).
      In de app: de tak "Dit kent Andreas nog niet" heeft nu een echte knop
      *Aanmelden bij Andreas*, die exact dezelfde `toServerMetadata()`-output stuurt
      als de matcher — geen bestand, geen OCR-tekst, geen ticketgegevens.
      Drie keuzes die erin zitten:
      - **Een eigen tabel, geen `events.published = false`.** Een onvolledige rij in
        `events` zou overal weggefilterd moeten worden, en één vergeten filter is een
        half event in de app.
      - **Anoniem aanmelden mag.** De importflow werkt zonder account; iemand
        weigeren omdat hij er geen heeft is precies de verkeerde drempel. Met account
        geldt een plafond van 20 per dag als vangrail.
      - **De server vertrouwt de client niet.** `/submissions` is publiek, dus de
        whitelist staat er nóg een keer: lengtes, één regel, en velden met acht of
        meer cijfers op een rij (ticket-, order-, barcodenummers) worden geweigerd in
        plaats van opgeslagen.
- [x] **6.2 — Review in de admin.** Onderaan `/admin/import` (waar de import-dingen
      al wonen, dus geen nieuw menu-item): "Aangemeld door gebruikers" met openstaande
      bovenaan, een ✓ bij een venuenaam die op een bekende venue matchte, en per rij
      *Maak event* / *Afgehandeld* / *Geen event*.
      **Niet gedaan:** de velden voorvullen in het event-formulier. Dat is de
      volgende stap als het handmatig overtypen gaat irriteren.
- [x] **6.2 — Direct in je eigen plannen, zonder te wachten op de review.**
      Een aanmelding blijft een aanmelding (niet `events.published = false`:
      136 selects op `schema.events`, inclusief de MCP-gids en de
      social-posts — één vergeten filter en iemands typefout staat in een
      Instagram-post). Maar je kan er "ik ga" op hebben:
      `submission_going` (migratie 0055) plus `event_id` op de aanmelding.
      - `POST /submissions` zet de going-rij er meteen bij als je een account
        hebt, en koppelt je ticket aan `sub-…` (de ticketstore sleutelt op
        een string).
      - `GET /submissions/mine` voedt het groepje "Wacht op Andreas" bovenaan
        `/going`. Afgewezen aanmeldingen vallen eruit.
      - `GET /submissions/match` laat de volgende die hetzelfde affiche scant
        aan dezelfde aanmelding hangen in plaats van een tweede te maken.
      - De admin heeft een **Koppelen**-veld: event-id invullen → status
        `handled`, `event_id` gezet, en iedereen die aan de aanmelding hing
        krijgt een echte `attendance`-rij op de eerstvolgende voorstelling.
        Zonder die stap blijft hun plan voor altijd in de wachtkamer staan.
      - In de app staan ze **tussen** je gewone plannen, niet in een eigen
        groepje: dat Andreas het event nog niet kent is ons werk, niet dat
        van iemand met een kaartje. Zelfde rij, zelfde labels, zelfde
        tegel op de homepage-rail — alleen het beeld ontbreekt, en daar
        staat de eerste letter op een kleurvlak uit het palet (gekozen op
        het id, dus altijd dezelfde kleur voor dezelfde avond).
      - `app/pending/[id].tsx` is de detailpagina: karig met opzet (geen
        beschrijving, geen lineup), maar met wat aan de deur telt — je
        ticket, en de datum/tijd/venue die je zelf invulde.
      - Openstaand: het ticket blijft na die verhuizing op de `sub-…`-sleutel
        hangen in plaats van op de occurrence. Het bestand is niet weg, maar
        de eventpagina laat 'm niet zien tot dat is omgezet.
- [ ] **6.3 — Community-data** ("Op je poster staat Library Card als support.
      Toevoegen?"). Nog niet: dat hangt aan een bestáand event en is een eigen slice.

### Hoe "niet gevonden" eruitziet

Exact hetzelfde blok, alleen de kop verschilt: **"Dit kent Andreas nog niet"** in
plaats van "Zelf toevoegen", met de velden gevuld uit de OCR (bij de testposter:
titel en artiest uit de poster, venue leeg omdat "De Blauwe Golf" geen bekende venue
is, datum en tijd gelezen, stad Amsterdam) en dezelfde aanmeldknop eronder. Eén blok
dat twee situaties dekt: je kiest zelf dat het geen van de opties is, óf er waren er
geen. Lage confidence telt daarbij als "niet gevonden" — een lijst met drie slechte
gokken is erger dan geen lijst.

Aanpassen in die velden laat de matcher opnieuw zoeken. Verbeter je de titel en
blijkt het event er wél te zijn, dan verschijnt de keuzelijst gewoon weer boven het
formulier.

### Het formulier en de ticket-keuze (11 sep 2026)

Twee dingen uit de feedback die allebei neerkwamen op "dit is te klein voor iets
wat belangrijk is":

**De velden.** Eerst 15px-invoervakjes van 40 hoog — prima op een desktopformulier,
niet op een toestel dat je met één duim vasthoudt. Nu 17px (de maat die iOS zelf
voor invoer gebruikt) in vakken van 56 hoog, de titel als grootste veld omdat dat de
kop van het event is, en placeholders die zeggen wat er moet komen ("Wie speelt er")
in plaats van "Niet herkend". De subtekst boven het formulier is weg: de kop zegt het
al.

**Datum en tijd zijn geen tekstvelden meer** maar de systeempicker.
`@react-native-community/datetimepicker`, met een platformsplitsing die geen
stijlkeuze is maar hoe de component werkt: iOS rendert de compacte UIDatePicker
inline (dezelfde knop als in Agenda), Android rendert inline niets en opent een
dialoog op een tik. Niemand hoort "jjjj-mm-dd" te typen. Kost wel een vierde native
rebuild.

**De ticket-keuze is een eigen blok geworden** met een echte schakelaar, in plaats
van een aanvinkregeltje. Drie regels die daaruit volgen:

- **Altijd bedienbaar**, ook als de heuristiek zeker weet dat het een ticket is. De
  gebruiker mag altijd nee zeggen.
- **Uitzetten legt uit wat je opgeeft**: "Dan koppelen we het ticket niet. Je kan het
  straks niet vanuit Andreas tonen aan de deur." Een keuze wegnemen is makkelijker
  dan hem eerlijk uitleggen, en het verkeerde.
- Hangt er al een ticket aan dit moment, dan staat er geen dode schakelaar maar
  "Je ticket staat hierbij — tik om te bekijken". (Dat was ook wat er misging in de
  melding "ik kan hem niet deselecteren": bij dat event hing al een ticket uit een
  eerdere test, dus de schakelaar stond er niet.)
- **De hele kaart schakelt**, niet alleen het schuifje: een doelwit van 40×24 is te
  klein voor een keuze die bepaalt of je aan de deur iets te tonen hebt.

Nog drie dingen uit de laatste ronde:

**Het scherm klapperde bij het openen.** Tussen "OCR klaar" en "zoekopdracht
gestart" zit minstens één render zonder kandidaten — en daar flitste
"Dit kent Andreas nog niet" voorbij om meteen daarna alsnog een lijst te tonen. Nu
dekt één `busy`-toestand de hele keten (renderen → OCR → extractie → zoeken), met het
Andreas-kruis en "Even checken wat dit is…" tot er een antwoord ís. En de zoekquery
houdt z'n vorige resultaat vast (`keepPreviousData`), zodat de lijst niet leegknippert
bij elke toetsaanslag als je de titel corrigeert.

**"Geen van deze" is een volwaardige rij geworden**, zelfde vorm als de events met
een pijltje rechts en een ondertitel ("Meld dit event aan bij Andreas"). Als plus-tekst
in een grijze regel las het als een voetnoot; het is net zo goed een keuze.

**De sheet-padding — drie keer fout voordat het klopte.** `/import` verschijnt in
twee gedaantes: als sheet die ónder de notch begint (safe-area niet optellen) en
fullscreen als hij de enige route is (wel optellen). Wat níet werkte:

- `router.canGoBack()` — leest de stack op het verkeerde moment.
- `measureInWindow` — geeft binnen een sheet óók 0, want hij meet vanaf de
  view-controller en niet vanaf het scherm.
- `useRootNavigationState().routes.length` — de root-navigator telt de modal niet als
  aparte route.

Wat wél klopt: **onze eigen hoogte**. Een sheet is korter dan het scherm omdat hij
onder de notch begint; fullscreen is precies zo hoog. Dus `onLayout` meet de hoogte
en vergelijkt met `useSafeAreaFrame()`. Tot er gemeten is gaan we uit van een sheet —
een te grote marge valt meer op dan een te kleine.

De les die drie keer terugkwam: een eigenschap van de *presentatie* is niet af te
leiden uit de *navigatiestructuur*. Meet het ding zelf.

**De ticket-schakelaar staat verticaal gecentreerd** tegen het hele tekstblok, niet
tegen de kop — met twee regels eronder hing hij scheef. En de drie uitleg-teksten
(aan / uit-met-ticket / uit-zonder-ticket) zijn even lang gemaakt, anders sprong de
kaart in hoogte bij het omschakelen.

**De keuzerijen volgen nu de opmaak van de rest van de app**: titel bold 15 en de
regel eronder bold 12 in gedempte kleur, precies zoals `EventListRow`. Er stond te
veel mini-mono in dit scherm; de app gebruikt dat lettertype alleen voor korte
uppercase-labels, niet voor zinnen. "Geen van deze" is daarmee even groot als de
events erboven, met dezelfde tussenruimte — het is net zo goed een keuze.

### Scherm 2 en het volledige scherm (11 sep 2026)

**Het gekozen event is informatie, geen knop.** Het stond er als kaart met
accentrand en vinkje — dat leest als iets wat je kan kiezen, terwijl het alleen
zegt waar je bent. Nu: titel in de display-maat, venue · avond eronder in dezelfde
stijl als de rijen, dan een streep met ruim lucht erboven en eronder, en daarna de
acties. Zelfde opbouw als scherm 1 (info → streep → keuzes), zodat de knoppen het
zwaarste gewicht hebben. De kop "Wat wil je hiermee?" is weg: die concurreerde met
de eventtitel om dezelfde rol.

**Volledig scherm met zoom en meerdere pagina's**
([`ZoomableImages`](../apps/mobile/components/ZoomableImages.tsx)), gebruikt op
`/import` én in de ticketviewer:

- **Twee zoom-implementaties, met opzet.** iOS gebruikt `maximumZoomScale` op de
  ScrollView zelf — de native pinch die Foto's ook gebruikt. Die props doen op
  Android niets, dus daar zit een eigen pinch + pan + dubbeltik op
  gesture-handler. Niet omdat twee paden mooi zijn, maar omdat inzoomen op een
  barcode geen luxe is: kan de scanner het niet lezen, dan sta je bij de deur met
  een ticket dat je niet kan tonen. Zolang je op Android ingezoomd bent staat het
  verticaal scrollen uit, anders vechten pan en scroll om hetzelfde gebaar.
- Een PDF rendert nu **alle** pagina's (`renderPdfPages`), dus een ticket van twee
  kantjes is door te scrollen — en de QR staat niet altijd op pagina 1. Alleen bij
  het openen van het volledige scherm; de herkenning heeft aan pagina 1 genoeg.
- **De PDF-thumbnail is nu de gerenderde eerste pagina** in plaats van een
  document-icoon. Die render kwam er toch al voor de OCR; die gooien we nu niet
  meteen weg maar pas bij het sluiten van het scherm. Zonder thumbnail was er voor
  een PDF ook niets om op te tikken.
- Het moest een **RN-`Modal`** worden en geen absolute laag: `/import` zit zelf in
  een ScrollView, dus een absolute View daarbinnen dekte de header en de dock niet —
  die bleven er dwars doorheen staan.
- Sluiten gaat via een kruisknop en niet via een tik op de achtergrond: bij ingezoomd
  beeld is elke tik ook het begin van een sleep. Die knop heeft een dónkere
  achtergrond, want een lichte verdween volledig in een wit ticket.

**De header is weg.** "Shared with Andreas" vroeg meer aandacht dan het verdiende —
je weet waar je bent, je hebt net gedeeld. Op stap 1 staat er ook geen pijl meer:
sluiten doe je met de knop onderaan, en twee uitgangen naast elkaar is er één te
veel. De pijl verschijnt pas op stap 2, waar hij echt iets doet.

**Pinchen op iOS werkt** (door Diederik met echte vingers bevestigd; simuleren lukt
niet, een twee-vinger-gebaar sluit de modal in plaats van te zoomen).

### Migraties gedraaid (11 sep 2026)

0053 en 0054 zijn uitgevoerd op de Neon-productiedatabase.

- `save_source` is nu: `venue, friend, search, op-gevoel, avond, agenda, kaart,
  series, gered, other, new, share, scan, going`.
- `event_submissions` bestaat, met beide foreign keys (`venue_id` → venues,
  `user_id` → users) en de twee indexen.

Het endpoint is daarna getest met een lokale API tegen diezelfde database:

- Een volledige aanmelding landt correct, met `venue_matched = false` voor een
  onbekende venue en `true` voor "Paradiso".
- Een poging met `"Ticket 4417993021 Ordernummer"` als titel kwam binnen **zonder
  die titel**: de server-whitelist gooide het veld weg (cijferreeks) en bewaarde
  alleen de venue. Het ticketnummer heeft de database dus niet gehaald.
  Kanttekening: zo'n rij is daarmee wel vrij leeg — de admin kan hem afwijzen.

Testrijen zijn daarna verwijderd; `event_submissions` staat weer op 0.

**Wat nog rest:** de API deployen. De app praat met `api.andreas.amsterdam`, en
daar bestaat `/submissions` pas na een deploy — tot dan geeft de aanmeldknop een 404
en zie je "Aanmelden lukte niet".

### En een bevinding over hoe vaak dit überhaupt gebeurt

Om de "onbekend"-tak te testen maakte ik een poster voor een verzonnen event
("NACHTWACHT" in "De Blauwe Golf"). Die matchte alsnog op **twee** echte events:
*NACHTWACHT* in Internationaal Theater Amsterdam en *De Nachtwacht* in Paradiso.
`/search` matcht op titel óf venuenaam, dus een plausibele Nederlandse titel vindt
bijna altijd iets. Gevolg: de aanmeld-tak zal minder vaak verschijnen dan gedacht, en
de échte fout is eerder een verkeerde match dan geen match. Daarom is het goed dat
kiezen expliciet is en dat "Bedoel je een van deze?" niets automatisch vastzet.

## Fase 7 — Verkoop-alerts (Feature 9, 10, 11)

- [ ] **7.1 — Migratie.** `saleStartAt`, `presaleStartAt`, `presaleUrl` op de
      occurrences-tabel (`ticketUrl` staat er al, `schema.ts:487`). Per CLAUDE.md:
      SQL-bestand in `apps/api/src/db/migrations/` **en** direct met `psql` uitvoeren,
      `IF NOT EXISTS` — geen `drizzle-kit push`.
- [ ] **7.2 — 🔔 Herinner mij**, met keuze dag/uur/5-min/bij start. Server-side
      geschedulede push via de bestaande push-route; niet lokaal schedulen, anders
      mist een uitgeschakeld toestel de melding.
- [ ] **7.3 — Pushmelding met `Koop tickets →`** die rechtstreeks naar `ticketUrl`
      opent (`expo-web-browser`), niet via een tussenpagina.
- [ ] **7.4 — Verkoopinfo uit gedeelde content** (`Tickets Friday 10 AM`,
      `Voorverkoop donderdag 10:00`) → `saleStartAt` voorstellen bij import.
- [ ] **7.5 — Sectie "Binnenkort in verkoop"**, gesorteerd op `saleStartAt`.
      Rail op de homepage, niet een eigen tab.

---

## Fase 8 — Poster scanner (Feature 13)

- [x] **8.1 — `app/scan.tsx`** (12 sep 2026) — camera, sluiterknop, klaar. De foto
      gaat via `pendingShareFromPhoto()` langs precies dezelfde weg als een gedeelde
      afbeelding: kopie in `import/`, `setPending`, `/import`. **Geen tweede
      herkenningspad**, en dat moet zo blijven — alles wat de import beter maakt
      (geleerde zalen, fuzzy zoeken, zelf aanmaken) komt zo gratis mee.
      `replace` naar `/import`, niet `push`: sluit je het vel, dan wil je niet
      terug in de zoeker staan. Geen bestandsnaam meegeven — de camera verzint
      `IMG_0042` en dat is geen titel.
- [x] **8.2 — Ingang** in Meer, boven "Nieuwe aanwinsten". Geen zesde tab en geen
      knop op de hero: je scant een poster een paar keer per maand.

      Let op: `expo-camera` zat er al (vriend-QR) en de permissie ook, dus dit kon
      als OTA. De **tekst** van de iOS-permissie ging wel mee (`app.json`, ging over
      alleen de vriend-QR) en die landt pas in de volgende store-build.

---

## Later — niet plannen tot het bovenstaande draait

Mijn avond (14), widget (15), Live Activity (16) en persoonlijke aanbevelingen op
alerts (12) zijn alle drie afhankelijk van data die fase 1-7 pas produceert.
Widget en Live Activity vragen bovendien echte Swift in een config plugin
(`expo-apple-targets`) — dat is een eigen project, geen vervolg-item.

## Bewust overgeslagen

- Embedded PDF-tekst lokaal parsen (2.3) → render-route dekt het.
- Eigen matching-endpoint (4.4) → bestaand `/search` eerst.
- Server-side ticket-opslag → verboden door het privacyprincipe, punt.
- Een aparte "Mijn events"-sectie → `going.tsx` is het al.

---

## Testen op de simulator

**Foto's:** `xcrun simctl addmedia booted poster.jpg`.

**PDF of ander document** — in "Op mijn iPhone" van de Files-app zetten, daarna
Browse → lang indrukken → Deel → Andreas. Slepen van Finder naar het
Simulator-venster hoort ook te werken; vanaf de terminal:

```bash
F=~/Downloads/ticket.pdf
D=$(xcrun simctl list devices booted | grep -oE '[0-9A-F-]{36}' | head -1)
for m in ~/Library/Developer/CoreSimulator/Devices/$D/data/Containers/Shared/AppGroup/*/.com.apple.mobile_container_manager.metadata.plist; do
  [ "$(/usr/libexec/PlistBuddy -c 'Print :MCMMetadataIdentifier' "$m" 2>/dev/null)" = group.com.apple.FileProvider.LocalStorage ] \
    && cp "$F" "$(dirname "$m")/File Provider Storage/"
done
xcrun simctl openurl "$D" shareddocuments://
```

De UUID van die app-group verschilt per toestel, vandaar de lus. Werkt pas nadat
de Files-app één keer geopend is op die simulator.

**Test-ticket maken** zonder een echt ticket te gebruiken — `cupsfilter` zit al op
macOS:

```bash
cupsfilter ticket.txt > ticket.pdf
```

Met in `ticket.txt` een ticket-achtige tekst (event, venue, datum, deuren,
ticketnummer, ordernummer). Handig als fixture voor fase 2 en 3: de
ticketnummers horen door de whitelist in `importPayload.ts` te sneuvelen.

**Na een JS-edit met `/import` open:** relaunch de app
(`xcrun simctl terminate booted amsterdam.andreas.app && xcrun simctl launch booted amsterdam.andreas.app`).
Fast refresh laat de modal soms wit achter — de app leeft nog, maar de root rendert
niks meer tot een verse start.

**Controleren wat er lokaal staat:**

```bash
ls "$(xcrun simctl get_app_container booted amsterdam.andreas.app data)/Documents/import"
```
