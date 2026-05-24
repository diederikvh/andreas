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
  category: 'Muziek' | 'Theater' | 'Literatuur' | 'Film' | 'Kunst' | 'Lezing';
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
    case 'film': return 'Filmhuis';
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
 * Store-button styles (App Store / Google Play in card-vorm). Apart
 * exportbaar zodat homepage en CTA-cards op detail-pagina's exact
 * dezelfde stijl delen. Icon links in acid, kicker (mono uppercase) +
 * titel (Archivo black) eronder.
 */
export const STORE_BTN_STYLES = `
  .store-btn {
    flex: 1; min-width: 180px;
    display: inline-flex; align-items: center; gap: 14px;
    padding: 14px 18px;
    border-radius: 12px;
    background: var(--bg-lift);
    color: var(--fg);
    text-decoration: none;
    transition: background 120ms;
  }
  .store-btn:hover { background: var(--bg-chip); text-decoration: none; }
  .store-btn .store-icon {
    flex-shrink: 0;
    color: var(--acid);
  }
  .store-btn > div { min-width: 0; }
  .store-btn small {
    display: block;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 10px; letter-spacing: 1.2px; text-transform: uppercase;
    color: var(--acid);
    margin-bottom: 3px;
    font-weight: 600;
  }
  .store-btn span {
    font-weight: 800; font-size: 17px; letter-spacing: -0.2px;
    color: var(--fg);
  }
`;

/**
 * Icons voor de App Store + Google Play store-buttons. Geëxporteerd
 * zodat zowel renderCtaCard als de homepage hetzelfde SVG-pad gebruiken.
 */
export const APPLE_STORE_ICON = `<svg class="store-icon" width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09ZM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25Z"/></svg>`;
export const PLAY_STORE_ICON = `<svg class="store-icon" width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3.609 1.814 13.792 12 3.61 22.186a.996.996 0 0 1-.61-.92V2.734a1 1 0 0 1 .609-.92Zm10.89 10.893 2.302 2.302-10.937 6.333 8.635-8.635Zm3.199-3.198 2.807 1.626a1 1 0 0 1 0 1.73l-2.808 1.626L15.206 12l2.492-2.491ZM5.864 2.658 16.802 8.99l-2.303 2.303-8.635-8.635Z"/></svg>`;

/**
 * Header-styles (banner + dropdown-menu + saves-button + mobile). Apart
 * geëxporteerd zodat de homepage 'm naast z'n eigen inline styles kan
 * laden — die heeft geen renderHead/SEO_STYLES-stack. Wordt ook
 * geïnterpoleerd in SEO_STYLES voor de detail-pagina's.
 */
