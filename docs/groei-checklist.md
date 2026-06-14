# Andreas — Groei-checklist

Hoofdlijnen om bij elke product-, content- of strategie-beslissing langs te lopen. Niet om elke regel altijd tegelijk aan te zetten — om te weten welk aspect je raakt, en wat je dus mee-meet.

Laatste sync: 2026-05-17.

---

## 1. Acquisitie — waar komen nieuwe users vandaan?

- **Organisch zoeken**: Google (SEO-pagina's draaien, sitemap submitted, hub-pagina's gestructureerd), AI-engines (ChatGPT/Perplexity — `llms.txt` + `noai`-headers, structured data).
- **App Store-search (ASO)**: keywords in title/subtitle, screenshots, video preview, categorie, beschrijving NL+EN.
- **Referraal**: bestaande users delen events met vrienden. Token-share flow maakt dit friction-free (zie TODO).
- **Pers**: Parool, Subbacultcha, 3voor12, Vice, FD, NRC — feature-stories + wekelijkse data-haken.
- **Partner-distributie**: venues zelf (sticker bij ingang, QR op poster, link in hun nieuwsbrief).
- **Sociaal**: Instagram, LinkedIn-posts founder, TikTok als de tijd er is. Geen feed-spammen — schaarste werkt.
- **Betaald**: Meta Ads, Apple Search Ads, Spotify Audio. Pas zinvol als je weet wat een user kost vs. waard is — dus ná retentie-meting.

## 2. Conversie — van zien-naar-installeren

- **Smart App Banner** op web-pagina's (al actief — check of 'ie pakt op iOS Safari).
- **Sticky bottom-CTA** op mobile-web (al actief).
- **Open Graph + Twitter cards** per event/venue (al actief; OG-images zijn nu generiek — per-event custom OG zou beter klikken in WhatsApp/Insta/X).
- **App Store listing kwaliteit**: screenshots, beschrijving, keywords, preview-video (jij doet dat).
- **"Open in app"-knoppen** — wrijving moet 0 zijn. Test op iOS Safari, Chrome Android, in-app browsers (Insta-browser is een aparte hel).
- **Friction-killer**: token-share flow (zie TODO) — nieuwe user landt direct in app met vriend + event al klaar.

## 3. Activatie — eerste sessie tot eerste "aha"

- **Onboarding simpel + snel**: phone → OTP → handle = 3 stappen.
- **Eerste sessie moet leveren**: events tonen die echt relevant voelen. Genoeg content + goede defaults (Avond/Vandaag).
- **Eerste save binnen 60 sec** is een sterke voorspeller voor retentie. Meet wanneer een nieuwe user save 1 doet.
- **Vrienden vinden moet makkelijk**: QR-scanner, search, handle deelbaar. Een lege Sociaal-tab is een dood-punt.

## 4. Retentie — terugkomen na week 1

- **Push-notifications** — alleen voor matches op jouw profiel, géén broadcast (zie TODO).
- **Email digest** — wekelijks, gepersonaliseerd (TODO).
- **Reactivation-flow** — na 2+ weken inactief, stille trigger (TODO).
- **Content-vers** — dagelijkse nieuwe events binnen via scrapers + nieuwsbrief-pipeline.
- **App moet goed werken** — geen crashes, snelle laadtijden, state-loss minimaliseren. Sentry meet nu.

## 5. Referraal — bestaande users brengen anderen

- **Token-share flow** (TODO) — friend deelt event-link, vriend installeert, friendship + save automatisch.
- **"Deel Andreas"-CTA** op /jij — direct app-store link.
- **QR-code voor handle** — al af.
- **Vrienden-only features** ("samen gered" sectie, profielinzicht) — geven reden om vrienden aan te zetten tot installeren.
- **Crossings in social-feed** ("5 vrienden hebben dit gered") — staat als TODO-punt; bewijs van sociale activiteit.

## 6. Pers + partnerships

- **Wekelijks data-haakje**: `/deze-week`-dashboard (TODO) — top-saves van vorige week, pers belt voor "wat was druk in Amsterdam afgelopen week" → één antwoord met Andreas als source-credit.
- **Founder-story**: waarom Andreas, anti-broadcast-positioning, leerlus, paper-aesthetic. Eén goede long-read kan een quartaal aan downloads opleveren.
- **Venue-partnerships**: Andreas-sticker bij ingang ("dit speelt vanavond — andreas.amsterdam/v/<slug>"), QR-poster, link in venue-nieuwsbrief, embed-widget voor venue-website.
- **Cultuur-fondsen / stichtingen**: AFK, Mondriaan Fonds, Stadsherstel — Andreas als "culturele infrastructuur" framen.

