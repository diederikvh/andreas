/**
 * `/ai` — publieke connector-pagina die de MCP-functionaliteit "verkoopt":
 * koppel ANDREAS aan ChatGPT, Claude of een eigen AI-agent en doorzoek het
 * Amsterdamse aanbod vanuit je eigen assistent.
 *
 * Hergebruikt het SEO-design-systeem (noir/acid, Archivo + JetBrains Mono,
 * `renderHead`/`renderSiteFooter`/`renderCtaCard`). Exporteert daarnaast de
 * gedeelde bouwstenen die ook op de homepage (compacte promo onder het QR-
 * blok) en op detailpagina's (FAQ-item) worden hergebruikt.
 */
import { Hono } from 'hono';

import {
  APP_STORE_URL,
  PUBLIC_BASE_URL,
  breadcrumbJsonLd,
  escapeHtml,
  faqJsonLd,
  jsonLd,
  renderAppBanner,
  renderCtaCard,
  renderHead,
  renderMobileStickyCta,
  renderSiteFooter,
  renderSiteScripts,
} from './_seo.js';

/** Publieke MCP-endpoint-URL (op de API-host, niet de www-host). */
export const MCP_PUBLIC_URL =
  process.env.MCP_PUBLIC_URL ?? 'https://api.andreas.amsterdam/mcp';

/** Mailadres voor zakelijke/bouwer-vragen. */
const CONTACT_EMAIL = 'wij@andreas.amsterdam';

/**
 * Gedeelde FAQ over de AI-connector. Belandt in FAQPage-JSON-LD op `/ai`,
 * de homepage en detailpagina's — zo pakken ChatGPT/Perplexity de Q/A
 * letterlijk op als citatie (de connector promoot zichzelf in AI-antwoorden).
 * `answerHtml` is de zichtbare variant met link; `answer` (plain) gaat de
 * JSON-LD in.
 */
export const AI_CONNECT_FAQ: Array<{
  question: string;
  answer: string;
  answerHtml: string;
}> = [
  {
    question: 'Werkt ANDREAS in ChatGPT en Claude?',
    answer: `Ja. ANDREAS biedt een Model Context Protocol (MCP)-connector aan op ${MCP_PUBLIC_URL}. Voeg die toe in ChatGPT, Claude of je eigen AI-assistent, log in met je telefoonnummer, en zoek, volg en plan het uitgaansaanbod in Amsterdam en andere steden rechtstreeks vanuit je AI.`,
    answerHtml: `Ja. ANDREAS biedt een Model Context Protocol (MCP)-connector aan. Voeg <code>${escapeHtml(
      MCP_PUBLIC_URL
    )}</code> toe in ChatGPT, Claude of je eigen AI-assistent, log in met je telefoonnummer en zoek, volg en plan het uitgaansaanbod rechtstreeks vanuit je AI. <a href="/ai">Zo werkt het →</a>`,
  },
  {
    question: 'Wat kost het om ANDREAS in mijn AI te gebruiken?',
    answer:
      'Niets. De connector is gratis — je gebruikt je eigen AI-assistent (ChatGPT, Claude of een eigen agent). Tickets koop je rechtstreeks bij de venue; ANDREAS verkoopt zelf geen tickets.',
    answerHtml:
      'Niets. De connector is gratis — je gebruikt je eigen AI-assistent (ChatGPT, Claude of een eigen agent). Tickets koop je rechtstreeks bij de venue; ANDREAS verkoopt zelf geen tickets.',
  },
  {
    question: 'Welke gegevens krijgt mijn AI van ANDREAS?',
    answer:
      'Zonder login alleen het publieke aanbod: titel, zaal, datum, prijs, beschrijving, line-up en een link naar de ANDREAS-pagina. ' +
      'Log je in, dan ook wat je zelf in ANDREAS doet: je hartjes, waar je heen gaat, wie je volgt en je meldingen, en van vrienden alleen wat zij delen. ' +
      'Kaartjes blijven op je telefoon. Je AI verzint niets: alle events komen rechtstreeks en actueel uit ANDREAS.',
    answerHtml:
      'Zonder login alleen het publieke aanbod: titel, zaal, datum, prijs, beschrijving, line-up en een link naar de ANDREAS-pagina. ' +
      'Log je in, dan ook wat je zelf in ANDREAS doet: je hartjes, waar je heen gaat, wie je volgt en je meldingen, en van vrienden alleen wat zij delen. ' +
      'Kaartjes blijven op je telefoon. Je AI verzint niets: alle events komen rechtstreeks en actueel uit ANDREAS.',
  },
];

