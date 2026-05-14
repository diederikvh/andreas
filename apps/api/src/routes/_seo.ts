/**
 * SEO/GEO helpers voor de publieke share-pagina's (/e/:id, /v/:slug).
 *
 * Doel: één template-laag die zorgt voor JSON-LD, OG-meta, canonical en
 * de gedeelde Nacht-styling (donker + acid-geel). Wordt aangeroepen door
 * `share.ts` voor zowel de event- als venue-pagina's.
 *
 * Strategische premisse: de pagina is etalage, niet winkel. Genoeg
 * structuur en feiten om door Google + AI-engines goed gevonden en
 * geciteerd te worden; de unieke waarde (saves, vrienden, agenda,
 * notificaties) blijft in de app.
 */

import qrcode from 'qrcode-generator';

export const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ?? 'https://andreas.amsterdam';
export const APP_STORE_URL =
  process.env.APP_STORE_URL ?? 'https://apps.apple.com/nl/app/andreas/id000000000';
export const PLAY_STORE_URL =
  process.env.PLAY_STORE_URL ??
  'https://play.google.com/store/apps/details?id=amsterdam.andreas.app';
/**
 * Default OG-image fallback voor pagina's zonder een eigen image (homepage,
 * events/venues zonder imageUrl). Default = het app-icoon (1024×1024 PNG,
 * werkt overal: WhatsApp, iMessage, Facebook, Discord, Twitter, AI-engines).
 * Override via env-var als je later een breedformaat 1200×630-card wilt.
 *
 * `OG_IMAGE_BANNER_URL` is het brede 1200×630 SVG-alternatief — gebruikt
 * voor large-card contexten (Twitter `summary_large_image`).
 */
export const OG_IMAGE_URL =
  process.env.OG_IMAGE_URL ?? `${PUBLIC_BASE_URL}/icon.png`;
export const OG_IMAGE_BANNER_URL = `${PUBLIC_BASE_URL}/og.svg`;

export function escapeHtml(input: string | null | undefined): string {
  if (input == null) return '';
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * JSON-LD payload veilig inbedden in een <script>-tag. Backslashes en
 * `</` worden geëscaped om early-termination en XSS te voorkomen wanneer
 * een titel of description een sluit-script-tag zou bevatten.
 */
export function jsonLd(payload: unknown): string {
  return JSON.stringify(payload, jsonLdReplacer)
    .replace(/<\/script/gi, '<\\/script')
    .replace(/<!--/g, '<\\!--');
}

function jsonLdReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}

/* ---------- schema.org type-detectie ---------- */

export type ApiEvent = {
  kind: 'show' | 'exhibition';
  category: 'Muziek' | 'Theater' | 'Literatuur' | 'Film' | 'Kunst';
};

export type ApiVenue = {
  type:
    | 'galerie'
    | 'museum'
    | 'podium'
    | 'club'
    | 'film'
    | 'ruimte'
    | 'boekhandel-cafe'
    | null;
};

/**
 * Map ANDREAS-event → meest specifiek schema.org type. Specifiek is beter
 * voor Google rich results en geeft AI-engines een sterker signaal.
 */
export function eventSchemaType(event: ApiEvent): string {
  if (event.kind === 'exhibition') return 'ExhibitionEvent';
  switch (event.category) {
    case 'Muziek':
      return 'MusicEvent';
    case 'Theater':
      return 'TheaterEvent';
    case 'Film':
      return 'ScreeningEvent';
    case 'Kunst':
      return 'VisualArtsEvent';
    case 'Literatuur':
      // Schema.org heeft geen LiteraryEvent — generieke Event is correcter
      // dan een verzonnen subtype. Google interpreteert generieke Events ook.
      return 'Event';
    default:
      return 'Event';
  }
}

/** Nederlands label per venue-type, voor display in lijsten en facts-table. */
export function venueTypeLabel(type: ApiVenue['type']): string | null {
  switch (type) {
    case 'museum': return 'Museum';
    case 'galerie': return 'Galerie';
    case 'podium': return 'Podium';
    case 'club': return 'Club';
    case 'film': return 'Bioscoop';
    case 'boekhandel-cafe': return 'Boekhandel & café';
    case 'ruimte': return 'Ruimte';
    default: return null;
  }
}

/** Map ANDREAS-venue.type → meest passend schema.org type. */
export function venueSchemaType(venue: ApiVenue): string {
  switch (venue.type) {
    case 'museum':
      return 'Museum';
    case 'galerie':
      return 'ArtGallery';
    case 'film':
      return 'MovieTheater';
    case 'club':
    case 'podium':
      return 'MusicVenue';
    case 'boekhandel-cafe':
      return 'CafeOrCoffeeShop';
    default:
      return 'EventVenue';
  }
}