export const HEADER_STYLES = `
  /* Smart app banner / site-header. iOS toont z'n eigen native banner
     via apple-itunes-app meta; dit is de fallback voor desktop +
     Android, en tegelijk de globale navigatie van de site.
     Layout: links logo+label, rechts dropdown + "X bewaard" + "Open". */
  .banner {
    position: sticky; top: 0; z-index: 50;
    /* Frosted glass: dezelfde achtergrondkleur als de pagina, maar
       semi-transparant zodat content er onderdoor schuift met een
       blur erop. Voelt direct meer als product, minder als losse
       boven-balk. */
    background: rgba(10, 10, 11, 0.72);
    backdrop-filter: blur(14px) saturate(140%);
    -webkit-backdrop-filter: blur(14px) saturate(140%);
    border-bottom: 1px solid var(--border-soft);
    padding: 10px 18px;
    display: flex; align-items: center; gap: 10px;
    font-size: 13px;
  }
  /* Alle anchor-elementen in de header krijgen géén underline — het
     zijn buttons / nav-items, geen body-tekst. Defense-in-depth zodat
     'ie ook klopt op pagina's die SEO_STYLES niet inline laden
     (homepage heeft een eigen style-blok). */
  .banner a { text-decoration: none; }
  .banner a:hover { text-decoration: none; }
  .banner .brand {
    display: inline-flex; align-items: center; gap: 7px;
    flex-shrink: 0;
    color: var(--fg); text-decoration: none;
  }
  .banner .brand:hover { text-decoration: none; }
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
  /* Dropdown-menu (categorieën). Gebruikt <details> zodat 't werkt
     zonder JS. Op mobile valt 'm onder de "Browse"-knop, op desktop
     verschijnt 'ie rechts uitgelijnd vanaf de summary.

     Defensive resets: SEO_STYLES heeft een generieke "details {...}"
     en "details summary::after {...}" voor de FAQ. Die lekken anders
     door op de header-menu (border-bottom + padding 14px op de
     details-wrapper, en "+"-pseudo absoluut rechts op de summary). */
  .header-menu {
    position: relative;
    flex-shrink: 0;
    padding: 0;
    border: 0;
    border-bottom: 0;
    /* Wanneer .label er is, eet die met flex:1 alle ruimte op zodat
       margin-left:auto hier 0 ruimte heeft (header-menu zit dan dicht
       op label). Als .label op mobile verdwijnt (display:none), kickt
       margin-left:auto in en duwt header-menu (+ wat erna komt) naar
       rechts — saves + Open blijven rechts uitgelijnd. */
    margin-left: auto;
  }
  .header-menu > summary {
    list-style: none;
    cursor: pointer;
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 12px;
    border-radius: 999px;
    background: transparent;
    color: var(--fg);
    font-family: 'Archivo', sans-serif;
    font-weight: 600; font-size: 12px;
    position: static;
  }
  .header-menu > summary::-webkit-details-marker { display: none; }
  .header-menu > summary::after {
    content: "▾"; font-size: 10px; color: var(--fg-muted);
    transition: transform 160ms;
    /* Reset positie-leak van de FAQ "details summary::after"-regel
       die anders ▾ rechtsboven over de pagina trekt. */
    position: static;
    right: auto; top: auto;
    transform: none;
  }
  .header-menu[open] > summary::after { transform: rotate(180deg); }
  .header-menu .dropdown {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    min-width: 220px;
    background: var(--bg-lift);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 8px;
    box-shadow: 0 14px 32px rgba(0, 0, 0, 0.45);
    display: flex; flex-direction: column;
  }
  .header-menu .dropdown a {
    display: block;
    padding: 9px 12px;
    border-radius: 8px;
    color: var(--fg);
    font-family: 'Archivo', sans-serif;
    font-weight: 600; font-size: 14px;
    text-decoration: none;
    transition: background 120ms, color 120ms;
  }
  .header-menu .dropdown a:hover {
    background: var(--bg-chip);
    color: var(--acid);
    text-decoration: none;
  }
  .header-menu .dropdown hr {
    border: 0; border-top: 1px solid var(--border-soft);
    margin: 6px 4px;
  }
  .header-menu .dropdown .group-label {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 10px; letter-spacing: 1.4px; text-transform: uppercase;
    color: var(--fg-faint);
    padding: 10px 12px 4px;
  }
  /* Search-icon in de header. Klik opent een full-width floating
     search-bar net onder de banner (position: fixed). Zelfde <details>-
     truc als het Browse-menu zodat geen JS nodig is. */
  .header-search {
    position: static;
    flex-shrink: 0;
    padding: 0; border: 0; border-bottom: 0;
  }
  .header-search > summary {
    list-style: none;
    cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
    width: 30px; height: 30px;
    border-radius: 999px;
    background: transparent;
    color: var(--fg);
    transition: background 120ms, color 120ms;
    /* Defensive reset: SEO_STYLES "details summary {...}" zet padding-right:
       24px en position: relative — anders staat het search-icoon
       links-uit-midden en is de hover-cirkel niet centered. */
    position: static;
    padding: 0;
    font-size: 0;
  }
  .header-search > summary:hover { background: var(--bg-chip); color: var(--acid); }
  .header-search > summary::-webkit-details-marker { display: none; }
  .header-search > summary::after { content: none; }
  /* Generic "details[open] summary::after { content: '−' }" overrult mijn
     reset hierboven door gelijke specificity + latere cascade-volgorde.
     Met [open]+>summary maak ik 'm sterker. */
  .header-search[open] > summary::after { content: none; }
  .header-search[open] > summary { background: var(--bg-chip); color: var(--acid); }
  .header-search .search-floating {
    position: fixed;
    top: 56px;
    left: 12px;
    right: 12px;
    z-index: 60;
    background: var(--bg-lift);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 12px;
    box-shadow: 0 14px 32px rgba(0, 0, 0, 0.5);
  }
  .header-search .search-floating form {
    display: flex; gap: 8px;
  }
  .header-search .search-floating input[type="search"] {
    flex: 1; min-width: 0;
    padding: 12px 16px;
    background: var(--bg-chip);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--fg);
    font-family: 'Archivo', sans-serif;
    font-size: 15px;
    -webkit-appearance: none;
    appearance: none;
  }
  .header-search .search-floating input[type="search"]:focus {
    outline: none;
    border-color: var(--acid);
  }
  .header-search .search-floating input::placeholder { color: var(--fg-faint); }
  .header-search .search-floating button {
    display: inline-flex; align-items: center; justify-content: center;
    width: 48px; flex-shrink: 0;
    background: var(--acid); color: var(--bg);
    border: 0; border-radius: 8px;
    cursor: pointer;
    transition: opacity 120ms;
  }
  .header-search .search-floating button:hover { opacity: 0.88; }
  @media (min-width: 720px) {
    /* Op desktop floating-bar gecentreerd en gemaximeerd, niet
       full-width — past beter bij de bredere banner. */
    .header-search .search-floating {
      left: 50%;
      right: auto;
      transform: translateX(-50%);
      width: min(560px, calc(100vw - 24px));
    }
  }
  /* "X bewaard"-button in de header. Hidden tot er minimaal 1 save is
     (data-saves-visible). */
  .banner a.header-saves {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 12px;
    border-radius: 999px;
    background: var(--bg-chip);
    color: var(--fg);
    font-family: 'Archivo', sans-serif;
    font-weight: 600; font-size: 12px;
    flex-shrink: 0;
    transition: background 120ms;
  }
  .banner a.header-saves:hover {
    background: var(--border);
    text-decoration: none;
  }
  .banner a.header-saves svg { flex-shrink: 0; }
  .banner a.header-saves .header-saves-count {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 16px; height: 16px;
    padding: 0 5px;
    background: var(--acid); color: var(--bg);
    border-radius: 999px;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 10px; font-weight: 700;
  }
  /* Mobile: tekst-labels in de buttons inkorten zodat alles past op
     390px viewport. Label verbergen, dropdown-label naar "≡", saves-
     label weg. Dropdown wordt full-width (met side-margins) zodat 'ie
     niet rechts buiten beeld valt — anders rekent right:0 t.o.v. de
     summary-knop die zelf al ergens in 't midden zit. */
  @media (max-width: 600px) {
    .banner { padding: 8px 14px; gap: 8px; }
    .banner .label { display: none; }
    .header-menu > summary { padding: 6px 10px; font-size: 0; }
    .header-menu > summary::before {
      content: "Browse"; font-size: 12px;
    }
    .banner a.header-saves .header-saves-label { display: none; }
    .banner a.header-saves { padding: 6px 10px; }
    /* Dropdown vrijbreken uit de relative-parent zodat 'ie vol breed
       onder de header verschijnt, met margin links + rechts. */
    .header-menu .dropdown {
      position: fixed;
      top: calc(env(safe-area-inset-top) + 56px);
      left: 12px;
      right: 12px;
      min-width: 0;
      max-height: calc(100vh - 80px);
      overflow-y: auto;
    }
  }
`;

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

  ${HEADER_STYLES}
  ${STORE_BTN_STYLES}

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
  /* Naam zelf in normale fg-kleur — alleen subtiel hover-effect zodat
     de rij niet als acid-link-soup oogt in een lange line-up. */
  ul.lineup a {
    color: var(--fg); border-bottom: 1px solid var(--border);
    display: inline-flex; align-items: baseline; gap: 6px;
  }
  ul.lineup a:hover { color: var(--acid); border-color: var(--acid); text-decoration: none; }
  /* Chevron achter de naam: signaalt direct dat de naam doorklikt naar de
     artist-pagina. Acid-kleur zodat 't ondanks de subtielere onderlijn
     duidelijk eruit ziet als interactie. */
  ul.lineup a::after {
    content: "›";
    color: var(--acid);
    font-weight: 700;
    font-size: 14px;
    line-height: 1;
  }
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
  /* Secondary store-buttons — een tint boven de card-achtergrond zodat
     ze leesbaar uitsteken, maar niet concurreren met de primary acid-knop.
     Klein icoontje vooraan in acid-kleur (Apple/Play) zodat 't herkenbaar
     is, label blijft compact tekst. */
  .cta-card a.secondary {
    display: inline-flex; align-items: center; gap: 8px;
    background: var(--bg-chip); color: var(--fg);
    padding: 10px 16px; border-radius: 999px;
    font-weight: 700; font-size: 14px;
  }
  .cta-card a.secondary:hover {
    background: var(--border); text-decoration: none;
  }
  .cta-card a.secondary svg {
    color: var(--acid);
    flex-shrink: 0;
  }

  /* CTA-platforming. SAVES_LIB zet data-platform op <html>:
       desktop → toon QR, verberg primary "Open in ANDREAS"
       ios     → toon App Store + primary, verberg Play + QR
       android → toon Google Play + primary, verberg App Store + QR

     No-JS fallback (zonder data-platform): viewport-based — QR op
     ≥900px, beide store-buttons op kleinere schermen. */
  .cta-card .qr { display: none; }
  .cta-card .qr-hint { display: none; }
  .cta-card .qr-platforms { display: none; }
  /* Platform-row binnen de CTA-card (zichtbaar wanneer QR getoond wordt
     via desktop-platform of viewport-fallback). Icoontjes en label op
     eigen regel, beide gecentreerd. */
  .cta-card .qr-platforms {
    flex-direction: column;
    align-items: center;
    gap: 4px;
    margin: 0 0 8px;
  }
  .cta-card .qr-platforms-icons {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--acid);
  }
  .cta-card .qr-platforms-label {
    color: var(--fg-muted);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 10px; letter-spacing: 1.3px; text-transform: uppercase;
    text-align: center;
  }
  /* Viewport-fallback (no JS / unknown platform). */
  @media (min-width: 900px) {
    .cta-card.with-qr a.primary { display: none; }
    .cta-card.with-qr .qr {
      display: block;
      width: 160px; height: 160px;
      margin: 0 auto 20px;
      padding: 12px;
      background: #fff;
      border-radius: 12px;
    }
    .cta-card.with-qr .qr svg {
      width: 100%; height: 100%; display: block;
    }
    .cta-card.with-qr .qr-platforms {
      display: inline-flex;
    }
    .cta-card.with-qr .qr-hint {
      display: block;
      color: var(--fg);
      font-size: 14px;
      font-weight: 700;
      letter-spacing: -0.1px;
      margin: 0 0 18px;
    }
  }
  /* Platform-aware overrides — winnen door hogere specificity. */
  /* iOS: alleen App Store + open-app, verberg Play + QR (CTA-card). */
  html[data-platform="ios"] [data-cta="playstore"],
  html[data-platform="ios"] .cta-card.with-qr .qr,
  html[data-platform="ios"] .cta-card.with-qr .qr-hint {
    display: none;
  }
  html[data-platform="ios"] .cta-card.with-qr a[data-cta="open-app"] {
    display: inline-flex;
  }
  /* Android: alleen Google Play + open-app, verberg App Store + QR. */
  html[data-platform="android"] [data-cta="appstore"],
  html[data-platform="android"] .cta-card.with-qr .qr,
  html[data-platform="android"] .cta-card.with-qr .qr-hint {
    display: none;
  }
  html[data-platform="android"] .cta-card.with-qr a[data-cta="open-app"] {
    display: inline-flex;
  }
  /* Desktop: alleen QR, verberg alle store-buttons en open-app. */
  html[data-platform="desktop"] [data-cta="appstore"],
  html[data-platform="desktop"] [data-cta="playstore"],
  html[data-platform="desktop"] [data-cta="open-app"] {
    display: none;
  }
  html[data-platform="desktop"] .cta-card.with-qr .qr {
    display: block;
    width: 160px; height: 160px;
    margin: 0 auto 20px;
    padding: 12px;
    background: #fff;
    border-radius: 12px;
  }
  html[data-platform="desktop"] .cta-card.with-qr .qr svg {
    width: 100%; height: 100%; display: block;
  }
  html[data-platform="desktop"] .cta-card.with-qr .qr-platforms {
    display: inline-flex;
  }
  html[data-platform="desktop"] .cta-card.with-qr .qr-hint {
    display: block;
    color: var(--fg);
    font-size: 14px;
    font-weight: 700;
    letter-spacing: -0.1px;
    margin: 0 0 18px;
  }

  /* Hero-actions: actie-rij voor events zonder eigen foto. Save +
     later eventueel andere buttons (share, ICS). */
  .hero-actions {
    display: flex; flex-wrap: wrap; gap: 8px;
    margin: 0 0 18px;
  }
  /* Hero-image-wrap: positioned container voor de save+share-overlay
     rechtsboven op de event-foto. */
  .hero-image-wrap {
    position: relative;
    margin-bottom: 6px;
  }
  /* Overlay-rij met save + share rechtsboven over de foto. */
  .hero-overlay-actions {
    position: absolute;
    top: 14px; right: 14px;
    z-index: 5;
    display: flex; gap: 8px;
  }
  /* Save/share-buttons in de overlay: stevig translucent + blur zodat
     de tekst leesbaar blijft op elke foto-achtergrond. Geen shadow:
     blur + acid hover doen het werk al, schaduw maakt 't zwaar. */
  .hero-overlay-actions .save-btn {
    background: rgba(10, 10, 11, 0.42);
    backdrop-filter: blur(18px) saturate(160%);
    -webkit-backdrop-filter: blur(18px) saturate(160%);
    border-color: rgba(255, 255, 255, 0.15);
    color: var(--fg);
  }
  .hero-overlay-actions .save-btn:hover {
    background: rgba(10, 10, 11, 0.6);
    border-color: rgba(255, 255, 255, 0.25);
  }
  /* In "bewaard"-state acid-bg blijft acid (overschrijft de translucent
     bg) zodat de bevestiging duidelijk is. */
  /* Save-button (op event-detail) — strakke pill met bookmark-icon.
     "Bewaard"-state krijgt acid-bg om de actie te bevestigen. */
  .save-btn {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 10px 16px;
    border: 1px solid var(--border);
    background: var(--bg-lift);
    color: var(--fg);
    border-radius: 999px;
    font-family: 'Archivo', sans-serif;
    font-weight: 600;
    font-size: 13px;
    letter-spacing: -0.1px;
    cursor: pointer;
    transition: background 120ms, color 120ms, border-color 120ms;
  }
  .save-btn:hover {
    background: var(--bg-chip);
    border-color: var(--fg-muted);
  }
  /* Bewaard-state: geen acid-bg + "Bewaard ✓"-tekst meer. Gewoon een
     geel-gekleurde bladwijzer als visueel signaal, label verborgen
     zodat 't compact blijft. */
  .save-btn[data-saved="true"] {
    color: var(--acid);
  }
  .save-btn[data-saved="true"] .save-label { display: none; }
  .save-btn .save-icon { display: inline-flex; flex-shrink: 0; }
  .save-btn .save-icon svg { display: block; }
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
 * Globale site-header / smart-app-banner. iOS Safari toont z'n eigen
 * native banner via `apple-itunes-app` meta — voor de andere browsers
 * (en op alle pagina's binnen onze app, inclusief homepage) tonen we
 * deze sticky bar zodat brand, dropdown-navigatie, "X bewaard" en
 * "Open in app" altijd binnen bereik zijn.
 *
 * Layout van links naar rechts:
 *   - brand (logo + ANDREAS-cross), klikbaar naar /
 *   - label (subtle, mid)
 *   - dropdown (Browse ▾)  — categorieën in een details/summary
 *   - X bewaard            — alleen zichtbaar als saves > 0
 *   - Open in app          — primary CTA
 */
export function renderAppBanner(deeplink: string, label: string): string {
  return `
    <div class="banner" role="banner">
      <a class="brand" href="/">
        <strong>ANDREAS</strong>
        <span class="cross-mini" aria-hidden="true"></span>
      </a>
      <span class="label">${escapeHtml(label)}</span>
      <details class="header-menu">
        <summary>Browse</summary>
        <div class="dropdown" role="menu">
          <span class="group-label">Wanneer</span>
          <a href="/vandaag">Vandaag</a>
          <a href="/dit-weekend">Dit weekend</a>
          <hr>
          <span class="group-label">Categorieën</span>
          <a href="/muziek">Muziek</a>
          <a href="/artists">Artists</a>
          <a href="/theater">Theater</a>
          <a href="/film">Film</a>
          <a href="/kunst">Kunst</a>
          <a href="/literatuur">Literatuur</a>
          <hr>
          <span class="group-label">Venues</span>
          <a href="/clubs">Clubs</a>
          <a href="/podia">Podia</a>
          <a href="/musea">Musea</a>
          <a href="/galeries">Galeries</a>
          <a href="/filmhuizen">Filmhuizen</a>
        </div>
      </details>
      <details class="header-search">
        <summary aria-label="Zoeken">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
        </summary>
        <div class="search-floating">
          <form action="/zoeken" method="get" role="search">
            <input
              type="search"
              name="q"
              placeholder="Zoek een venue, artist of event…"
              autocomplete="off"
              aria-label="Zoeken op andreas.amsterdam"
            />
            <button type="submit" aria-label="Zoeken">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
            </button>
          </form>
        </div>
      </details>
      <a class="header-saves" href="/mijn-lijst" data-saves-visible style="display:none">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21 12 16l-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z"/></svg>
        <span class="header-saves-label">Bewaard</span>
        <span class="header-saves-count" data-saves-count>0</span>
      </a>
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
        <span class="qr-platforms" aria-hidden="true">
          <span class="qr-platforms-icons">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09ZM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25Z"/></svg>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M17.523 15.34a1.13 1.13 0 1 1 1.131-1.13 1.13 1.13 0 0 1-1.131 1.13Zm-11.06 0a1.13 1.13 0 1 1 1.131-1.13 1.13 1.13 0 0 1-1.131 1.13Zm11.46-6.16 2.26-3.91a.47.47 0 0 0-.81-.47l-2.29 3.96a14.06 14.06 0 0 0-11.18 0L3.62 4.8a.47.47 0 1 0-.81.47l2.26 3.91A13.06 13.06 0 0 0 0 17.66h24a13.06 13.06 0 0 0-5.077-8.48Z"/></svg>
          </span>
          <span class="qr-platforms-label">Beschikbaar voor iPhone en Android</span>
        </span>
        <p class="qr-hint">Scan om ANDREAS te downloaden</p>
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
        <a class="primary" data-cta="open-app" href="${escapeHtml(opts.deeplink)}">Open in ANDREAS</a>
        <a class="secondary" data-cta="appstore" href="${escapeHtml(APP_STORE_URL)}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09ZM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25Z"/></svg>
          App Store
        </a>
        <a class="secondary" data-cta="playstore" href="${escapeHtml(PLAY_STORE_URL)}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3.609 1.814 13.792 12 3.61 22.186a.996.996 0 0 1-.61-.92V2.734a1 1 0 0 1 .609-.92Zm10.89 10.893 2.302 2.302-10.937 6.333 8.635-8.635Zm3.199-3.198 2.807 1.626a1 1 0 0 1 0 1.73l-2.808 1.626L15.206 12l2.492-2.491ZM5.864 2.658 16.802 8.99l-2.303 2.303-8.635-8.635Z"/></svg>
          Google Play
        </a>
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
 * Render een 16:9 image-block voor in een featured-card. Twee Bunny-
 * varianten (1x/2x) zorgen voor scherp beeld op retina zonder bytes te
 * verspillen op standard-dpi. Voor cards zonder image: placeholder-vlak
 * met een transparant kruisje.
 */
export function renderCardImage(imageUrl: string | null, alt: string): string {
  if (!imageUrl) {
    return `<span class="card-img card-img-placeholder" aria-hidden="true"></span>`;
  }
  const src1x = bunnyResize(imageUrl, 640);
  const src2x = bunnyResize(imageUrl, 1280);
  if (src1x && src2x) {
    return `<img class="card-img" src="${escapeHtml(src1x)}" srcset="${escapeHtml(src1x)} 1x, ${escapeHtml(src2x)} 2x" alt="${escapeHtml(alt)}" loading="lazy" decoding="async" />`;
  }
  return `<img class="card-img" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async" />`;
}

/**
 * Featured-card: groter, magazine-stijl alternatief voor de compacte
 * `ul.lines` row. Gebruikt voor de eerste 2 items van een sectie
 * (homepage, venue, artist, event-related) zodat de pagina niet als
 * platte data-feed leest. Hover-lift signaalt interactie zonder JS.
 *
 * Caller geeft `href`, `imageUrl`, `when` (label boven titel, mono caps),
 * `title`, `meta` (venue + genre regel onder). De wrapper-component is
 * verantwoordelijk voor de `featured-grid`-container (2-koloms op desktop,
 * 1-koloms mobile).
 */
export function renderFeaturedCard(opts: {
  href: string;
  imageUrl: string | null;
  when: string;
  title: string;
  meta: string;
}): string {
  return `<a class="featured-card" href="${escapeHtml(opts.href)}">
    <span class="card-img-wrap">${renderCardImage(opts.imageUrl, opts.title)}</span>
    <span class="card-body">
      <span class="card-when">${escapeHtml(opts.when)}</span>
      <span class="card-title">${escapeHtml(opts.title)}</span>
      <span class="card-meta">${escapeHtml(opts.meta)}</span>
    </span>
  </a>`;
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
 * Gedeelde CSS voor de "lijn-lijst" component + featured-cards. Beide
 * naast SEO_STYLES geïnjecteerd op pagina's die lijsten tonen.
 *
 * Listing → row-link met 96px thumb (was 56) + subtle hover-lift.
 * Magazine → featured-card met 16:9 image en titel-blok eronder.
 *
 * Doel: minder "scraped data feed" en meer "echte website". De rij-
 * layout met grotere thumb voelt al meteen kalmer; de featured-cards
 * bovenaan elke sectie geven het magazine-gevoel.
 */
export const LIST_STYLES = `
  ul.lines { list-style: none; padding: 0; margin: 0 0 56px; }
  ul.lines li { border-bottom: 1px solid var(--border-soft); }
  ul.lines li:first-child { border-top: 1px solid var(--border-soft); }
  ul.lines .thumb {
    width: 96px; height: 96px;
    border-radius: 8px;
    background: var(--bg-lift);
    object-fit: cover;
    flex-shrink: 0;
    display: inline-block;
  }
  ul.lines .thumb-placeholder { position: relative; }
  ul.lines .thumb-placeholder::before,
  ul.lines .thumb-placeholder::after {
    content: ""; position: absolute; top: 50%; left: 22%;
    width: 56%; height: 8px; margin-top: -4px;
    background: var(--acid); opacity: 0.45;
  }
  ul.lines .thumb-placeholder::before { transform: rotate(45deg); }
  ul.lines .thumb-placeholder::after { transform: rotate(-45deg); }
  ul.lines a.row-link {
    display: flex; align-items: center; gap: 18px;
    padding: 14px 0;
    color: var(--fg); text-decoration: none;
    transition: color 120ms, transform 200ms;
  }
  ul.lines a.row-link:hover { color: var(--acid); transform: translateX(2px); }
  ul.lines a.row-link:hover .meta { color: var(--acid); }
  ul.lines .row-text {
    display: flex; flex-direction: column; gap: 4px;
    flex: 1; min-width: 0;
  }
  ul.lines .row-text .when {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 10px; letter-spacing: 1.6px;
    text-transform: uppercase;
    color: var(--fg-muted);
  }
  ul.lines .row-text .title {
    font-weight: 700; font-size: 16px;
    letter-spacing: -0.2px;
    line-height: 1.25;
  }
  ul.lines .row-text .meta {
    color: var(--fg-muted); font-size: 13px;
    transition: color 120ms;
  }
  @media (max-width: 540px) {
    ul.lines .thumb { width: 80px; height: 80px; }
    ul.lines a.row-link { gap: 14px; }
    ul.lines .row-text .title { font-size: 15px; }
  }

  /* ---------- Featured-cards (magazine-stijl, eerste 2 items) ---------- */
  .featured-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 16px;
    margin: 0 0 24px;
  }
  @media (min-width: 640px) {
    .featured-grid { grid-template-columns: 1fr 1fr; gap: 20px; }
  }
  .featured-card {
    display: flex; flex-direction: column;
    background: var(--bg-lift);
    border-radius: 14px;
    overflow: hidden;
    color: var(--fg);
    text-decoration: none;
    transition: transform 220ms, box-shadow 220ms;
  }
  .featured-card:hover {
    transform: translateY(-3px);
    box-shadow: 0 14px 32px rgba(0, 0, 0, 0.45);
    text-decoration: none;
  }
  .featured-card .card-img-wrap {
    display: block;
    aspect-ratio: 16 / 9;
    background: var(--bg);
    overflow: hidden;
    position: relative;
  }
  .featured-card .card-img {
    width: 100%; height: 100%;
    object-fit: cover;
    display: block;
    transition: transform 480ms;
  }
  .featured-card:hover .card-img { transform: scale(1.04); }
  .featured-card .card-img-placeholder {
    width: 100%; height: 100%;
    display: block; position: relative;
  }
  .featured-card .card-img-placeholder::before,
  .featured-card .card-img-placeholder::after {
    content: ""; position: absolute; top: 50%; left: 28%;
    width: 44%; height: 14px; margin-top: -7px;
    background: var(--acid); opacity: 0.35;
  }
  .featured-card .card-img-placeholder::before { transform: rotate(45deg); }
  .featured-card .card-img-placeholder::after { transform: rotate(-45deg); }
  .featured-card .card-body {
    display: flex; flex-direction: column; gap: 4px;
    padding: 16px 20px 20px;
  }
  .featured-card .card-when {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 11px; letter-spacing: 1.4px;
    text-transform: uppercase;
    color: var(--acid);
  }
  .featured-card .card-title {
    font-family: 'Archivo', sans-serif;
    font-weight: 800;
    font-size: 18px;
    line-height: 1.2;
    letter-spacing: -0.3px;
    color: var(--fg);
  }
  .featured-card .card-meta {
    color: var(--fg-muted);
    font-size: 13px;
    margin-top: 2px;
  }

  /* ---------- Venue-cards (4-col grid, 1:1 image bovenaan) ---------- */
  .venues-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 14px;
    margin: 0 0 24px;
  }
  @media (min-width: 540px) {
    .venues-grid { grid-template-columns: 1fr 1fr; }
  }
  @media (min-width: 900px) {
    .venues-grid { grid-template-columns: repeat(4, 1fr); gap: 16px; }
  }
  .venue-card {
    display: flex; flex-direction: column;
    background: var(--bg-lift);
    border-radius: 12px;
    overflow: hidden;
    color: var(--fg);
    text-decoration: none;
    transition: transform 220ms, box-shadow 220ms;
  }
  .venue-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
    text-decoration: none;
  }
  .venue-card-img-wrap {
    display: block;
    aspect-ratio: 1 / 1;
    background: var(--bg);
    overflow: hidden;
    position: relative;
  }
  .venue-card-img {
    width: 100%; height: 100%;
    object-fit: cover;
    display: block;
    transition: transform 480ms;
  }
  .venue-card:hover .venue-card-img { transform: scale(1.04); }
  .venue-card-img-placeholder {
    width: 100%; height: 100%;
    display: block; position: relative;
  }
  .venue-card-img-placeholder::before,
  .venue-card-img-placeholder::after {
    content: ""; position: absolute; top: 50%; left: 28%;
    width: 44%; height: 10px; margin-top: -5px;
    background: var(--acid); opacity: 0.35;
  }
  .venue-card-img-placeholder::before { transform: rotate(45deg); }
  .venue-card-img-placeholder::after { transform: rotate(-45deg); }
  .venue-card-body {
    display: flex; flex-direction: column; gap: 2px;
    padding: 10px 12px 14px;
  }
  .venue-card-title {
    font-family: 'Archivo', sans-serif;
    font-weight: 700;
    font-size: 14px;
    letter-spacing: -0.2px;
    line-height: 1.2;
    color: var(--fg);
  }
  .venue-card-meta {
    color: var(--fg-muted);
    font-size: 11px;
    letter-spacing: 0.2px;
    margin-top: 2px;
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
      /* Sticky-aside komt onder de sticky topmenu (~48px hoog) met
         een ademruimte van 20px ertussen. Anders schuift de CTA-card
         onder de header langs en raakt 'm onleesbaar afgesneden. */
      top: 68px;
      align-self: start;
    }
  }
`;

/**
 * Save-zonder-login: kleine zelfstandige JS die in localStorage
 * bewaard welke events de bezoeker als "voor later" heeft gemarkeerd.
 * Geen login, geen backend-roundtrip. Snapshot (titel + venue + datum
 * + image) wordt mee-opgeslagen zodat /mijn-lijst direct kan renderen
 * zonder nog een fetch te doen.
 *
 * Wordt op alle SEO-pagina's geladen — `renderSaveButton()` op event-
 * detail rendert dan de button die deze API aanspreekt. Op /mijn-lijst
 * leest de pagina-script `window.andreasSaves.list()` en bouwt de UI.
 *
 * Versie-prefix `v1` zodat we later de storage-shape kunnen wijzigen
 * zonder oude data te corrumperen.
 */
export const SAVES_LIB = `
  (function () {
    var KEY = 'andreas:saves:v1';
    function read() {
      try { return JSON.parse(localStorage.getItem(KEY) || '[]'); }
      catch (e) { return []; }
    }
    function write(list) {
      try { localStorage.setItem(KEY, JSON.stringify(list)); }
      catch (e) {}
      subs.forEach(function (cb) { try { cb(list); } catch (e) {} });
    }
    var subs = [];
    window.andreasSaves = {
      list: function () { return read(); },
      count: function () { return read().length; },
      has: function (id) { return read().some(function (s) { return s.id === id; }); },
      toggle: function (snap) {
        var list = read();
        var i = list.findIndex(function (s) { return s.id === snap.id; });
        if (i >= 0) { list.splice(i, 1); }
        else { list.unshift(Object.assign({}, snap, { savedAt: Date.now() })); }
        write(list);
        return i < 0;
      },
      remove: function (id) {
        var list = read().filter(function (s) { return s.id !== id; });
        write(list);
      },
      subscribe: function (cb) { subs.push(cb); cb(read()); },
    };
    // Platform-detectie: zet data-platform op <html> zodat CSS de juiste
    // CTA-buttons kan tonen (iOS → App Store, Android → Google Play,
    // anders → desktop met QR). Doe dit zo vroeg mogelijk in de IIFE
    // zodat er geen flash van verkeerde knoppen is.
    (function () {
      var ua = navigator.userAgent || '';
      var platform = 'desktop';
      if (/iPad|iPhone|iPod/.test(ua) && !window.MSStream) platform = 'ios';
      else if (/Android/.test(ua)) platform = 'android';
      document.documentElement.setAttribute('data-platform', platform);
    })();

    // Sluit header-dropdowns (Browse + search) zodra de gebruiker
    // buiten de open <details> klikt — standaard sluit <details>
    // alleen bij klik op z'n eigen summary. Werkt voor alle elementen
    // met klasse "header-menu" of "header-search" die open zijn.
    document.addEventListener('click', function (e) {
      var openDetails = document.querySelectorAll(
        'details.header-menu[open], details.header-search[open]'
      );
      openDetails.forEach(function (det) {
        if (!det.contains(e.target)) det.removeAttribute('open');
      });
    });

    // Header-badge: alle elementen met data-saves-count krijgen de count.
    // Elementen met data-saves-visible (zoals de hele pill-wrapper)
    // worden enkel getoond/verborgen op basis van count.
    function syncBadges(list) {
      var n = list.length;
      document.querySelectorAll('[data-saves-count]').forEach(function (el) {
        el.textContent = String(n);
      });
      document.querySelectorAll('[data-saves-visible]').forEach(function (el) {
        el.style.display = n > 0 ? '' : 'none';
      });
    }
    window.andreasSaves.subscribe(syncBadges);
  })();
`;

/**
 * Render een save-button voor de event-detail-pagina. De button heeft
 * een snapshot-payload in data-attribuut; de save-script (via SAVES_LIB)
 * leest die op click en zet 'm in localStorage.
 *
 * State (bewaard ja/nee) wordt client-side op DOM-load gezet door het
 * begeleidende SAVE_BUTTON_SCRIPT-blok.
 */
/**
 * Render een deel-knop met dezelfde pill-stijl als de save-knop.
 * Klik triggert navigator.share() (native share-sheet op iOS/Android),
 * met clipboard-fallback op desktop. Event-data zit in data-share-*
 * attributen die SAVE_BUTTON_SCRIPT uitleest.
 */
export function renderShareButton(opts: {
  title: string;
  url: string;
  text?: string;
}): string {
  return `<button class="save-btn share-btn" type="button"
    data-share-url="${escapeHtml(opts.url)}"
    data-share-title="${escapeHtml(opts.title)}"
    data-share-text="${escapeHtml(opts.text ?? '')}">
    <span class="save-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
    </span>
    <span class="share-label">Delen</span>
  </button>`;
}

export function renderSaveButton(opts: {
  id: string;
  title: string;
  venueName: string;
  startsAt?: string | null;
  imageUrl?: string | null;
}): string {
  const snap = {
    id: opts.id,
    title: opts.title,
    venue: opts.venueName,
    startsAt: opts.startsAt ?? null,
    imageUrl: opts.imageUrl ?? null,
    url: `/e/${opts.id}`,
  };
  const json = JSON.stringify(snap)
    .replace(/'/g, '&#39;')
    .replace(/"/g, '&quot;');
  return `<button class="save-btn" type="button" data-save-snap="${json}">
    <span class="save-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21 12 16l-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z"/></svg>
    </span>
    <span class="save-label">Bewaar voor later</span>
  </button>`;
}

/**
 * Inline script dat na DOM-load alle save-btn elementen initialiseert:
 *   - kijkt of 't event al in localStorage zit → kleurt knop "bewaard"
 *   - hangt click-handler die toggled en label/state bijwerkt
 *
 * Wordt alleen geladen op pagina's met een save-button (event-detail).
 */
export const SAVE_BUTTON_SCRIPT = `
  (function () {
    function decode(s) {
      var d = document.createElement('div');
      d.innerHTML = s;
      return d.textContent || '';
    }
    function applyState(btn, saved) {
      btn.dataset.saved = saved ? 'true' : 'false';
    }
    document.querySelectorAll('.save-btn').forEach(function (btn) {
      var raw = btn.getAttribute('data-save-snap');
      if (!raw) return;
      var snap;
      try { snap = JSON.parse(decode(raw)); } catch (e) { return; }
      applyState(btn, window.andreasSaves.has(snap.id));
      btn.addEventListener('click', function () {
        var nowSaved = window.andreasSaves.toggle(snap);
        applyState(btn, nowSaved);
      });
    });

    // Share-button: navigator.share (native) waar beschikbaar (vooral
    // mobile Safari/Chrome), anders clipboard met "Gekopieerd!" als
    // korte feedback. Beide paden zijn no-op-veilig.
    document.querySelectorAll('.share-btn').forEach(function (btn) {
      var url = btn.getAttribute('data-share-url') || window.location.href;
      var title = btn.getAttribute('data-share-title') || document.title;
      var text = btn.getAttribute('data-share-text') || '';
      var label = btn.querySelector('.share-label');
      var defaultText = label ? label.textContent : '';
      btn.addEventListener('click', function () {
        if (navigator.share) {
          navigator.share({ title: title, text: text, url: url })
            .catch(function () {});
          return;
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(function () {
            if (!label) return;
            label.textContent = 'Gekopieerd ✓';
            setTimeout(function () { label.textContent = defaultText; }, 1800);
          });
        }
      });
    });
  })();
`;

/**
 * Auto-focus het zoekveld zodra de bezoeker op het search-icoon klikt.
 * <details> heeft geen ingebouwde focus-trigger op toggle, dus dit
 * kleine snippet hangt een toggle-listener op de header-search en
 * focust het input zodra `open` true wordt.
 */
const SEARCH_FOCUS_SCRIPT = `
  (function () {
    var det = document.querySelector('.header-search');
    if (!det) return;
    det.addEventListener('toggle', function () {
      if (!det.open) return;
      var inp = det.querySelector('input[type="search"]');
      if (inp) inp.focus();
    });
  })();
`;

/**
 * Bundel van body-end scripts: localStorage saves-lib (altijd),
 * search-focus (altijd, no-op als de search-knop niet op de pagina
 * staat) + optioneel het save-button-init script (alleen op
 * event-detail). "Mijn lijst (X)"-button zit niet meer als losse
 * pill — die is geïntegreerd in renderAppBanner (header) en wordt
 * door SAVES_LIB zichtbaar/onzichtbaar gemaakt via data-saves-visible.
 */
export function renderSiteScripts(opts: { withSaveButton?: boolean } = {}): string {
  const scripts = [SAVES_LIB, SEARCH_FOCUS_SCRIPT];
  if (opts.withSaveButton) scripts.push(SAVE_BUTTON_SCRIPT);
  return scripts.map((s) => `<script>${s}</script>`).join('\n  ');
}

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
