import { Hono } from 'hono';

import { PUBLIC_BASE_URL } from './_seo.js';

/**
 * Privacy + voorwaarden + auteursrecht — server-rendered, geen build-stap.
 * Pagina's hangen visueel aan de landing/share-stijl: zwart canvas,
 * acid-yellow accent, monospace sub-tekst. Stijl bewust kaal — wettelijk
 * verplicht en lezerslogisch, niet marketing.
 *
 * Tweetalig: NL onder `/privacy`, `/voorwaarden`, `/auteursrecht`;
 * EN onder `/en/privacy`, `/en/terms`, `/en/copyright`. Hreflang-alternates
 * koppelen de varianten zodat Google de juiste taal aan de juiste markt
 * serveert.
 *
 * Bewerken? Pas de constants en bodies hieronder aan. Datum-stempel bij
 * elke materiële wijziging bumpen — dat is wat de AVG verwacht aan
 * transparantie.
 */
export const legalRoute = new Hono();

const LAST_UPDATED_NL = '3 mei 2026';
const LAST_UPDATED_EN = '3 May 2026';
const CONTACT_EMAIL = 'wij@andreas.amsterdam';

type LegalPage = 'privacy' | 'terms' | 'copyright';
type Lang = 'nl' | 'en';

/** URL-paden per taal — gebruikt voor navigatie en hreflang. */
const PATHS: Record<Lang, Record<LegalPage, string>> = {
  nl: { privacy: '/privacy', terms: '/voorwaarden', copyright: '/auteursrecht' },
  en: { privacy: '/en/privacy', terms: '/en/terms', copyright: '/en/copyright' },
};

const NAV_LABELS: Record<Lang, Record<LegalPage, string>> = {
  nl: { privacy: 'Privacy', terms: 'Voorwaarden', copyright: 'Auteursrecht' },
  en: { privacy: 'Privacy', terms: 'Terms', copyright: 'Copyright' },
};

const BACK_LABEL: Record<Lang, string> = {
  nl: '← terug',
  en: '← back',
};

const LANG_SWITCH: Record<Lang, { other: Lang; label: string }> = {
  nl: { other: 'en', label: 'EN' },
  en: { other: 'nl', label: 'NL' },
};