/* ---------- datum/tijd-formatting (NL) ---------- */

const TZ = 'Europe/Amsterdam';

/** "Zondag 3 mei 2026" */
export function formatDateLong(date: Date): string {
  return date.toLocaleDateString('nl-NL', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: TZ,
  });
}

/** "19:30" */
export function formatTime(date: Date): string {
  return date.toLocaleTimeString('nl-NL', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TZ,
  });
}

/** "Zo 3 mei · 19:30" — voor occurrence-rijen in lijsten. */
export function formatShort(date: Date): string {
  return date.toLocaleString('nl-NL', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TZ,
  });
}

/** "T/m 6 mei 2026" — voor exhibitions met endsAt. */
export function formatRangeLong(start: Date, end: Date): string {
  const startStr = start.toLocaleDateString('nl-NL', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: TZ,
  });
  const endStr = end.toLocaleDateString('nl-NL', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: TZ,
  });
  return `${startStr} t/m ${endStr}`;
}

/**
 * ANDREAS-conventie: venue.address = "<straat + nr>, Amsterdam". Voor
 * JSON-LD streetAddress willen we alleen het straat-deel, en voor display
 * willen we niet dubbel "Amsterdam, Amsterdam" plakken.
 */
export function streetAddress(address: string): string {
  return address.replace(/,\s*Amsterdam\s*$/i, '').trim();
}

/**
 * Pak alleen de leesbare hostname uit een ticket-URL voor weergave.
 * `https://shop.paradiso.nl/event/123` → `paradiso.nl`. Bij ongeldige URL:
 * return originele string (fail-safe).
 */
export function ticketDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** "€15", "€12,50", of "Gratis". Bij `null`: lege string. */
export function formatPrice(priceCents: number | null): string {
  if (priceCents == null) return '';
  if (priceCents === 0) return 'Gratis';
  const euros = priceCents / 100;
  if (Number.isInteger(euros)) return `€${euros}`;
  return `€${euros.toFixed(2).replace('.', ',')}`;
}

/* ---------- gedeelde Nacht-styling (inline CSS) ---------- */

/**
 * Inline CSS voor de SEO-pagina's. Geen externe stylesheet — eerste byte
 * is een complete pagina, AI-crawlers parsen zonder JS uit te voeren.
 * Tokens komen 1-op-1 uit `apps/mobile/theme/tokens.ts` (nacht-rol).
 */
