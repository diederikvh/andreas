import type { FC, PropsWithChildren } from 'hono/jsx';

/**
 * De menu-indeling.
 *
 * Stond hier als tien losse `<li>`-blokken op één rij, en dat werd een
 * stapel: elke nieuwe pagina plakte er weer een knop achteraan, allemaal
 * even zwaar, zonder dat je kon zien wat bij wat hoort. Nu drie groepen met
 * een streepje ertussen, en als lijst in plaats van als markup — een pagina
 * toevoegen is één regel op de juiste plek, en die plek dwingt je een groep
 * te kiezen.
 *
 * De groepen volgen de vraag die je stelt, niet hoe vaak je er bent:
 * **aanbod** is de catalogus zoals hij nu is, **binnenkomst** is alles wat
 * er nieuw in wil, en de rest kijkt ernaar of stuurt het naar buiten.
 *
 * Overzicht zit niet in de rij: dat is de merknaam links, zoals overal.
 */
const NAV: { key: string; href: string; label: string }[][] = [
  [
    { key: 'events', href: '/admin/events', label: 'Events' },
    { key: 'venues', href: '/admin/venues', label: 'Venues' },
    { key: 'series', href: '/admin/series', label: 'Series' },
  ],
  [
    { key: 'import', href: '/admin/import', label: 'Import' },
    { key: 'aanmeldingen', href: '/admin/aanmeldingen', label: 'Aanmeldingen' },
    { key: 'trefwoorden', href: '/admin/trefwoorden', label: 'Trefwoorden' },
  ],
  [
    { key: 'insights', href: '/admin/insights', label: 'Insights' },
    { key: 'users', href: '/admin/users', label: 'Gebruikers' },
    { key: 'social', href: '/admin/social', label: 'Social' },
  ],
];

/**
 * Gedeelde HTML-shell voor alle admin-pagina's. Pico.css via CDN —
 * geen bundler, geen build-stap. Dark mode via `data-theme="dark"`
 * past bij Andreas-noir.
 */