const SHARED_STYLES = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #0a0a0b;
    color: #d8d8d2;
    font-family: -apple-system, system-ui, "Helvetica Neue", sans-serif;
    min-height: 100vh;
  }
  main { max-width: 680px; margin: 0 auto; padding: 64px 28px 96px; }
  .top {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    border-bottom: 1px solid #1d1d20;
    padding-bottom: 18px;
    margin-bottom: 36px;
  }
  .wordmark {
    font-family: Georgia, "Times New Roman", serif;
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.5px;
    text-decoration: none;
    color: #f2f2ef;
  }
  .wordmark::after { content: " ✕"; color: #d4ff3a; font-weight: 400; }
  .topnav {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 11px;
    letter-spacing: 1.4px;
    text-transform: uppercase;
    color: #9a9a94;
  }
  .topnav a {
    color: #9a9a94;
    text-decoration: none;
    border-bottom: 1px solid transparent;
  }
  .topnav a[aria-current="page"] { color: #d4ff3a; border-bottom-color: #d4ff3a; }
  h1 {
    font-family: Georgia, "Times New Roman", serif;
    font-size: 32px;
    letter-spacing: -1px;
    margin: 0 0 8px;
    color: #f2f2ef;
  }
  .meta {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 11px;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: #6a6a64;
    margin: 0 0 40px;
  }
  h2 {
    font-family: Georgia, serif;
    font-size: 18px;
    letter-spacing: -0.3px;
    color: #f2f2ef;
    margin: 36px 0 12px;
  }
  p, li {
    font-size: 15px;
    line-height: 1.65;
    color: #c2c2bb;
  }
  ul { padding-left: 22px; margin: 0 0 16px; }
  li { margin-bottom: 6px; }
  a { color: #d4ff3a; text-decoration: none; border-bottom: 1px solid #2a4d10; }
  a:hover { border-color: #d4ff3a; }
  strong { color: #f2f2ef; font-weight: 600; }
  table.subprocs {
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0 8px;
    font-size: 14px;
  }
  table.subprocs th, table.subprocs td {
    text-align: left;
    padding: 8px 10px;
    border-bottom: 1px solid #1d1d20;
  }
  table.subprocs th {
    color: #9a9a94;
    font-family: ui-monospace, monospace;
    font-size: 11px;
    letter-spacing: 0.6px;
    text-transform: uppercase;
    font-weight: 500;
  }
  table.subprocs td { color: #c2c2bb; }
  hr { border: 0; border-top: 1px solid #1d1d20; margin: 48px 0 28px; }
  .footer-back {
    font-family: ui-monospace, monospace;
    font-size: 11px;
    letter-spacing: 1.2px;
    text-transform: uppercase;
    color: #6a6a64;
  }
`;

function shell(opts: {
  title: string;
  lang: Lang;
  active: LegalPage;
  body: string;
}): string {
  const { lang, active } = opts;
  const labels = NAV_LABELS[lang];
  const paths = PATHS[lang];
  const switchTo = LANG_SWITCH[lang];
  const switchPath = PATHS[switchTo.other][active];
  const canonical = `${PUBLIC_BASE_URL}${paths[active]}`;
  const altNl = `${PUBLIC_BASE_URL}${PATHS.nl[active]}`;
  const altEn = `${PUBLIC_BASE_URL}${PATHS.en[active]}`;

  const navLink = (page: LegalPage) =>
    `<a href="${paths[page]}"${active === page ? ' aria-current="page"' : ''}>${labels[page]}</a>`;

  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${opts.title} · Andreas</title>
  <meta name="robots" content="index,follow" />
  <link rel="canonical" href="${canonical}" />
  <link rel="alternate" hreflang="nl" href="${altNl}" />
  <link rel="alternate" hreflang="en" href="${altEn}" />
  <link rel="alternate" hreflang="x-default" href="${altNl}" />
  <style>${SHARED_STYLES}</style>
</head>
<body>
  <main>
    <header class="top">
      <a class="wordmark" href="/">Andreas</a>
      <nav class="topnav">
        ${navLink('privacy')}
        &nbsp;·&nbsp;
        ${navLink('terms')}
        &nbsp;·&nbsp;
        ${navLink('copyright')}
        &nbsp;&nbsp;|&nbsp;&nbsp;
        <a href="${switchPath}" hreflang="${switchTo.other}">${switchTo.label}</a>
      </nav>
    </header>
    ${opts.body}
    <hr/>
    <p class="footer-back"><a href="/">${BACK_LABEL[lang]}</a></p>
  </main>
</body>
</html>`;
}

// ─── Privacy ────────────────────────────────────────────────────────────

const PRIVACY_BODY = `
<h1>Privacy</h1>
<p class="meta">Laatst gewijzigd: ${LAST_UPDATED_NL}</p>

<p>
  Andreas is een uitgaansapp voor Amsterdam. Hieronder staat wat we van je
  opslaan, waarom, waar het staat, hoe lang het er staat en hoe je het
  weghaalt.
</p>

<h2>Wat we van je opslaan</h2>
<ul>
  <li><strong>Telefoonnummer</strong> — verplicht, want het is je login. We sturen er één SMS-code per inlogpoging naartoe en valideren die.</li>
  <li><strong>Naam en handle</strong> — wat je in de app hebt ingesteld. Vrienden zien dit.</li>
  <li><strong>Avatar</strong> — als je een foto uploadt. Optioneel.</li>
  <li><strong>Voorkeuren</strong> — nacht/dag-modus, of je saves zichtbaar zijn voor vrienden, of je vindbaar bent in zoek.</li>
  <li><strong>Saves, vriendschappen, uitnodigingen, gevolgde venues en series</strong> — als je ze maakt.</li>
  <li><strong>Sessies</strong> — een token op je toestel waarmee we weten dat je ingelogd bent. Geldig 180 dagen, schuift mee.</li>
  <li><strong>Server-logs</strong> — IP-adres + user-agent bij elke API-call, zodat we misbruik kunnen herkennen. Maximaal 30 dagen.</li>
</ul>

<h2>Toestel-permissies</h2>
<ul>
  <li><strong>Camera</strong> — alleen actief wanneer je via de friends-functie een vriend-QR-code scant. De camera-stream wordt lokaal op je toestel verwerkt om de code te decoderen; er gaan geen foto's of beelden naar onze servers.</li>
  <li><strong>Foto-bibliotheek</strong> — alleen wanneer je een avatar-foto kiest. De gekozen foto wordt geüpload naar Bunny (zie sub-verwerkers); andere foto's blijven op je toestel.</li>
  <li><strong>Notificaties</strong> — alleen wanneer je expliciet toestemt. Gebruikt voor herinneringen aan opgeslagen events en updates van gevolgde venues.</li>
</ul>

<h2>Wat we niet opslaan</h2>
<ul>
  <li>Geen wachtwoorden — Andreas heeft er geen.</li>
  <li>Geen geboortedatum, adres, geslacht — niet gevraagd.</li>
  <li>Geen locatie. Je locatie wordt op je toestel gebruikt om afstand te berekenen, maar gaat niet naar de server.</li>
  <li>Geen tracking-pixels, geen advertentie-ID's, geen analytics-SDK's, geen Facebook-integratie.</li>
</ul>

<h2>Waarom we het opslaan (grondslag)</h2>
<ul>
  <li><strong>Uitvoering van overeenkomst</strong> (artikel 6.1.b AVG) — login, je profiel, je saves en je vriendennetwerk: zonder deze gegevens werkt de app niet.</li>
  <li><strong>Gerechtvaardigd belang</strong> (artikel 6.1.f AVG) — server-logs voor misbruikdetectie, en kort bewaren van OTP-codes voor de duur van de inlogpoging.</li>
</ul>

<h2>Waar het staat</h2>
<p>
  Andreas gebruikt de volgende sub-verwerkers, alle binnen de Europese
  Economische Ruimte:
</p>
<table class="subprocs">
  <thead>
    <tr><th>Onderdeel</th><th>Partij</th><th>Locatie</th></tr>
  </thead>
  <tbody>
    <tr><td>Database</td><td>Neon Inc.</td><td>Frankfurt (Duitsland)</td></tr>
    <tr><td>Server-hosting</td><td>Fly.io Inc.</td><td>Amsterdam</td></tr>
    <tr><td>Image-opslag (avatars, foto's)</td><td>BunnyWay d.o.o.</td><td>Ljubljana (Slovenië)</td></tr>
    <tr><td>SMS / inlog-code</td><td>Bird B.V. (voorheen MessageBird)</td><td>Amsterdam</td></tr>
    <tr><td>App-distributie</td><td>Apple Distribution International</td><td>Ierland (App Store-publicatie)</td></tr>
  </tbody>
</table>
<p style="font-size:13px;opacity:0.75;">
  Met Fly.io en Neon (US-bedrijven met EU-regio's) hebben we een
  verwerkers-overeenkomst gesloten op basis van de Standard
  Contractual Clauses.
</p>

<h2>Hoe lang we het bewaren</h2>
<ul>
  <li><strong>Account-data</strong> — totdat je je account verwijdert, daarna binnen 30 dagen weg uit live systemen.</li>
  <li><strong>Sessies</strong> — 180 dagen na laatste activiteit.</li>
  <li><strong>OTP-codes</strong> — enkele minuten, zo lang de SMS-code geldig is.</li>
  <li><strong>Server-logs</strong> — maximaal 30 dagen.</li>
  <li><strong>Back-ups</strong> — versleuteld, met dezelfde rollende termijn.</li>
</ul>

<h2>Wat je rechten zijn</h2>
<p>
  Onder de AVG heb je recht op inzage, correctie, verwijdering, beperking
  en dataportabiliteit van wat we van je hebben. Je kan je rechten
  uitoefenen door te mailen naar
  <a href="mailto:${CONTACT_EMAIL}?subject=Privacy-verzoek">${CONTACT_EMAIL}</a>.
  We reageren binnen vier weken.
</p>
<p>
  Niet tevreden? Je kan een klacht indienen bij de
  <a href="https://autoriteitpersoonsgegevens.nl/" target="_blank" rel="noopener">Autoriteit Persoonsgegevens</a>.
</p>

<h2>Wijzigingen</h2>
<p>
  Als we deze tekst aanpassen vermelden we dat met een nieuwe datum
  bovenaan. Materiële wijzigingen (nieuwe verwerker, ander doel) melden
  we ook in de app.
</p>

<h2>Contact</h2>
<p>
  E-mail: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.
</p>
`;

legalRoute.get('/privacy', (c) => {
  c.header('Content-Type', 'text/html; charset=utf-8');
  c.header('Cache-Control', 'public, max-age=300');
  return c.body(
    shell({ title: 'Privacy', lang: 'nl', active: 'privacy', body: PRIVACY_BODY })
  );
});

// ─── Voorwaarden ────────────────────────────────────────────────────────

const VOORWAARDEN_BODY = `
<h1>Voorwaarden</h1>
<p class="meta">Laatst gewijzigd: ${LAST_UPDATED_NL}</p>

<p>
  Deze voorwaarden zijn van toepassing op het gebruik van Andreas, de
  uitgaansapp voor Amsterdam.
</p>

<h2>Wat Andreas is</h2>
<p>
  Een app die de programmering toont van Amsterdamse venues en wat
  vrienden hebben opgeslagen. Andreas is geen ticketverkoper. Tickets,
  prijzen, deuren en afgelastingen worden door de betreffende venue
  geregeld. Een link op een event-detail verwijst naar de website van
  die venue, waar de transactie plaatsvindt.
</p>

<h2>Je account</h2>
<p>
  Inloggen gebeurt met een telefoonnummer. De gebruiker is
  verantwoordelijk voor het vertrouwelijk houden van zijn nummer en
  toestel. Een account kan op verzoek worden verwijderd via
  <a href="mailto:${CONTACT_EMAIL}?subject=Account-verwijderen">${CONTACT_EMAIL}</a>.
  Verwijdering vindt binnen vijf werkdagen plaats.
</p>

<h2>Gebruik</h2>
<p>Niet toegestaan:</p>
<ul>
  <li>Het gebruik van het nummer of de identiteit van een ander.</li>
  <li>Spam, intimidatie of openbaarmaking van persoonsgegevens via uitnodigingen of handles.</li>
  <li>Geautomatiseerde verzoeken of grootschalige scraping die de dienst belasten.</li>
  <li>Reverse-engineering of pogingen om toegang te krijgen tot andere accounts.</li>
</ul>
<p>
  Bij overtreding kan een account zonder voorafgaande kennisgeving
  worden gedeactiveerd.
</p>

<h2>Geen garanties</h2>
<p>
  Andreas wordt aangeboden in de huidige staat. Andreas geeft geen
  garantie dat een event doorgang vindt, dat een venue open is, of
  dat de dienst zonder onderbreking beschikbaar is.
</p>

<h2>Aansprakelijkheid</h2>
<p>
  De aansprakelijkheid van Andreas is beperkt tot wat onder Nederlands
  recht niet kan worden uitgesloten. Indirecte schade — waaronder
  gemiste evenementen, reiskosten en gederfde inkomsten — is daarvan
  uitgesloten.
</p>

<h2>Wijzigingen</h2>
<p>
  Wijzigingen aan deze voorwaarden worden in de app aangekondigd
  voordat zij in werking treden. De datum bovenaan vermeldt de
  laatste versie.
</p>

<h2>Toepasselijk recht</h2>
<p>
  Op het gebruik van Andreas is Nederlands recht van toepassing.
  Geschillen worden voorgelegd aan de bevoegde rechter in Amsterdam.
</p>

<h2>Contact</h2>
<p>
  <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>
</p>
`;

legalRoute.get('/voorwaarden', (c) => {
  c.header('Content-Type', 'text/html; charset=utf-8');
  c.header('Cache-Control', 'public, max-age=300');
  return c.body(
    shell({ title: 'Voorwaarden', lang: 'nl', active: 'terms', body: VOORWAARDEN_BODY })
  );
});

// ─── Auteursrecht ───────────────────────────────────────────────────────

const AUTEURSRECHT_BODY = `
<h1>Auteursrecht & takedown</h1>
<p class="meta">Laatst gewijzigd: ${LAST_UPDATED_NL}</p>

<p>
  Andreas toont evenement- en venue-pagina's die zijn samengesteld uit
  publiek toegankelijke bronnen — meestal de eigen websites,
  ticket-platforms of social-media-kanalen van de venues zelf. De
  bedoeling van die pagina's is om de programmering van een Amsterdams
  podium, museum, club of bioscoop vindbaar te maken en bezoekers door
  te verwijzen naar de venue voor verdere informatie en ticketverkoop.
</p>

<h2>Beeldmateriaal</h2>
<p>
  Foto's bij events en venues zijn afkomstig van de venues zelf of van
  hun officiële PR-bronnen. Het auteursrecht ligt bij de oorspronkelijke
  rechthebbenden. Andreas claimt geen eigenaarschap op dit beeldmateriaal
  en gebruikt het in redactionele context, ter aankondiging van het
  betreffende evenement — een gebruik dat in de praktijk overeenkomt met
  het doel waarvoor de venues het materiaal hebben gepubliceerd.
</p>

<h2>Tekstuele inhoud</h2>
<p>
  Beschrijvingen, line-ups, prijsinformatie en data komen uit publiek
  beschikbare bronnen (venue-agenda's, ticket-API's, RSS-feeds, en
  redactionele samenvattingen). Originele redactionele teksten op
  Andreas-pagina's vallen onder het auteursrecht van Andreas.
</p>

<h2>Niet voor AI-training</h2>
<p>
  Andreas geeft via de <code>X-Robots-Tag: noai, noimageai</code>-header
  en de <code>robots.txt</code>-bot-richtlijnen een expliciet signaal
  dat de inhoud van deze site niet gebruikt mag worden voor training
  van generatieve AI-modellen. Dit signaal richt zich tot alle
  AI-crawlers die deze veelgebruikte conventie respecteren.
</p>

<h2>Takedown-verzoek</h2>
<p>
  Ben je rechthebbende van een foto, tekst of evenement-vermelding op
  Andreas en wil je dat we het verwijderen of aanpassen? Stuur een
  takedown-verzoek naar
  <a href="mailto:${CONTACT_EMAIL}?subject=Takedown-verzoek">${CONTACT_EMAIL}</a>
  met:
</p>
<ul>
  <li>De volledige URL van de pagina(s) waar het materiaal staat;</li>
  <li>Een omschrijving van het auteursrechtelijk beschermde werk
      (welke foto, welke tekst, welk event);</li>
  <li>Een verklaring dat je rechthebbende bent of namens de rechthebbende
      handelt;</li>
  <li>Een werkend contactadres.</li>
</ul>
<p>
  Verzoeken worden binnen <strong>vijf werkdagen</strong> behandeld.
  In de regel verwijderen of vervangen we het materiaal direct;
  bij onduidelijke claims nemen we contact op voor verificatie.
</p>

<h2>Onjuiste vermelding</h2>
<p>
  Klopt een datum, prijs, line-up of beschrijving niet meer? Stuur een
  correctie naar
  <a href="mailto:${CONTACT_EMAIL}?subject=Correctie">${CONTACT_EMAIL}</a>.
  We verwerken correcties zo snel mogelijk, meestal binnen één
  werkdag.
</p>

<h2>Contact</h2>
<p>
  <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>
</p>
`;

legalRoute.get('/auteursrecht', (c) => {
  c.header('Content-Type', 'text/html; charset=utf-8');
  c.header('Cache-Control', 'public, max-age=300');
  return c.body(
    shell({ title: 'Auteursrecht', lang: 'nl', active: 'copyright', body: AUTEURSRECHT_BODY })
  );
});

// ============================================================
// English versions — /en/privacy, /en/terms, /en/copyright
// ============================================================

// ─── Privacy (EN) ───────────────────────────────────────────────────────

const PRIVACY_BODY_EN = `
<h1>Privacy</h1>
<p class="meta">Last updated: ${LAST_UPDATED_EN}</p>

<p>
  Andreas is a going-out app for Amsterdam. Below: what we store about you,
  why, where it lives, how long we keep it and how to remove it.
</p>

<h2>What we store about you</h2>
<ul>
  <li><strong>Phone number</strong> — required, because it's your login. We send one SMS-code per login attempt and verify it.</li>
  <li><strong>Name and handle</strong> — whatever you set in the app. Friends can see this.</li>
  <li><strong>Avatar</strong> — if you upload one. Optional.</li>
  <li><strong>Preferences</strong> — night/day mode, whether your saves are visible to friends, whether you're discoverable in search.</li>
  <li><strong>Saves, friendships, invites, followed venues and series</strong> — if you create them.</li>
  <li><strong>Sessions</strong> — a token on your device that keeps you logged in. Valid for 180 days, rolling.</li>
  <li><strong>Server logs</strong> — IP address + user agent on each API call, so we can detect abuse. Max 30 days.</li>
</ul>

<h2>Device permissions</h2>
<ul>
  <li><strong>Camera</strong> — only active when you scan a friend's QR code via the friends feature. The camera stream is processed locally on your device to decode the code; no photos or imagery is sent to our servers.</li>
  <li><strong>Photo library</strong> — only when you pick an avatar photo. The chosen photo is uploaded to Bunny (see sub-processors); other photos remain on your device.</li>
  <li><strong>Notifications</strong> — only when you explicitly opt in. Used for reminders of saved events and updates from venues you follow.</li>
</ul>

<h2>What we don't store</h2>
<ul>
  <li>No passwords — Andreas doesn't have them.</li>
  <li>No date of birth, address, gender — never asked.</li>
  <li>No location. Distance is calculated on your device; nothing leaves the phone.</li>
  <li>No tracking pixels, no advertising IDs, no analytics SDKs, no Facebook integration.</li>
</ul>

<h2>Why we store it (legal basis)</h2>
<ul>
  <li><strong>Performance of contract</strong> (article 6.1.b GDPR) — login, profile, saves and friend network: without these the app doesn't function.</li>
  <li><strong>Legitimate interest</strong> (article 6.1.f GDPR) — server logs for abuse detection, and brief retention of OTP-codes during a login attempt.</li>
</ul>

<h2>Where it lives</h2>
<p>
  Andreas uses the following sub-processors, all within the European
  Economic Area:
</p>
<table class="subprocs">
  <thead>
    <tr><th>Component</th><th>Provider</th><th>Location</th></tr>
  </thead>
  <tbody>
    <tr><td>Database</td><td>Neon Inc.</td><td>Frankfurt (Germany)</td></tr>
    <tr><td>Server hosting</td><td>Fly.io Inc.</td><td>Amsterdam</td></tr>
    <tr><td>Image storage (avatars, photos)</td><td>BunnyWay d.o.o.</td><td>Ljubljana (Slovenia)</td></tr>
    <tr><td>SMS / login code</td><td>Bird B.V. (formerly MessageBird)</td><td>Amsterdam</td></tr>
    <tr><td>App distribution</td><td>Apple Distribution International</td><td>Ireland (App Store publication)</td></tr>
  </tbody>
</table>
<p style="font-size:13px;opacity:0.75;">
  With Fly.io and Neon (US companies with EU regions) we've signed a
  data-processing agreement based on the Standard Contractual Clauses.
</p>

<h2>How long we keep it</h2>
<ul>
  <li><strong>Account data</strong> — until you delete your account, then removed from live systems within 30 days.</li>
  <li><strong>Sessions</strong> — 180 days after last activity.</li>
  <li><strong>OTP codes</strong> — minutes only, as long as the SMS code is valid.</li>
  <li><strong>Server logs</strong> — max 30 days.</li>
  <li><strong>Backups</strong> — encrypted, with the same rolling expiry.</li>
</ul>

<h2>Your rights</h2>
<p>
  Under the GDPR you have the right to access, rectify, erase, restrict and
  port your personal data. Exercise your rights by emailing
  <a href="mailto:${CONTACT_EMAIL}?subject=Privacy-request">${CONTACT_EMAIL}</a>.
  We respond within four weeks.
</p>
<p>
  Not satisfied? You can file a complaint with the Dutch
  <a href="https://autoriteitpersoonsgegevens.nl/en" target="_blank" rel="noopener">Data Protection Authority</a>.
</p>

<h2>Changes</h2>
<p>
  When we update this text we mark it with a new date at the top. Material
  changes (new processor, different purpose) are also announced in the app.
</p>

<h2>Contact</h2>
<p>
  Email: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.
</p>
`;

legalRoute.get('/en/privacy', (c) => {
  c.header('Content-Type', 'text/html; charset=utf-8');
  c.header('Cache-Control', 'public, max-age=300');
  return c.body(
    shell({ title: 'Privacy', lang: 'en', active: 'privacy', body: PRIVACY_BODY_EN })
  );
});

// ─── Terms (EN) ─────────────────────────────────────────────────────────

const TERMS_BODY_EN = `
<h1>Terms</h1>
<p class="meta">Last updated: ${LAST_UPDATED_EN}</p>

<p>
  These terms apply to the use of Andreas, the going-out app for Amsterdam.
</p>

<h2>What Andreas is</h2>
<p>
  An app that shows the programming of Amsterdam venues and what friends
  have saved. Andreas is not a ticket vendor. Tickets, prices, doors and
  cancellations are handled by the venue. A link on an event detail page
  refers to that venue's website, where the transaction happens.
</p>

<h2>Your account</h2>
<p>
  Login uses a phone number. The user is responsible for keeping their
  number and device confidential. An account can be deleted on request
  via
  <a href="mailto:${CONTACT_EMAIL}?subject=Account-deletion">${CONTACT_EMAIL}</a>.
  Deletion takes place within five working days.
</p>

<h2>Acceptable use</h2>
<p>Not permitted:</p>
<ul>
  <li>Using someone else's phone number or identity.</li>
  <li>Spam, harassment or disclosing personal data via invites or handles.</li>
  <li>Automated requests or large-scale scraping that strain the service.</li>
  <li>Reverse-engineering or attempts to access other accounts.</li>
</ul>
<p>
  In case of violation, an account may be deactivated without prior notice.
</p>

<h2>No warranties</h2>
<p>
  Andreas is provided as-is. Andreas does not warrant that an event will
  take place, that a venue will be open, or that the service is available
  without interruption.
</p>

<h2>Liability</h2>
<p>
  Andreas's liability is limited to the extent that cannot be excluded under
  Dutch law. Indirect damages — including missed events, travel costs and
  lost income — are excluded.
</p>

<h2>Changes</h2>
<p>
  Changes to these terms are announced in the app before they take effect.
  The date at the top reflects the latest version.
</p>

<h2>Governing law</h2>
<p>
  Use of Andreas is governed by Dutch law. Disputes are submitted to the
  competent court in Amsterdam.
</p>

<h2>Contact</h2>
<p>
  <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>
</p>
`;

legalRoute.get('/en/terms', (c) => {
  c.header('Content-Type', 'text/html; charset=utf-8');
  c.header('Cache-Control', 'public, max-age=300');
  return c.body(
    shell({ title: 'Terms', lang: 'en', active: 'terms', body: TERMS_BODY_EN })
  );
});

// ─── Copyright (EN) ─────────────────────────────────────────────────────

const COPYRIGHT_BODY_EN = `
<h1>Copyright & takedown</h1>
<p class="meta">Last updated: ${LAST_UPDATED_EN}</p>

<p>
  Andreas presents event and venue pages compiled from publicly accessible
  sources — typically the websites, ticket platforms or social-media
  channels of the venues themselves. The purpose of these pages is to make
  the programming of an Amsterdam stage, museum, club or cinema findable
  and to refer visitors to the venue for further information and ticketing.
</p>

<h2>Imagery</h2>
<p>
  Photos accompanying events and venues originate from the venues
  themselves or from their official PR sources. Copyright rests with the
  original rights-holders. Andreas claims no ownership of this imagery and
  uses it in editorial context, to announce the relevant event — a use
  that in practice matches the purpose for which the venues published the
  material.
</p>

<h2>Textual content</h2>
<p>
  Descriptions, line-ups, pricing and dates come from publicly available
  sources (venue agendas, ticket APIs, RSS feeds, and editorial summaries).
  Original editorial texts on Andreas pages are copyrighted to Andreas.
</p>

<h2>Not for AI training</h2>
<p>
  Andreas signals via <code>X-Robots-Tag: noai, noimageai</code> headers
  and <code>robots.txt</code> bot directives that this site's content
  must not be used to train generative AI models. This signal addresses
  all AI crawlers that respect the widely-used convention.
</p>

<h2>Takedown request</h2>
<p>
  Are you the rights-holder of a photo, text or event listing on Andreas
  and you want it removed or amended? Send a takedown request to
  <a href="mailto:${CONTACT_EMAIL}?subject=Takedown-request">${CONTACT_EMAIL}</a>
  with:
</p>
<ul>
  <li>The full URL of the page(s) where the material appears;</li>
  <li>A description of the copyrighted work (which photo, which text,
      which event);</li>
  <li>A statement that you're the rights-holder or acting on their behalf;</li>
  <li>A working contact address.</li>
</ul>
<p>
  Requests are handled within <strong>five working days</strong>.
  As a rule we remove or replace the material directly; for unclear claims
  we'll get in touch for verification.
</p>

<h2>Incorrect listing</h2>
<p>
  Is a date, price, line-up or description wrong? Send a correction to
  <a href="mailto:${CONTACT_EMAIL}?subject=Correction">${CONTACT_EMAIL}</a>.
  We process corrections as quickly as possible, usually within one
  working day.
</p>

<h2>Contact</h2>
<p>
  <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>
</p>
`;

legalRoute.get('/en/copyright', (c) => {
  c.header('Content-Type', 'text/html; charset=utf-8');
  c.header('Cache-Control', 'public, max-age=300');
  return c.body(
    shell({ title: 'Copyright', lang: 'en', active: 'copyright', body: COPYRIGHT_BODY_EN })
  );
});