/** Wat de connector kan, met voorbeeldzinnen. Zelfde indeling als de
    `andreas_help`-tool (mcp/help.ts): hou die twee in sync. */
const CAPABILITIES: Array<{ title: string; body: string; prompts: string[]; account?: boolean }> = [
  {
    title: 'Zoeken',
    body: 'Concerten, clubs, film, theater, expo’s en lezingen in Amsterdam, Utrecht, Rotterdam, Den Haag, Haarlem, Eindhoven, Tilburg, Nijmegen, Groningen en Antwerpen. Met beschrijving en line-up, zodat je AI zelf kan inschatten wat bij je past.',
    prompts: ['Techno dit weekend in Amsterdam', 'Films in Eye volgende week', 'Speelt Fontaines D.C. ergens?'],
  },
  {
    title: 'Seintjes bij nieuw aanbod',
    body: 'Eén gebundelde push om 10:00, alleen als er echt iets nieuws bij is. Ook op smaak in je eigen woorden: elk nieuw event wordt gekeurd en de reden staat in de push. Klopt een seintje niet, zeg het, en hij leert ervan.',
    prompts: ['Laat me weten als er hiphop in Paradiso bijkomt', 'Seintje bij gitaarbands met een jaren-90-randje, zoals The Afghan Whigs'],
    account: true,
  },
  {
    title: 'Artiesten volgen',
    body: 'Volg artiesten, ook als ze hier nog nooit speelden. Zodra ze in de agenda staan, hoor je het.',
    prompts: ['Volg The Afghan Whigs', 'Wie volg ik, en waar spelen ze?', 'Stel artiesten voor die lijken op wie ik volg'],
    account: true,
  },
  {
    title: 'Tips op maat',
    body: 'Je AI krijgt je smaak mee (waar je heen gaat, wat je gered hebt, wie je volgt) plus een voorselectie, en kiest er de beste uit, met een reden per tip.',
    prompts: ['Wat zou ik nog meer leuk vinden?', 'Tips voor oktober in Utrecht'],
    account: true,
  },
  {
    title: 'Je agenda en je vrienden',
    body: 'Waar je heen gaat, wat je gered hebt en welke vrienden er ook gaan, binnen de privacy-instellingen van die vrienden.',
    prompts: ['Wat doe ik deze week?', 'Botst er iets in november?', 'Wie gaat er naar Paradiso deze maand?'],
    account: true,
  },
  {
    title: 'Rond je avond',
    body: 'Een film of expo ervoor, een club of concert erna, op loopafstand van waar je toch al heen gaat.',
    prompts: ['Wat kan ik doen voor of na The Afghan Whigs?'],
    account: true,
  },
  {
    title: 'Doen, zoals in de app',
    body: 'Hartjes, “ik ga”, zalen volgen of blokkeren, genres leuk of niet leuk. Wat je in je AI doet, staat meteen in de app.',
    prompts: ['Zet een hartje op Band of Horses', 'Blokkeer Johan Cruijff ArenA', 'Geen tributebands meer'],
    account: true,
  },
];

/**
 * CSS voor de AI-connector-onderdelen. Wordt op `/ai` via `extraStyles`
 * geïnjecteerd én op de homepage (voor de compacte `.ai-promo`-container).
 * Gebruikt uitsluitend bestaande SEO-tokens (var(--…)).
 */
