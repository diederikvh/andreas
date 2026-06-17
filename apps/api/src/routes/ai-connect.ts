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
    answer: `Ja. ANDREAS biedt een Model Context Protocol (MCP)-connector aan op ${MCP_PUBLIC_URL}. Voeg die toe in ChatGPT, Claude of je eigen AI-assistent, log in met je telefoonnummer, en doorzoek het Amsterdamse uitgaansaanbod rechtstreeks vanuit je AI.`,
    answerHtml: `Ja. ANDREAS biedt een Model Context Protocol (MCP)-connector aan. Voeg <code>${escapeHtml(
      MCP_PUBLIC_URL
    )}</code> toe in ChatGPT, Claude of je eigen AI-assistent, log in met je telefoonnummer en zoek het Amsterdamse aanbod rechtstreeks vanuit je AI. <a href="/ai">Zo werkt het →</a>`,
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
      'Alleen het publieke event-aanbod: titel, venue, datum, prijs en een link naar de ANDREAS-pagina. Je AI verzint niets — alle events komen rechtstreeks en actueel uit ANDREAS.',
    answerHtml:
      'Alleen het publieke event-aanbod: titel, venue, datum, prijs en een link naar de ANDREAS-pagina. Je AI verzint niets — alle events komen rechtstreeks en actueel uit ANDREAS.',
  },
];

/** Voorbeeldvragen die de connector goed aankan. */
const EXAMPLE_PROMPTS = [
  'Techno dit weekend',
  'Gratis exposities deze maand',
  'Comedy vanavond',
  'Wat speelt er in Paradiso?',
  'Singer-songwriter deze week',
  'Films in EYE volgende week',
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
      <p>Koppel het Amsterdamse aanbod aan ChatGPT of Claude en vraag in gewone taal wat er speelt — echte, actuele events, met een link naar de pagina.</p>
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
    title: 'ANDREAS in jouw AI — koppel Amsterdam aan ChatGPT & Claude | ANDREAS',
    description:
      'Koppel ANDREAS aan ChatGPT, Claude of je eigen AI-assistent. Vraag in gewone taal wat er speelt in Amsterdam en krijg echte, actuele events terug — gratis, inloggen met je telefoon.',
    canonicalPath: '/ai',
    ogType: 'website',
    jsonLdBlocks: [appLd, breadcrumb, faqLd],
    extraStyles: AI_CONNECT_STYLES,
  });

  const promptsHtml = EXAMPLE_PROMPTS.map(
    (p) => `<span class="prompt-chip">${escapeHtml(p)}</span>`
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
          Koppel het <strong>Amsterdamse uitgaansaanbod</strong> aan ChatGPT, Claude
          of je eigen AI-assistent. Vraag in gewone taal wat er speelt — je krijgt
          echte, actuele events uit ANDREAS terug, met een link naar de pagina.
          Jouw AI doet het gesprek; wij leveren de verse data.
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

      <h2>Vraag bijvoorbeeld</h2>
      <div class="prompts">
        ${promptsHtml}
      </div>

      <h2>Voor bouwers</h2>
      <p>
        Bouw je iets met ANDREAS? De connector is een standaard
        <strong>Model Context Protocol</strong>-endpoint met OAuth — bruikbaar in
        elke MCP-client of je eigen agent. Eén tool, <code>search_events</code>,
        levert gestructureerde event-data met deeplinks terug. Zakelijk gebruik of
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