export const SEO_STYLES = `
  :root {
    color-scheme: dark;
    --bg: #0a0a0b;
    --bg-lift: #17171a;
    --bg-chip: #1f1f23;
    --fg: #f2f2ef;
    --fg-read: #c8c8c2;
    --fg-muted: #9a9a94;
    --fg-faint: #6a6a64;
    --acid: #d4ff3a;
    --flare: #ff4d2e;
    --border: #2a2a2d;
    --border-soft: #1d1d20;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--fg);
    font-family: 'Archivo', -apple-system, system-ui, sans-serif;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--acid); text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* Smart app banner — iOS toont 'm zelf via apple-itunes-app meta, dit
     is de fallback voor desktop + Android. */
  .banner {
    position: sticky; top: 0; z-index: 10;
    background: var(--bg-lift);
    border-bottom: 1px solid var(--border-soft);
    padding: 10px 18px;
    display: flex; align-items: center; gap: 10px;
    font-size: 13px;
  }
  /* Op mobile is de sticky-bottom-cta al de prominente actie; top-banner
     scrollt dan gewoon mee weg in plaats van plek af te snoepen. */
  @media (max-width: 899px) {
    .banner { position: static; }
  }
  .banner .brand {
    display: inline-flex; align-items: center; gap: 7px;
    flex-shrink: 0;
  }
  .banner .brand strong {
    color: var(--fg); font-weight: 800;
    font-size: 13px; letter-spacing: -0.1px;
    font-family: 'Archivo', sans-serif;
  }
  .banner .cross-mini {
    position: relative; width: 14px; height: 14px; flex-shrink: 0;
  }
  .banner .cross-mini::before, .banner .cross-mini::after {
    content: ""; position: absolute; top: 50%; left: 0;
    width: 100%; height: 3px; margin-top: -1.5px; background: var(--acid);
  }
  .banner .cross-mini::before { transform: rotate(45deg); }
  .banner .cross-mini::after { transform: rotate(-45deg); }
  .banner .label {
    flex: 1; color: var(--fg-muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    min-width: 0;
  }
  .banner a.open {
    background: var(--acid); color: var(--bg);
    padding: 6px 14px; border-radius: 999px;
    font-weight: 600; font-size: 12px;
    flex-shrink: 0;
  }
  .banner a.open:hover { text-decoration: none; opacity: 0.9; }

  main {
    max-width: 720px; margin: 0 auto; padding: 32px 22px 96px;
  }

  /* Mobile sticky CTA — alleen op smalle viewports zichtbaar. Op desktop
     staat de CTA in de aside (rechts, sticky), dus daar is deze overbodig. */
  .sticky-mobile-cta {
    position: fixed; bottom: 0; left: 0; right: 0;
    z-index: 100;
    display: flex; align-items: center; gap: 12px;
    padding: 12px 18px calc(12px + env(safe-area-inset-bottom)) 18px;
    background: rgba(10, 10, 11, 0.92);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border-top: 1px solid var(--border);
  }
  .sticky-mobile-cta .brand {
    display: inline-flex; align-items: center; gap: 7px;
    flex-shrink: 0;
  }
  .sticky-mobile-cta .brand strong {
    color: var(--fg); font-weight: 800;
    font-size: 14px; letter-spacing: -0.1px;
    font-family: 'Archivo', sans-serif;
  }
  .sticky-mobile-cta .cross-mini {
    position: relative; width: 16px; height: 16px; flex-shrink: 0;
  }
  .sticky-mobile-cta .cross-mini::before,
  .sticky-mobile-cta .cross-mini::after {
    content: ""; position: absolute; top: 50%; left: 0;
    width: 100%; height: 4px; margin-top: -2px; background: var(--acid);
  }
  .sticky-mobile-cta .cross-mini::before { transform: rotate(45deg); }
  .sticky-mobile-cta .cross-mini::after { transform: rotate(-45deg); }
  .sticky-mobile-cta .label {
    flex: 1; min-width: 0;
    color: var(--fg-muted); font-size: 13px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .sticky-mobile-cta a.open {
    background: var(--acid); color: var(--bg);
    padding: 10px 18px; border-radius: 999px;
    font-weight: 700; font-size: 13px;
    text-decoration: none;
    flex-shrink: 0;
  }
  .sticky-mobile-cta a.open:hover { opacity: 0.9; }
  /* Op desktop volledig verbergen — de aside-CTA neemt 't over. */
  @media (min-width: 900px) {
    .sticky-mobile-cta { display: none; }
  }
  /* Wanneer sticky-mobile-cta zichtbaar is, extra bottom-padding op main
     zodat de footer niet wordt afgedekt. Class-based ipv :has() voor
     bredere browser-support (Chrome iOS, oudere Android-Chrome). */
  @media (max-width: 899px) {
    body.has-sticky-cta main {
      padding-bottom: calc(96px + env(safe-area-inset-bottom));
    }
  }

  /* Kicker — kleine caps boven elke sectie of als breadcrumb. */
  .kicker {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 11px; letter-spacing: 1.6px; text-transform: uppercase;
    color: var(--acid);
    margin-bottom: 12px;
  }
  .breadcrumb {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 11px; letter-spacing: 1.4px; text-transform: uppercase;
    color: var(--fg-muted);
    margin: 0 0 12px;
  }
  .breadcrumb a { color: var(--fg-muted); }
  .breadcrumb a:hover { color: var(--acid); }
  .breadcrumb span { color: var(--fg-faint); margin: 0 6px; }

  /* Hero — image + title + lead paragraph (de antwoord-capsule). */
  .hero img {
    width: 100%; aspect-ratio: 16 / 9; object-fit: cover;
    border-radius: 14px; background: var(--bg-lift);
    margin-bottom: 6px;
  }
  /* Beeld-credit onder hero-foto — subtiele attributie rechts uitgelijnd,
     helpt zowel SEO/JSON-LD-koppeling als juridische lijn ("we hosten,
     niet bezitten"). */
  .hero .credit {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 10px; letter-spacing: 1.2px;
    text-transform: uppercase;
    color: var(--fg-faint);
    text-align: right;
    margin: 0 0 22px;
  }
  h1 {
    font-family: 'Archivo', sans-serif;
    font-weight: 900;
    font-size: clamp(32px, 6vw, 48px);
    line-height: 1.02;
    letter-spacing: -1.4px;
    margin: 0 0 16px;
    color: var(--fg);
  }
  .lead {
    font-size: 17px; line-height: 1.5;
    color: var(--fg-read);
    margin: 0 0 28px;
  }
  .lead strong { color: var(--fg); font-weight: 700; }

  /* Feiten-table — wordt door AI graag geparsed. */
  dl.facts {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 10px 24px;
    margin: 0 0 32px;
    padding: 20px 22px;
    background: var(--bg-lift);
    border-radius: 14px;
  }
  dl.facts dt {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 11px; letter-spacing: 1.2px; text-transform: uppercase;
    color: var(--fg-muted);
    padding-top: 3px;
  }
  dl.facts dd {
    margin: 0; color: var(--fg);
    font-size: 15px;
  }
  dl.facts dd a { color: var(--fg); border-bottom: 1px solid var(--border); }
  dl.facts dd a:hover { color: var(--acid); border-color: var(--acid); text-decoration: none; }

  h2 {
    font-family: 'Archivo', sans-serif;
    font-weight: 800;
    font-size: 22px;
    letter-spacing: -0.4px;
    margin: 40px 0 12px;
    color: var(--fg);
  }
  p { margin: 0 0 14px; color: var(--fg-read); font-size: 15px; }
  p a { color: var(--acid); border-bottom: 1px solid transparent; }
  p a:hover { border-color: var(--acid); text-decoration: none; }

  /* Tag-rij — series, genres, lineup. */
  .tags { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 24px; }
  .tag {
    display: inline-block;
    padding: 6px 12px;
    background: var(--bg-chip);
    color: var(--fg-muted);
    border-radius: 999px;
    font-size: 12px;
    letter-spacing: 0.2px;
  }
  .tag a { color: var(--fg); }
  .tag.accent { background: transparent; border: 1px solid var(--acid); color: var(--acid); }

  /* Lineup als compactere lijst. */
  ul.lineup { list-style: none; padding: 0; margin: 0 0 24px; }
  ul.lineup li {
    padding: 10px 0; border-bottom: 1px solid var(--border-soft);
    display: flex; justify-content: space-between; gap: 12px;
    color: var(--fg);
  }
  ul.lineup li:last-child { border-bottom: 0; }
  ul.lineup .role {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 11px; letter-spacing: 1px; text-transform: uppercase;
    color: var(--fg-muted);
  }

  /* Komende voorstellingen / upcoming events. */
  ul.occurrences, ul.upcoming {
    list-style: none; padding: 0; margin: 0 0 24px;
  }
  ul.occurrences li, ul.upcoming li {
    padding: 14px 0; border-bottom: 1px solid var(--border-soft);
    display: flex; justify-content: space-between; align-items: baseline; gap: 16px;
  }
  ul.occurrences li:last-child, ul.upcoming li:last-child { border-bottom: 0; }
  ul.occurrences .when, ul.upcoming .when {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 12px; letter-spacing: 0.6px;
    color: var(--fg-muted);
    flex-shrink: 0;
  }
  ul.occurrences .what, ul.upcoming .what { color: var(--fg); }
  ul.upcoming .what a { color: var(--fg); border-bottom: 1px solid var(--border); }
  ul.upcoming .what a:hover { color: var(--acid); border-color: var(--acid); text-decoration: none; }

  /* FAQ via <details> — semantisch én rich-snippet-vriendelijk. */
  details {
    border-bottom: 1px solid var(--border-soft);
    padding: 14px 0;
  }
  details summary {
    cursor: pointer; list-style: none;
    font-weight: 600; color: var(--fg);
    font-size: 15px;
    padding-right: 24px;
    position: relative;
  }
  details summary::-webkit-details-marker { display: none; }
  details summary::after {
    content: "+"; position: absolute; right: 0; top: 50%;
    transform: translateY(-50%);
    color: var(--acid); font-size: 18px;
  }
  details[open] summary::after { content: "−"; }
  details p { margin: 12px 0 4px; color: var(--fg-read); }

  /* CTA-blok onderaan. */
  .cta-card {
    margin: 40px 0 0;
    padding: 24px;
    background: var(--bg-lift);
    border-radius: 14px;
    text-align: center;
  }
  .cta-card .cross {
    position: relative; width: 32px; height: 32px;
    margin: 0 auto 14px;
  }
  .cta-card .cross::before, .cta-card .cross::after {
    content: ""; position: absolute; top: 50%; left: 0;
    width: 100%; height: 7px; margin-top: -3.5px; background: var(--acid);
  }
  .cta-card .cross::before { transform: rotate(45deg); }
  .cta-card .cross::after { transform: rotate(-45deg); }
  .cta-card h3 {
    font-family: 'Archivo', sans-serif;
    font-weight: 800; font-size: 20px;
    margin: 0 0 6px;
    letter-spacing: -0.3px;
    color: var(--fg);
  }
  .cta-card p {
    color: var(--fg-muted); font-size: 14px; margin: 0 0 18px;
  }
  .cta-card .actions {
    display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;
  }
  .cta-card a.primary {
    background: var(--acid); color: var(--bg);
    padding: 12px 22px; border-radius: 999px;
    font-weight: 700; font-size: 14px;
  }
  .cta-card a.primary:hover { opacity: 0.9; text-decoration: none; }
  /* Secondary store-buttons — een tint boven de card-achtergrond zodat ze
     leesbaar uitsteken, maar niet concurreren met de primary acid-knop. */
  .cta-card a.secondary {
    background: var(--bg-chip); color: var(--fg);
    padding: 12px 18px; border-radius: 999px;
    font-weight: 700; font-size: 14px;
  }
  .cta-card a.secondary:hover {
    background: var(--border); text-decoration: none;
  }

  /* QR-block: alleen zichtbaar op desktop (≥900px). Op die viewport
     vervangt de QR de "Open in ANDREAS"-knop — scannen-met-telefoon is
     dáár nuttig, een knop niet. Op tablet/mobile blijft de knop staan. */
  .cta-card .qr { display: none; }
  .cta-card .qr-hint { display: none; }
  @media (min-width: 900px) {
    .cta-card.with-qr a.primary { display: none; }
    .cta-card.with-qr .qr {
      display: block;
      width: 160px; height: 160px;
      margin: 0 auto 10px;
      padding: 12px;
      background: #fff;
      border-radius: 12px;
    }
    .cta-card.with-qr .qr svg {
      width: 100%; height: 100%; display: block;
    }
    .cta-card.with-qr .qr-hint {
      display: block;
      color: var(--fg-muted);
      font-size: 12px;
      margin: 0 0 14px;
    }
  }

  /* Footer — kleine print onder elke pagina. */
  footer.site {
    border-top: 1px solid var(--border-soft);
    margin-top: 64px; padding-top: 24px;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 11px; letter-spacing: 0.6px;
    color: var(--fg-faint);
    text-align: center;
  }
  footer.site a { color: var(--fg-muted); }
  footer.site a:hover { color: var(--acid); }

  @media (max-width: 540px) {
    main { padding: 24px 18px 64px; }
    h1 { font-size: 30px; letter-spacing: -1px; }
    dl.facts { grid-template-columns: 1fr; gap: 4px 0; padding: 16px 18px; }
    dl.facts dd { margin-bottom: 10px; }
    dl.facts dt { padding-top: 0; }
    ul.occurrences li, ul.upcoming li { flex-direction: column; gap: 4px; }
  }
`;