export const AI_CONNECT_STYLES = `
  /* Kopieerbare endpoint-URL */
  .endpoint {
    display: flex; align-items: center; gap: 8px;
    background: var(--bg-lift); border: 1px solid var(--border);
    border-radius: 12px; padding: 6px 6px 6px 16px;
    margin: 0 0 28px; max-width: 520px;
  }
  .endpoint code {
    flex: 1; min-width: 0;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 14px; color: var(--fg);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .copy-btn {
    flex-shrink: 0; display: inline-flex; align-items: center; gap: 6px;
    background: var(--acid); color: var(--bg);
    border: none; border-radius: 8px; cursor: pointer;
    font-family: 'Archivo', sans-serif; font-weight: 700; font-size: 13px;
    padding: 9px 14px; transition: opacity 120ms;
  }
  .copy-btn:hover { opacity: 0.9; }
  .copy-btn.copied { background: var(--fg-muted); }

  /* Twee koppel-kaarten (ChatGPT / Claude) */
  .ai-steps {
    display: grid; grid-template-columns: 1fr 1fr; gap: 14px;
    margin: 0 0 32px;
  }
  @media (max-width: 640px) { .ai-steps { grid-template-columns: 1fr; } }
  .ai-step-card {
    background: var(--bg-lift); border-radius: 14px; padding: 20px 22px;
  }
  .ai-step-card h3 {
    font-family: 'Archivo', sans-serif; font-weight: 800; font-size: 17px;
    margin: 0 0 14px; color: var(--fg); letter-spacing: -0.2px;
  }
  .ai-step-card ol {
    margin: 0; padding: 0; list-style: none; counter-reset: step;
  }
  .ai-step-card li {
    position: relative; padding: 0 0 12px 30px;
    color: var(--fg-read); font-size: 14px; line-height: 1.5;
    counter-increment: step;
  }
  .ai-step-card li:last-child { padding-bottom: 0; }
  .ai-step-card li::before {
    content: counter(step); position: absolute; left: 0; top: 0;
    width: 20px; height: 20px; border-radius: 999px;
    background: var(--bg-chip); color: var(--acid);
    font-family: 'JetBrains Mono', monospace; font-size: 11px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
  }
  .ai-step-card li code {
    font-family: 'JetBrains Mono', monospace; font-size: 12px;
    color: var(--fg); background: var(--bg-chip);
    padding: 1px 5px; border-radius: 4px;
  }

  /* Wat je kunt vragen */
  .ai-caps { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin: 0 0 32px; }
  @media (max-width: 640px) { .ai-caps { grid-template-columns: 1fr; } }
  .ai-cap { background: var(--bg-lift); border-radius: 14px; padding: 20px 22px; }
  .ai-cap h3 {
    font-family: 'Archivo', sans-serif; font-weight: 800; font-size: 17px;
    margin: 0 0 8px; color: var(--fg); letter-spacing: -0.2px;
  }
  .ai-cap .tag {
    font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 400;
    letter-spacing: 1px; text-transform: uppercase; color: var(--fg-muted);
    margin-left: 8px; vertical-align: 2px;
  }
  .ai-cap p { font-size: 14px; line-height: 1.5; color: var(--fg-read); margin: 0 0 14px; }
  .ai-cap .prompts { margin: 0; }

  /* Voorbeeldvragen */
  .prompts { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 32px; }
  .prompt-chip {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 14px; border-radius: 999px;
    background: transparent; border: 1px solid var(--border);
    color: var(--fg-read); font-size: 13px;
  }
  .prompt-chip::before {
    content: "›"; color: var(--acid); font-weight: 700;
  }

  /* Compacte promo-container op de homepage (onder QR/stores). De
     negatieve top-margin collapse't met de 80px bottom-margin van .stores
     tot ~28px, zodat de promo direct ónder het QR-blok aansluit. */
  .ai-promo {
    background: var(--bg-lift); border: 1px solid var(--acid);
    border-radius: 12px; padding: 18px 20px;
    width: 100%; box-sizing: border-box; margin: -52px 0 80px;
  }
  .ai-promo-kicker {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 11px; letter-spacing: 1.6px; text-transform: uppercase;
    color: var(--acid); margin: 0 0 8px;
  }
  .ai-promo h2 {
    font-family: 'Archivo', sans-serif; font-weight: 800; font-size: 18px;
    letter-spacing: -0.3px; margin: 0 0 8px; color: var(--fg);
  }
  .ai-promo p {
    font-size: 14px; line-height: 1.5; color: var(--fg-read); margin: 0 0 14px;
  }
  .ai-promo-foot { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .ai-promo-foot .go {
    display: inline-flex; align-items: center; gap: 6px;
    background: var(--acid); color: var(--bg);
    font-family: 'Archivo', sans-serif; font-weight: 700; font-size: 14px;
    padding: 10px 16px; border-radius: 10px;
    text-decoration: none;
  }
  .ai-promo-foot .go:hover,
  .ai-promo-foot .go:focus { opacity: 0.9; text-decoration: none; }
  .ai-promo-foot .logos {
    font-family: 'JetBrains Mono', monospace; font-size: 11px;
    letter-spacing: 1px; text-transform: uppercase; color: var(--fg-muted);
  }
`;