## 7. Brand + positionering

- **Wat onderscheidt Andreas?** Paper-aesthetic in dag-mode, vrienden-eerst, geen broadcast-feed, Amsterdam-only, nacht-vs-dag dichotomie, leer-app niet engagement-app.
- **5 woorden** die iemand moet denken bij Andreas. Schrijf ze op, test ze in elke screenshot/post.
- **Consistentie**: Archivo + acid-geel + cream/karmijn — niks anders. Geen stockfoto's, geen template-merch.
- **Voice**: kort, droog, Amsterdams. "Wat doe ik nu?" / "Wat plan ik?" — geen marketing-blurb.

## 8. Productkwaliteit

- **Crash-free rate** — Sentry meet nu. Doel: >99.5% op crash-free sessies.
- **App-start tijd** — koud onder 2 sec; warm onder 1 sec.
- **Geen UI-glitches** op verschillende device-grootten (klein iPhone tot Android tablet).
- **Toegankelijkheid** — font-sizes, contrast, screen-reader-labels. Op brede launch belangrijk.
- **Privacy/AVG correct** — pagina's al af, gedrag-tracking nu via Sentry op anonieme basis (user-id is intern, geen e-mail/naam).

## 9. Content / supply

- **Aantal events per week** — hoe meer, hoe meer SEO-surface + activatie. Vandaag ~?.
- **Categorie-breedte** — alleen muziek = klein publiek. Muziek + film + theater + kunst + lit = brede stad.
- **Wijken-dekking** — centrum dominant; Noord, Oost, West, Zuidoost ook nodig voor "echte stad"-claim.
- **Editorial laag** — handgekozen vs. scraped. `featured`-flag is de bridge tussen automatisch en redactioneel.
- **Newsletter-pipeline** (long-tail) — 77 venues zonder feed; mail-import via Claude-extractor + admin review.

## 10. Meten — wat werkt en wat niet

- **Plausible / Simple Analytics** op de web-pagina's (privacy-vriendelijk, EU-host). Search Console laat alleen Google-traffic zien — voor ChatGPT/Perplexity/Reddit-referrers heb je iets anders nodig.
- **Sentry** voor crashes (nu live, Frankfurt).
- **Admin-insights dashboard** voor in-app metrics — DAU/WAU/MAU + trending events/venues + wijken-heatmap al live op `/admin/insights`.
- **Per-channel UTM tracking** op share-links (`?utm_source=instagram` etc.). Vereist ~30 regels server-logging.
- **Cohort-retentie** (W1 / W4 / W12) — vereist een simpel user-event-log naast Sentry-data.

## 11. Compliance + onderhoud

- **AVG / privacy-policy actueel** — al af op `/privacy` (NL+EN).
- **Apple/Google review-policies** — push-permissie copy, camera/locatie reasons, alles al beschreven.
- **Roteren van keys/secrets** — in tech-debt: connection string, Bunny key, Bird key zijn ooit in chat-history beland. Voor bredere launch belangrijk.
- **Backups van Neon** — Neon doet auto-snapshots, check retentie + restore-procedure (een keer geoefend hebben).
- **Native-build cadence** — config-plugin changes (zoals Sentry) vereisen `eas build`. Plan minimaal 1× per maand een native release.

## 12. Founder-discipline

- **Eén ding tegelijk**. Niet "alles parallel" — kies een drijfveer per week (pers / venues / virality / content / kwaliteit) en push die volledig.
- **Meet vóór veranderen**. Geen 5 features parallel zonder te weten welke werkt — wat al binnen is, eerst valideren.
- **5 users per week spreken**. Eerste vraag: "waarom open je 'm wel/niet meer?" Tweede: "wat zou je vandaag delen in je groepschat dat Andreas niet doet?"
- **Niet over-tweaken**. Een minderwaardige feature die niemand gebruikt is goedkoper om te bouwen dan een prachtige feature te verwijderen.

---

## Hoe deze checklist te gebruiken

1. Bij elke nieuwe feature-vraag: welke 1-2 categorieën raakt 'ie? Als 't antwoord "geen" is — twijfel of 't prioriteit moet zijn.
2. Bij stilstand: scan de lijst, vraag welke categorie het minste aandacht kreeg afgelopen maand.
3. Bij groei-tegenvaller: loop categorie 2 (conversie) en 3 (activatie) langs — daar zit meestal een blokker.
4. Bij plateau: 4 (retentie) en 5 (referraal) — zonder die twee blijft elke acquisitie een lek vat.