/** Font-preconnect + Archivo + JetBrains Mono. Wordt door alle SEO-pagina's geladen. */
export const FONTS_HEAD = `
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;700;800;900&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
`;

export type AppleAppMeta = {
  /** Numeric App Store ID (zonder 'id'-prefix). */
  appId: string;
  /** Deep-link argument zoals `andreas://event/abc`. */
  appArgument: string;
};

/**
 * Render het Smart-App-Banner blok bovenaan de pagina. iOS Safari toont
 * automatisch een eigen banner via `apple-itunes-app` meta — voor de
 * andere browsers tonen we deze sticky bar zodat de CTA altijd binnen
 * bereik blijft zonder de pagina af te kapen.
 */
export function renderAppBanner(deeplink: string, label: string): string {
  return `
    <div class="banner" role="banner">
      <span class="brand">
        <strong>ANDREAS</strong>
        <span class="cross-mini" aria-hidden="true"></span>
      </span>
      <span class="label">${escapeHtml(label)}</span>
      <a class="open" href="${escapeHtml(deeplink)}">Open in app</a>
    </div>
  `;
}

/**
 * Mobile-only sticky CTA-bar onderaan de viewport. De aside-CTA (rechts,
 * sticky) is desktop-only; op mobile is er geen plek voor een aside. Deze
 * bottom-bar zorgt dat de "open in app"-actie altijd binnen duim-bereik
 * blijft. Op desktop (>=900px) verborgen via `display: none`.
 *
 * Wordt onderaan in de `<body>` geplaatst, met `position: fixed`.
 */