export const Layout: FC<PropsWithChildren<{ title: string; active?: string }>> = ({
  title,
  active,
  children,
}) => (
  <html lang="nl" data-theme="light">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title} · Andreas admin</title>
      <link
        rel="stylesheet"
        href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css"
      />
      <style>{`
        /* Andreas dag-mode: cream/paper canvas, noir tekst, acid accent. */
        :root {
          --pico-font-size: 15px;
          --pico-primary: #0a0a0b;
          --pico-primary-hover: #2a2a2d;
          --pico-primary-focus: rgba(212, 255, 58, 0.35);
          --pico-primary-inverse: #fff;
          --andreas-acid: #d4ff3a;
        }
        html { background: #efebe0; min-height: 100%; }
        body {
          max-width: 1100px;
          margin: 2rem auto 4rem;
          padding: 1.5rem 2rem 3rem;
          background: #fdfaf2;
          border: 1px solid #d8d2c2;
          border-radius: 12px;
          color: #0a0a0b;
        }
        nav { margin-bottom: 1.75rem; align-items: center; gap: 0.5rem; }
        nav .brand {
          font-family: Georgia, "Times New Roman", serif;
          font-size: 1.35rem;
          font-weight: 700;
          letter-spacing: -0.02em;
          color: var(--pico-h2-color);
        }
        nav .brand small {
          font-family: var(--pico-font-family);
          font-weight: 400;
          font-size: 0.7em;
          letter-spacing: 0.15em;
          text-transform: uppercase;
          color: var(--pico-muted-color);
          margin-left: 0.5rem;
        }
        /* De merknaam is de weg terug naar het overzicht. Geen
           link-blauw en geen streep eronder — het moet het logo blijven. */
        nav .brand a {
          color: inherit;
          text-decoration: none;
          border-bottom: 2px solid transparent;
        }
        nav .brand a:hover { opacity: 0.65; }
        nav .brand a[aria-current] { border-bottom-color: var(--andreas-acid); }
        /* Verticaal streepje tussen de groepen. Op een gewrapte rij (mobiel)
           staat zo'n streep midden in het niets, dus daar valt hij weg. */
        nav ul li.sep {
          width: 1px;
          align-self: stretch;
          margin: 0.2rem 0.4rem;
          padding: 0;
          background: var(--pico-muted-border-color);
        }
        nav ul li a[role="button"] {
          padding: 0.4rem 0.9rem;
          font-size: 14px;
          margin: 0;
        }
        nav ul li form {
          margin: 0;
          display: inline-flex;
          align-items: center;
        }
        nav ul li form button {
          margin: 0;
          padding: 0.4rem 0.9rem;
          font-size: 14px;
        }
        table { font-size: 14px; }
        td.actions { white-space: nowrap; }
        td.actions form { display: inline-block; margin: 0 0.25rem 0 0; }
        td.actions button { padding: 0.25rem 0.6rem; font-size: 12px; margin: 0; width: auto; }
        /* Kleine link die als knop leest, in dezelfde maat als de buttons
           in een actie-cel. */
        td.actions a[role="button"] {
          padding: 0.25rem 0.6rem;
          font-size: 12px;
          margin: 0;
          width: auto;
          display: inline-block;
        }
        /* Tekstveld tussen de knoppen: Pico maakt inputs 100% breed, en in
           een actie-cel rekt dat de hele tabel uit het scherm. */
        td.actions .inline-input {
          display: inline-block;
          width: 11em;
          padding: 0.25rem 0.5rem;
          font-size: 12px;
          margin: 0;
          height: auto;
        }
        .row-unpub { opacity: 0.55; }
        .pill {
          display: inline-block;
          padding: 0.1rem 0.5rem;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .pill-pub { background: var(--andreas-acid); color: #0a0a0b; }
        .pill-unpub { background: #e6dfca; color: #6e6354; }
        /* Knop-rij: forms naast elkaar zonder rare paddings. */
        form { margin: 0; padding: 0; }
        details summary { cursor: pointer; }
        .grid-2 { display: grid; gap: 0.75rem; grid-template-columns: 1fr 1fr; }
        .grid-3 { display: grid; gap: 0.75rem; grid-template-columns: 1fr 1fr 1fr; }
        @media (max-width: 720px) { .grid-2, .grid-3 { grid-template-columns: 1fr; } }
        .stat { padding: 1rem; border: 1px solid var(--pico-muted-border-color); border-radius: 8px; }
        .stat strong { font-size: 28px; display: block; }
        .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; gap: 0.75rem; flex-wrap: wrap; }
        .toolbar h2 { margin: 0; }
        /* Drie-koloms layout voor de social-actions: video, carousel, tiktok. */
        .social-actions {
          display: grid;
          grid-template-columns: 1.2fr 1.2fr 0.8fr;
          gap: 1rem;
          margin-bottom: 2rem;
        }
        .social-actions > article { margin: 0; height: 100%; }
        @media (max-width: 900px) {
          .social-actions { grid-template-columns: 1fr; }
        }

        /* ─── Mobile (< 720px) ─────────────────────────────────────── */
        @media (max-width: 720px) {
          :root { --pico-font-size: 14px; }
          body {
            margin: 0;
            padding: 0.75rem 1rem 5rem;
            border: none;
            border-radius: 0;
            max-width: 100%;
          }
          /* Nav: compacter en sticky bovenaan zodat tabs altijd bereikbaar
             blijven. Logo eerste rij, buttons wrappen daaronder. */
          nav {
            margin-bottom: 1rem;
            position: sticky;
            top: 0;
            background: #fdfaf2;
            padding: 0.5rem 0;
            z-index: 10;
            margin-left: -1rem;
            margin-right: -1rem;
            padding-left: 1rem;
            padding-right: 1rem;
            border-bottom: 1px solid var(--pico-muted-border-color);
          }
          /* Stapelen, niet naast elkaar. Pico zet nav op flex-row met de
             twee lijsten links en rechts; op 375px wrapt de tweede dan tot
             een smalle kolom naast de merknaam, die daardoor halverwege de
             knoppen komt te hangen. Dit was al de bedoeling hierboven, maar
             zonder een richting op nav zelf gebeurde het niet. */
          nav {
            flex-direction: column;
            align-items: flex-start;
            gap: 0.4rem;
          }
          nav ul {
            flex-wrap: wrap;
            row-gap: 0.4rem;
            padding: 0;
            margin: 0;
          }
          nav .brand { font-size: 1.1rem; }
          nav .brand small { display: none; }
          nav ul li.sep { display: none; }
          nav ul li a[role="button"],
          nav ul li form button {
            padding: 0.3rem 0.65rem;
            font-size: 12px;
          }

          /* Tables omtoveren naar block-cards. Header verbergen, elke
             rij wordt z'n eigen kaartje. */
          table thead { display: none; }
          table, table tbody, table tr, table td { display: block; width: 100%; }
          table tr {
            border: 1px solid var(--pico-muted-border-color);
            border-radius: 8px;
            margin-bottom: 0.75rem;
            padding: 0.75rem 0.9rem;
            background: rgba(10,10,11,0.025);
          }
          table td {
            padding: 0.3rem 0;
            border: none;
            text-align: left !important;
          }
          /* Action-knoppen onder elkaar in plaats van inline */
          td.actions { white-space: normal; }
          td.actions form,
          td.actions a[role="button"] {
            display: block;
            margin: 0.3rem 0 0 0;
            width: 100%;
          }
          td.actions button,
          td.actions a[role="button"] {
            width: 100%;
            text-align: center;
            font-size: 13px;
            padding: 0.45rem 0.6rem;
          }

          /* Form-input klikbaar groot genoeg */
          input, select, textarea, button { font-size: 16px; }
          button { padding: 0.55rem 0.9rem; }
        }
      `}</style>
    </head>
    <body>
      <nav>
        <ul>
          <li class="brand">
            <a
              href="/admin"
              aria-current={active === 'home' ? 'page' : undefined}
            >
              Andreas <small>admin</small>
            </a>
          </li>
        </ul>
        <ul>
          {NAV.flatMap((group, i) => [
            ...(i > 0 ? [<li class="sep" aria-hidden="true" />] : []),
            ...group.map((item) => (
              <li>
                <a
                  href={item.href}
                  role="button"
                  class={active === item.key ? '' : 'outline'}
                  aria-current={active === item.key ? 'page' : undefined}
                >
                  {item.label}
                </a>
              </li>
            )),
          ])}
          <li class="sep" aria-hidden="true" />
          <li>
            <form method="post" action="/admin/logout">
              <button type="submit" class="secondary outline">Uitloggen</button>
            </form>
          </li>
        </ul>
      </nav>
      <main>{children}</main>
    </body>
  </html>
);

export const PublishedPill: FC<{ published: boolean }> = ({ published }) => (
  <span class={`pill ${published ? 'pill-pub' : 'pill-unpub'}`}>
    {published ? 'live' : 'uit'}
  </span>
);

/** Format a Date or ISO-string in NL-time, "DD MMM HH:MM" stijl. */
export function fmtDate(d: Date | string | null): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (isNaN(date.getTime())) return '—';
  const months = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
  const day = date.getDate();
  const month = months[date.getMonth()];
  const year = date.getFullYear();
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${day} ${month} ${year} · ${hh}:${mm}`;
}

/** Format a Date as ISO local string for `<input type="datetime-local">`. */
export function toDateTimeLocal(d: Date | string | null): string {
  if (!d) return '';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Parse from `<input type="datetime-local">` value to Date in local TZ. */
export function fromDateTimeLocal(s: string | undefined): Date | null {
  if (!s || s.trim().length === 0) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
