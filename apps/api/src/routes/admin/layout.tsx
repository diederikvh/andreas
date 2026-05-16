import type { FC, PropsWithChildren } from 'hono/jsx';

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
  <html lang="nl" data-theme="dark">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title} · Andreas admin</title>
      <link
        rel="stylesheet"
        href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css"
      />
      <style>{`
        :root { --pico-font-size: 15px; }
        html { background: #0a0a0b; min-height: 100%; }
        body {
          max-width: 1100px;
          margin: 2rem auto 4rem;
          padding: 1.5rem 2rem 3rem;
          background: #131316;
          border: 1px solid var(--pico-muted-border-color);
          border-radius: 12px;
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
        td.actions button { padding: 0.25rem 0.6rem; font-size: 12px; margin: 0; }
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
        .pill-pub { background: #1d4d2c; color: #b6f3c8; }
        .pill-unpub { background: #4d1d1d; color: #f3b6b6; }
        details summary { cursor: pointer; }
        .grid-2 { display: grid; gap: 0.75rem; grid-template-columns: 1fr 1fr; }
        .grid-3 { display: grid; gap: 0.75rem; grid-template-columns: 1fr 1fr 1fr; }
        @media (max-width: 720px) { .grid-2, .grid-3 { grid-template-columns: 1fr; } }
        .stat { padding: 1rem; border: 1px solid var(--pico-muted-border-color); border-radius: 8px; }
        .stat strong { font-size: 28px; display: block; }
        .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
        .toolbar h2 { margin: 0; }
      `}</style>
    </head>
    <body>
      <nav>
        <ul>
          <li class="brand">Andreas <small>admin</small></li>
        </ul>
        <ul>
          <li>
            <a
              href="/admin"
              role="button"
              class={active === 'home' ? '' : 'outline'}
              aria-current={active === 'home' ? 'page' : undefined}
            >
              Overzicht
            </a>
          </li>
          <li>
            <a
              href="/admin/events"
              role="button"
              class={active === 'events' ? '' : 'outline'}
              aria-current={active === 'events' ? 'page' : undefined}
            >
              Events
            </a>
          </li>
          <li>
            <a
              href="/admin/venues"
              role="button"
              class={active === 'venues' ? '' : 'outline'}
              aria-current={active === 'venues' ? 'page' : undefined}
            >
              Venues
            </a>
          </li>
          <li>
            <a
              href="/admin/series"
              role="button"
              class={active === 'series' ? '' : 'outline'}
              aria-current={active === 'series' ? 'page' : undefined}
            >
              Series
            </a>
          </li>
          <li>
            <a
              href="/admin/import"
              role="button"
              class={active === 'import' ? '' : 'outline'}
              aria-current={active === 'import' ? 'page' : undefined}
            >
              Import
            </a>
          </li>
          <li>
            <a
              href="/admin/insights"
              role="button"
              class={active === 'insights' ? '' : 'outline'}
              aria-current={active === 'insights' ? 'page' : undefined}
            >
              Insights
            </a>
          </li>
          <li>
            <a
              href="/admin/social"
              role="button"
              class={active === 'social' ? '' : 'outline'}
              aria-current={active === 'social' ? 'page' : undefined}
            >
              Social
            </a>
          </li>
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