export function renderMobileStickyCta(deeplink: string, label: string): string {
  return `
    <div class="sticky-mobile-cta" role="region" aria-label="Open in app">
      <span class="brand">
        <strong>ANDREAS</strong>
        <span class="cross-mini" aria-hidden="true"></span>
      </span>
      <span class="label">${escapeHtml(label)}</span>
      <a class="open" href="${escapeHtml(deeplink)}">Open</a>
    </div>
  `;
}

/**
 * Genereer een schaalbare SVG QR-code voor een URL. `errorCorrectionLevel: 'M'`
 * is de balans tussen densiteit en leesbaarheid; type 0 laat de lib zelf
 * de minimale grootte kiezen op basis van de data. `scalable: true` strips
 * de hardgecodeerde dimensies zodat we via CSS kunnen sizen.
 */
export function renderQrSvg(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ scalable: true, cellSize: 4, margin: 0 });
}

/**
 * Eind-CTA onderaan elke SEO-pagina. Met `qrUrl` toont de card op desktop
 * een QR-code i.p.v. de "Open in ANDREAS"-knop — scannen vanaf desktop
 * naar telefoon is de natuurlijke flow daar. Op tablet/mobile blijft de
 * knop staan (de QR is dan verborgen via CSS).
 */
export function renderCtaCard(opts: {
  deeplink: string;
  title: string;
  body: string;
  qrUrl?: string;
}): string {
  const qrBlock = opts.qrUrl
    ? `
        <div class="qr" aria-hidden="true">${renderQrSvg(opts.qrUrl)}</div>
        <p class="qr-hint">Scan met je telefoon</p>
      `
    : '';
  const cardClass = opts.qrUrl ? 'cta-card with-qr' : 'cta-card';
  return `
    <aside class="${cardClass}">
      <div class="cross" aria-hidden="true"></div>
      <h3>${escapeHtml(opts.title)}</h3>
      <p>${escapeHtml(opts.body)}</p>
      ${qrBlock}
      <div class="actions">
        <a class="primary" href="${escapeHtml(opts.deeplink)}">Open in ANDREAS</a>
        <a class="secondary" href="${escapeHtml(APP_STORE_URL)}">App Store</a>
        <a class="secondary" href="${escapeHtml(PLAY_STORE_URL)}">Google Play</a>
      </div>
    </aside>
  `;
}