/** Kleine client-side helper voor de "Kopieer"-knoppen (data-copy). */
export const COPY_SCRIPT = `
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var v = btn.getAttribute('data-copy');
      navigator.clipboard && navigator.clipboard.writeText(v).then(function () {
        var label = btn.querySelector('[data-copy-label]') || btn;
        var prev = label.textContent;
        label.textContent = 'Gekopieerd';
        btn.classList.add('copied');
        setTimeout(function () { label.textContent = prev; btn.classList.remove('copied'); }, 1600);
      });
    });
  });
`;

/**
 * Compacte promo-container voor de homepage — direct ónder het QR/stores-
 * blok. Verkoopt de connector in één blok met kopieerbare URL + CTA naar
 * `/ai`. Vereist dat `AI_CONNECT_STYLES` en `COPY_SCRIPT` op de pagina staan.
 */
export function renderAiPromo(): string {
  return `
    <div class="ai-promo">
      <p class="ai-promo-kicker">nieuw</p>
      <h2>ANDREAS in jouw AI</h2>
      <p>Koppel ANDREAS aan ChatGPT of Claude: zoek wat er speelt, krijg een seintje bij nieuw aanbod, volg artiesten en vraag tips op maat. Echte, actuele events, met een link naar de pagina.</p>
      <div class="endpoint">
        <code>${escapeHtml(MCP_PUBLIC_URL)}</code>
        <button class="copy-btn" type="button" data-copy="${escapeHtml(MCP_PUBLIC_URL)}" aria-label="Kopieer de connector-URL"><span data-copy-label>Kopieer</span></button>
      </div>
      <div class="ai-promo-foot">
        <a class="go" href="/ai">Zo werkt het →</a>
        <span class="logos">ChatGPT · Claude · eigen agent</span>
      </div>
    </div>
  `;
}