/**
 * Bunny CDN ondersteunt image-transformatie via query params (`?width=N`).
 * Voor non-Bunny URLs (oude/externe imports) returnen we de URL onveranderd.
 * Vereist "Image Optimizer" feature aan op de Bunny pull-zone.
 */
function bunnyResize(url: string, width: number): string | null {
  if (!url.includes('b-cdn.net')) return null;
  try {
    const u = new URL(url);
    u.searchParams.set('width', String(width));
    u.searchParams.set('quality', '80');
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Render een 56×56-thumbnail (48×48 op mobile via CSS) met lazy-loading,
 * srcset voor retina, en een placeholder met acid-kruisje voor events
 * zonder eigen image. Geen CLS dankzij vaste width/height.
 *
 * Voor Bunny-gehoste images genereren we een 1x (96px) en 2x (192px)
 * variant — Bunny serveert die resized en cachet ze op de edge. Scheelt
 * ~70% data op mobile t.o.v. de full-res origineel.
 */
export function renderThumb(imageUrl: string | null, alt: string): string {
  if (!imageUrl) {
    return `<span class="thumb thumb-placeholder" aria-hidden="true"></span>`;
  }
  const src1x = bunnyResize(imageUrl, 96);
  const src2x = bunnyResize(imageUrl, 192);
  if (src1x && src2x) {
    return `<img class="thumb" src="${escapeHtml(src1x)}" srcset="${escapeHtml(src1x)} 1x, ${escapeHtml(src2x)} 2x" alt="${escapeHtml(alt)}" width="56" height="56" loading="lazy" decoding="async" />`;
  }
  // Fallback voor non-Bunny URLs: single src.
  return `<img class="thumb" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(alt)}" width="56" height="56" loading="lazy" decoding="async" />`;
}

/**
 * Render een hero-image met srcset voor responsive loading. Op desktop
 * (1080px main) heeft de hero ~1036px breedte; op mobile ~500px. We bieden
 * 800w/1200w/1600w varianten via Bunny voor scherpe weergave op retina-
 * displays zonder onnodige bytes op kleine schermen.
 */
export function renderHeroImage(imageUrl: string, alt: string): string {
  const w800 = bunnyResize(imageUrl, 800);
  const w1200 = bunnyResize(imageUrl, 1200);
  const w1600 = bunnyResize(imageUrl, 1600);
  if (w800 && w1200 && w1600) {
    return `<img src="${escapeHtml(w1200)}" srcset="${escapeHtml(w800)} 800w, ${escapeHtml(w1200)} 1200w, ${escapeHtml(w1600)} 1600w" sizes="(min-width: 900px) 1036px, 100vw" alt="${escapeHtml(alt)}" />`;
  }
  return `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(alt)}" />`;
}

/**
 * Bouwt de "venue · genre1, genre2" meta-regel onder een event-titel.
 * Maximaal 2 genres om de rij niet te overladen. Genres zijn keyword-context
 * voor Google en AI-engines ("techno", "drama", "klassiek") — ze versterken
 * long-tail ranking zonder de visuele hiërarchie te verstoren.
 */
export function renderEventMeta(venueName: string, genres: string[]): string {
  const parts = [escapeHtml(venueName)];
  if (genres.length > 0) {
    parts.push(escapeHtml(genres.slice(0, 2).join(', ')));
  }
  return parts.join(' · ');
}

/**
 * Gedeelde CSS voor de "lijn-lijst" component (homepage + hub-pagina's).
 * Wordt naast SEO_STYLES geïnjecteerd op pagina's die lijsten tonen.
 */
export const LIST_STYLES = `
  ul.lines { list-style: none; padding: 0; margin: 0 0 56px; }
  ul.lines li { border-bottom: 1px solid var(--border-soft); }
  ul.lines li:first-child { border-top: 1px solid var(--border-soft); }
  ul.lines .thumb {
    width: 56px; height: 56px;
    border-radius: 6px;
    background: var(--bg-lift);
    object-fit: cover;
    flex-shrink: 0;
    display: inline-block;
  }
  ul.lines .thumb-placeholder { position: relative; }
  ul.lines .thumb-placeholder::before,
  ul.lines .thumb-placeholder::after {
    content: ""; position: absolute; top: 50%; left: 22%;
    width: 56%; height: 5px; margin-top: -2.5px;
    background: var(--acid); opacity: 0.45;
  }
  ul.lines .thumb-placeholder::before { transform: rotate(45deg); }
  ul.lines .thumb-placeholder::after { transform: rotate(-45deg); }
  ul.lines a.row-link {
    display: flex; align-items: center; gap: 16px;
    padding: 14px 0;
    color: var(--fg); text-decoration: none;
    transition: color 120ms;
  }
  ul.lines a.row-link:hover { color: var(--acid); }
  ul.lines a.row-link:hover .meta { color: var(--acid); }
  ul.lines .row-text {
    display: flex; flex-direction: column; gap: 2px;
    flex: 1; min-width: 0;
  }
  ul.lines .row-text .when {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 10px; letter-spacing: 1.6px;
    text-transform: uppercase;
    color: var(--fg-muted);
  }
  ul.lines .row-text .title {
    font-weight: 600; font-size: 15px;
    letter-spacing: -0.1px;
    line-height: 1.25;
  }
  ul.lines .row-text .meta {
    color: var(--fg-muted); font-size: 13px;
    transition: color 120ms;
  }
  @media (max-width: 540px) {
    ul.lines .thumb { width: 48px; height: 48px; }
  }
`;

/**
 * Twee-koloms grid voor detail- en hub-pagina's. Hero/breadcrumb/footer
 * blijven full-width buiten de grid; events/venues-lijst + CTA-aside zitten
 * erin. Op iPad-portrait en kleiner (<900px) valt 't terug op single column
 * met de aside onder de main content — natuurlijke flow, geen JS nodig.
 *
 * Wordt op alle SEO-pagina's behalve de homepage geladen.
 */
export const PAGE_GRID_STYLES = `
  /* Bredere main voor 2-koloms layout; overschrijft de 720px-default uit
     SEO_STYLES. */
  main { max-width: 1080px; }
  .page-grid {
    display: grid;
    gap: 56px;
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: "main" "aside";
  }
  .page-main { grid-area: main; min-width: 0; }
  .page-aside { grid-area: aside; }
  .page-aside .cta-card { margin-top: 0; }
  @media (min-width: 900px) {
    .page-grid {
      grid-template-columns: minmax(0, 1fr) 300px;
      grid-template-areas: "main aside";
      gap: 48px;
    }
    .page-aside {
      position: sticky;
      top: 24px;
      align-self: start;
    }
  }
`;

/** Site-footer zoals op `/`. */
export function renderSiteFooter(): string {
  return `
    <footer class="site">
      <p>
        <a href="/">ANDREAS</a> · <a href="/privacy">Privacy</a> · <a href="/voorwaarden">Voorwaarden</a> · <a href="/auteursrecht">Auteursrecht</a><br/>
        Uitgaan in Amsterdam · ${new Date().getFullYear()}
      </p>
    </footer>
  `;
}

/**
 * Vol head-blok: charset, viewport, title, description, canonical,
 * OG, Twitter, apple-itunes-app, fonts, base CSS, en alle JSON-LD blokken.
 */
export function renderHead(opts: {
  title: string;
  description: string;
  canonicalPath: string;
  ogImage?: string | null;
  ogType?: 'website' | 'article' | 'event';
  apple?: AppleAppMeta;
  /** JSON-LD payloads (al gestringificeerd via `jsonLd()`). */
  jsonLdBlocks: string[];
  /**
   * Extra CSS die ná SEO_STYLES wordt geïnjecteerd. Gebruikt voor
   * page-grid layout (twee-koloms met aside) — `PAGE_GRID_STYLES`.
   */
  extraStyles?: string;
}): string {
  const canonical = `${PUBLIC_BASE_URL}${opts.canonicalPath}`;
  // OG-spec kent geen 'event'-type; valt terug op website/article. JSON-LD
  // doet het zware werk van event-typering, OG mag generiek blijven.
  const ogType = opts.ogType === 'event' ? 'article' : (opts.ogType ?? 'website');
  // Eigen image als die er is, anders de algemene ANDREAS-card. Voorkomt
  // lege thumbnails op iMessage/Slack/AI-citaties.
  const ogImageSrc = opts.ogImage || OG_IMAGE_URL;
  const ogImage = `<meta property="og:image" content="${escapeHtml(ogImageSrc)}" />
  <meta name="twitter:image" content="${escapeHtml(ogImageSrc)}" />`;
  const appleMeta = opts.apple
    ? `<meta name="apple-itunes-app" content="app-id=${escapeHtml(
        opts.apple.appId
      )}, app-argument=${escapeHtml(opts.apple.appArgument)}" />`
    : '';
  const ldBlocks = opts.jsonLdBlocks
    .map((b) => `<script type="application/ld+json">${b}</script>`)
    .join('\n  ');

  return `
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(opts.title)}</title>
  <meta name="description" content="${escapeHtml(opts.description)}" />
  <link rel="canonical" href="${escapeHtml(canonical)}" />
  <link rel="icon" type="image/png" sizes="16x16" href="${escapeHtml(PUBLIC_BASE_URL)}/favicon-16.png" />
  <link rel="icon" type="image/png" sizes="32x32" href="${escapeHtml(PUBLIC_BASE_URL)}/favicon-32.png" />
  <link rel="icon" type="image/png" sizes="48x48" href="${escapeHtml(PUBLIC_BASE_URL)}/favicon.png" />
  <link rel="apple-touch-icon" sizes="180x180" href="${escapeHtml(PUBLIC_BASE_URL)}/apple-touch-icon.png" />
  <meta name="theme-color" content="#0a0a0b" />
  <!-- Index + grote preview voor Google rich-results; noai signaleert
       AI-crawlers dat content niet voor training gebruikt mag worden. -->
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1" />
  <meta name="googlebot" content="index, follow, max-image-preview:large" />
  <meta name="ai-content-declaration" content="no-ai-training" />
  <meta property="og:type" content="${ogType}" />
  <meta property="og:site_name" content="ANDREAS" />
  <meta property="og:locale" content="nl_NL" />
  <meta property="og:title" content="${escapeHtml(opts.title)}" />
  <meta property="og:description" content="${escapeHtml(opts.description)}" />
  <meta property="og:url" content="${escapeHtml(canonical)}" />
  ${ogImage}
  <meta name="twitter:card" content="summary_large_image" />
  ${appleMeta}
  ${FONTS_HEAD}
  <style>${SEO_STYLES}${opts.extraStyles ? `\n${opts.extraStyles}` : ''}</style>
  ${ldBlocks}
  `;
}

/** Breadcrumb JSON-LD — geeft Google + AI's hiërarchie-context. */
export function breadcrumbJsonLd(
  items: Array<{ name: string; path: string }>
): string {
  return jsonLd({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: `${PUBLIC_BASE_URL}${item.path}`,
    })),
  });
}

/** FAQPage JSON-LD — triggert FAQ-rich-snippet én geeft AI's letterlijke Q/A-paren. */
export function faqJsonLd(
  qa: Array<{ question: string; answer: string }>
): string {
  return jsonLd({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: qa.map(({ question, answer }) => ({
      '@type': 'Question',
      name: question,
      acceptedAnswer: { '@type': 'Answer', text: answer },
    })),
  });
}