/** Volledige `/ai`-connector-pagina. */
function renderAiConnectPage(): string {
  const faqLd = faqJsonLd(
    AI_CONNECT_FAQ.map((q) => ({ question: q.question, answer: q.answer }))
  );
  const breadcrumb = breadcrumbJsonLd([
    { name: 'ANDREAS', path: '/' },
    { name: 'In jouw AI', path: '/ai' },
  ]);
  // SoftwareApplication-JSON-LD: signaleert aan zoek/AI-engines dat dit een
  // (gratis) AI-connector is.
  const appLd = jsonLd({
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'ANDREAS MCP-connector',
    applicationCategory: 'AI-connector (Model Context Protocol)',
    operatingSystem: 'ChatGPT, Claude, MCP-clients',
    url: `${PUBLIC_BASE_URL}/ai`,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
  });

  const head = renderHead({
    title: 'ANDREAS in jouw AI — zoeken, seintjes en tips in ChatGPT & Claude | ANDREAS',
    description:
      'Koppel ANDREAS aan ChatGPT, Claude of je eigen AI-assistent: zoek wat er speelt in Amsterdam, Utrecht, Rotterdam en verder, krijg seintjes bij nieuw aanbod, volg artiesten en vraag tips op maat. Gratis, inloggen met je telefoon.',
    canonicalPath: '/ai',
    ogType: 'website',
    jsonLdBlocks: [appLd, breadcrumb, faqLd],
    extraStyles: AI_CONNECT_STYLES,
  });

  const capsHtml = CAPABILITIES.map(
    (cap) => `<div class="ai-cap">
          <h3>${escapeHtml(cap.title)}${cap.account ? '<span class="tag">met account</span>' : ''}</h3>
          <p>${escapeHtml(cap.body)}</p>
          <div class="prompts">${cap.prompts
            .map((p) => `<span class="prompt-chip">${escapeHtml(p)}</span>`)
            .join('')}</div>
        </div>`
  ).join('\n        ');

  const faqHtml = AI_CONNECT_FAQ.map(
    (q) =>
      `<details class="home-faq"><summary>${escapeHtml(
        q.question
      )}</summary><p>${q.answerHtml}</p></details>`
  ).join('\n      ');

  const ctaCard = renderCtaCard({
    deeplink: 'andreas://',
    title: 'Liever de app?',
    body: 'ANDREAS is gratis voor iPhone en Android — met pings, agenda-export en zicht op welke vrienden ook gaan.',
    qrUrl: `${PUBLIC_BASE_URL}/ai`,
  });

  return `<!doctype html>
<html lang="nl">
<head>${head}</head>
<body class="has-sticky-cta">
  ${renderAppBanner('andreas://', 'Uitgaan in Amsterdam')}
  ${renderMobileStickyCta('andreas://', 'Open ANDREAS')}
  <main>
    <article>
      <nav class="breadcrumb" aria-label="Kruimelpad">
        <a href="/">ANDREAS</a><span>›</span>
        In jouw AI
      </nav>
      <div class="hero">
        <p class="kicker">model context protocol</p>
        <h1>ANDREAS in jouw AI</h1>
        <p class="lead">
          Koppel ANDREAS aan ChatGPT, Claude of je eigen AI-assistent. Zoek in
          <strong>Amsterdam, Utrecht, Rotterdam en verder</strong>, krijg een seintje als er
          iets nieuws bijkomt, volg artiesten, vraag tips op maat en zie waar je
          vrienden heen gaan. Echte, actuele events met een link naar de pagina.
          Jouw AI denkt mee; wij leveren de verse data.
        </p>
      </div>

      <h2>De connector</h2>
      <p>Voeg deze MCP-URL toe in je AI-client en log in met je telefoonnummer:</p>
      <div class="endpoint">
        <code>${escapeHtml(MCP_PUBLIC_URL)}</code>
        <button class="copy-btn" type="button" data-copy="${escapeHtml(
          MCP_PUBLIC_URL
        )}" aria-label="Kopieer de connector-URL"><span data-copy-label>Kopieer</span></button>
      </div>

      <h2>Koppelen</h2>
      <div class="ai-steps">
        <div class="ai-step-card">
          <h3>In ChatGPT</h3>
          <ol>
            <li>Ga naar Instellingen › Connectoren.</li>
            <li>Kies <code>Connector toevoegen</code> en plak de URL.</li>
            <li>Log in met je telefoonnummer (sms-code).</li>
            <li>Vraag bijvoorbeeld: "wat is er dit weekend in Paradiso?"</li>
          </ol>
        </div>
        <div class="ai-step-card">
          <h3>In Claude</h3>
          <ol>
            <li>Ga naar Instellingen › Connectoren.</li>
            <li>Kies <code>Aangepaste connector</code> en plak de URL.</li>
            <li>Log in met je telefoonnummer (sms-code).</li>
            <li>Stel je vraag in gewone taal.</li>
          </ol>
        </div>
      </div>

      <h2>Wat je kunt vragen</h2>
      <p>Je praat gewoon; je AI kiest zelf wat het moet doen. Zoeken kan zonder account. Log je in, dan werkt alles wat je in de app kunt ook vanuit je AI.</p>
      <div class="ai-caps">
        ${capsHtml}
      </div>

      <h2>Voor bouwers</h2>
      <p>
        Bouw je iets met ANDREAS? De connector is een standaard
        <strong>Model Context Protocol</strong>-endpoint met OAuth — bruikbaar in
        elke MCP-client of je eigen agent. Zonder login is er <code>search_events</code>:
        zoeken op vaste velden (periode, stad, soort, genre, zaal, artiest), met
        beschrijving, line-up en deeplinks. Met login komen er zo'n twintig tools bij
        voor meldingen, artiesten, agenda, vrienden en smaak. Er draait geen model aan
        onze kant: jouw AI redeneert, wij leveren de data. Zakelijk gebruik of
        vragen? Mail <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.
      </p>
      <p>
        Inloggen gaat via je telefoonnummer (sms-code); de auth-stack draait
        volledig in de EU. ANDREAS verkoopt geen data.
      </p>

      <h2>Vragen</h2>
      ${faqHtml}

      ${ctaCard}
    </article>
    ${renderSiteFooter()}
  </main>
  ${renderSiteScripts()}
  <script>${COPY_SCRIPT}</script>
</body>
</html>`;
}

export const aiConnectRoute = new Hono();

aiConnectRoute.get('/ai', (c) =>
  c.body(renderAiConnectPage(), 200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=3600, s-maxage=7200, stale-while-revalidate=86400',
  })
);
