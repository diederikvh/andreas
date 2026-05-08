import { and, asc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import { db, schema } from '../db/index.js';

/**
 * Publieke share-routes. Hier serveren we drie dingen:
 *   • `/.well-known/apple-app-site-association` — Apple gebruikt dit
 *     om te beslissen of `https://andreas.amsterdam/...` direct in de
 *     iOS-app moet openen (universal links).
 *   • `/e/:id` — minimal HTML-pagina met OG-meta voor iMessage/WhatsApp
 *     previews + JS-redirect naar de app of App Store.
 *   • `/` — placeholder home die naar de app verwijst.
 *
 * Alles is volledig server-rendered, geen client framework nodig — een
 * iMessage-link unfurler haalt alleen de meta-tags op.
 */
export const shareRoute = new Hono();

const APPLE_TEAM_ID = process.env.APPLE_TEAM_ID ?? '';
const APPLE_BUNDLE_ID = process.env.APPLE_BUNDLE_ID ?? 'amsterdam.andreas.app';
const APP_STORE_URL =
  process.env.APP_STORE_URL ?? 'https://apps.apple.com/nl/app/andreas/id000000000';

shareRoute.get('/.well-known/apple-app-site-association', (c) => {
  // applinks: zegt aan iOS dat alle `https://andreas.amsterdam/<paths>`
  // door onze app afgehandeld kunnen worden. We staan / + /e/* toe;
  // /api/* expliciet uit zodat fetch-calls niet per ongeluk via de
  // app-route gaan.
  const aasa = {
    applinks: {
      details: [
        {
          appIDs: APPLE_TEAM_ID
            ? [`${APPLE_TEAM_ID}.${APPLE_BUNDLE_ID}`]
            : [],
          components: [
            { '/': '/e/*', comment: 'Event-share-links' },
            { '/': '/v/*', comment: 'Venue-share-links' },
            { '/': '/u/*', comment: 'User-handle (QR) share-links' },
            { '/': '/', comment: 'Home' },
            { '/': '/api/*', exclude: true, comment: 'API-calls' },
          ],
        },
      ],
    },
  };
  // Apple eist application/json, geen .json extensie, geen redirect.
  c.header('Content-Type', 'application/json');
  return c.body(JSON.stringify(aasa));
});

shareRoute.get('/e/:id', async (c) => {
  const id = c.req.param('id');
  const ref = c.req.query('ref') ?? '';

  const [row] = await db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      description: schema.events.description,
      kind: schema.events.kind,
      imageUrl: schema.events.imageUrl,
      venue: { name: schema.venues.name },
    })
    .from(schema.events)
    .innerJoin(schema.venues, eq(schema.venues.id, schema.events.venueId))
    .where(eq(schema.events.id, id))
    .limit(1);

  // Eerstvolgende occurrence ophalen voor de date-label op de share-page.
  const [nextOcc] = row
    ? await db
        .select({
          startsAt: schema.occurrences.startsAt,
          endsAt: schema.occurrences.endsAt,
        })
        .from(schema.occurrences)
        .where(
          and(
            eq(schema.occurrences.eventId, row.id),
            sql`COALESCE(${schema.occurrences.endsAt}, ${schema.occurrences.startsAt}) >= NOW()`,
            sql`${schema.occurrences.status} <> 'cancelled'`
          )
        )
        .orderBy(asc(schema.occurrences.startsAt))
        .limit(1)
    : [];

  const eventTitle = row?.title ?? 'Andreas';
  const eventDesc = row?.description ?? row?.venue?.name ?? '';
  const eventImage = row?.imageUrl ?? '';
  // Voor exhibitions: "loopt t/m 6 mei". Voor shows: datum + tijd.
  let dateLabel = '';
  if (nextOcc?.startsAt) {
    if (row?.kind === 'exhibition' && nextOcc.endsAt) {
      dateLabel = `loopt t/m ${nextOcc.endsAt.toLocaleDateString('nl-NL', {
        day: '2-digit',
        month: 'short',
      })}`;
    } else {
      dateLabel = nextOcc.startsAt.toLocaleString('nl-NL', {
        weekday: 'short',
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
    }
  }

  const refQs = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const appLink = `andreas://event/${encodeURIComponent(id)}${refQs}`;
  const universalLink = `https://andreas.amsterdam/e/${encodeURIComponent(id)}${refQs}`;
  // De universal-link gebruiken we om vanuit het web direct naar de
  // app te springen als Apple de associatie kent — anders fallback.

  const html = `<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(eventTitle)} · Andreas</title>
  <meta property="og:title" content="${escapeHtml(eventTitle)}" />
  <meta property="og:description" content="${escapeHtml(
    [dateLabel, row?.venue?.name].filter(Boolean).join(' · ') || eventDesc
  )}" />
  ${eventImage ? `<meta property="og:image" content="${escapeHtml(eventImage)}" />` : ''}
  <meta property="og:url" content="${escapeHtml(universalLink)}" />
  <meta property="og:type" content="website" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="apple-itunes-app" content="app-id=000000000, app-argument=${escapeHtml(appLink)}" />
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; background: #0a0a0b; color: #f2f2ef; font-family: -apple-system, system-ui, sans-serif; }
    main { max-width: 480px; margin: 0 auto; padding: 48px 24px; text-align: center; }
    h1 { font-size: 28px; line-height: 1.05; letter-spacing: -1px; margin: 24px 0 8px; font-weight: 900; }
    p { color: #9a9a94; margin: 4px 0 24px; font-size: 14px; }
    a.cta { display: inline-block; background: #d4ff3a; color: #0a0a0b; padding: 14px 22px; border-radius: 999px; text-decoration: none; font-weight: 600; }
    a.fallback { display: block; margin-top: 16px; color: #9a9a94; font-size: 12px; }
    img { width: 100%; border-radius: 12px; aspect-ratio: 16/9; object-fit: cover; background: #17171a; }
    .kicker { font-family: ui-monospace, monospace; font-size: 11px; letter-spacing: 1.4px; text-transform: uppercase; color: #d4ff3a; margin-bottom: 4px; }
  </style>
</head>
<body>
  <main>
    ${eventImage ? `<img src="${escapeHtml(eventImage)}" alt="" />` : ''}
    <div class="kicker">Andreas · uitgaan in Amsterdam</div>
    <h1>${escapeHtml(eventTitle)}</h1>
    <p>${escapeHtml([dateLabel, row?.venue?.name].filter(Boolean).join(' · '))}</p>
    <a class="cta" href="${escapeHtml(appLink)}" id="open">Open in Andreas</a>
    <a class="fallback" href="${escapeHtml(APP_STORE_URL)}">Nog geen Andreas? Download in de App Store</a>
  </main>
  <script>
    // Probeer de app te openen via custom-scheme; als de pagina nog
    // bestaat na 1.2s gaan we ervan uit dat de app niet is
    // geïnstalleerd en sturen we door naar de App Store.
    (function () {
      var app = ${JSON.stringify(appLink)};
      var store = ${JSON.stringify(APP_STORE_URL)};
      var t = setTimeout(function () { window.location.href = store; }, 1200);
      window.addEventListener('pagehide', function () { clearTimeout(t); });
      // Bij iOS-Safari wordt universal-link automatisch afgevangen door
      // het OS — dit script is alleen een fallback voor browsers die
      // de associatie niet kennen.
      window.location.href = app;
    })();
  </script>
</body>
</html>`;

  c.header('Content-Type', 'text/html; charset=utf-8');
  // Iets cachen om scrapers/imessage previews snel te bedienen, maar
  // niet zo lang dat een titel-correctie urenlang vastzit.
  c.header('Cache-Control', 'public, max-age=300');
  return c.body(html);
});

shareRoute.get('/v/:slug', async (c) => {
  const slug = c.req.param('slug');
  const ref = c.req.query('ref') ?? '';

  const [row] = await db
    .select({
      id: schema.venues.id,
      slug: schema.venues.slug,
      name: schema.venues.name,
      address: schema.venues.address,
      description: schema.venues.description,
      imageUrl: schema.venues.imageUrl,
    })
    .from(schema.venues)
    .where(eq(schema.venues.slug, slug))
    .limit(1);

  const venueName = row?.name ?? 'Andreas';
  const venueDesc = row?.description ?? row?.address ?? '';
  const venueImage = row?.imageUrl ?? '';

  const refQs = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const appLink = `andreas://venue/${encodeURIComponent(slug)}${refQs}`;
  const universalLink = `https://andreas.amsterdam/v/${encodeURIComponent(slug)}${refQs}`;

  const html = `<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(venueName)} · Andreas</title>
  <meta property="og:title" content="${escapeHtml(venueName)}" />
  <meta property="og:description" content="${escapeHtml(venueDesc)}" />
  ${venueImage ? `<meta property="og:image" content="${escapeHtml(venueImage)}" />` : ''}
  <meta property="og:url" content="${escapeHtml(universalLink)}" />
  <meta property="og:type" content="website" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="apple-itunes-app" content="app-id=000000000, app-argument=${escapeHtml(appLink)}" />
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; background: #0a0a0b; color: #f2f2ef; font-family: -apple-system, system-ui, sans-serif; }
    main { max-width: 480px; margin: 0 auto; padding: 48px 24px; text-align: center; }
    h1 { font-size: 28px; line-height: 1.05; letter-spacing: -1px; margin: 24px 0 8px; font-weight: 900; }
    p { color: #9a9a94; margin: 4px 0 24px; font-size: 14px; }
    a.cta { display: inline-block; background: #d4ff3a; color: #0a0a0b; padding: 14px 22px; border-radius: 999px; text-decoration: none; font-weight: 600; }
    a.fallback { display: block; margin-top: 16px; color: #9a9a94; font-size: 12px; }
    img { width: 100%; border-radius: 12px; aspect-ratio: 16/9; object-fit: cover; background: #17171a; }
    .kicker { font-family: ui-monospace, monospace; font-size: 11px; letter-spacing: 1.4px; text-transform: uppercase; color: #d4ff3a; margin-bottom: 4px; }
  </style>
</head>
<body>
  <main>
    ${venueImage ? `<img src="${escapeHtml(venueImage)}" alt="" />` : ''}
    <div class="kicker">Andreas · venue</div>
    <h1>${escapeHtml(venueName)}</h1>
    <p>${escapeHtml(row?.address ?? '')}</p>
    <a class="cta" href="${escapeHtml(appLink)}" id="open">Open in Andreas</a>
    <a class="fallback" href="${escapeHtml(APP_STORE_URL)}">Nog geen Andreas? Download in de App Store</a>
  </main>
  <script>
    (function () {
      var app = ${JSON.stringify(appLink)};
      var store = ${JSON.stringify(APP_STORE_URL)};
      var t = setTimeout(function () { window.location.href = store; }, 1200);
      window.addEventListener('pagehide', function () { clearTimeout(t); });
      window.location.href = app;
    })();
  </script>
</body>
</html>`;

  c.header('Content-Type', 'text/html; charset=utf-8');
  c.header('Cache-Control', 'public, max-age=300');
  return c.body(html);
});

shareRoute.get('/u/:handle', async (c) => {
  const rawHandle = c.req.param('handle');
  const handle = rawHandle.toLowerCase().replace(/[^a-z0-9_]/g, '');

  const [row] = await db
    .select({
      name: schema.users.name,
      handle: schema.users.handle,
      avatarUrl: schema.users.avatarUrl,
    })
    .from(schema.users)
    .where(eq(schema.users.handle, handle))
    .limit(1);

  const displayName = row?.name && !row.name.startsWith('+') ? row.name : '';
  const handleLabel = row?.handle ?? handle;
  const appLink = `andreas://u/${encodeURIComponent(handleLabel)}`;
  const universalLink = `https://andreas.amsterdam/u/${encodeURIComponent(handleLabel)}`;

  const html = `<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>@${escapeHtml(handleLabel)} · Andreas</title>
  <meta property="og:title" content="${escapeHtml(displayName || `@${handleLabel}`)} op Andreas" />
  <meta property="og:description" content="Voeg ${escapeHtml(displayName || `@${handleLabel}`)} toe als vriend op Andreas." />
  ${row?.avatarUrl ? `<meta property="og:image" content="${escapeHtml(row.avatarUrl)}" />` : ''}
  <meta property="og:url" content="${escapeHtml(universalLink)}" />
  <meta property="og:type" content="website" />
  <meta name="apple-itunes-app" content="app-id=000000000, app-argument=${escapeHtml(appLink)}" />
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; background: #0a0a0b; color: #f2f2ef; font-family: -apple-system, system-ui, sans-serif; }
    main { max-width: 420px; margin: 0 auto; padding: 56px 24px; text-align: center; }
    h1 { font-size: 28px; line-height: 1.05; letter-spacing: -1px; margin: 16px 0 4px; font-weight: 900; }
    p.handle { font-family: ui-monospace, monospace; font-size: 12px; letter-spacing: 1.4px; text-transform: uppercase; color: #9a9a94; margin: 0 0 28px; }
    p { color: #9a9a94; margin: 4px 0 24px; font-size: 14px; }
    a.cta { display: inline-block; background: #d4ff3a; color: #0a0a0b; padding: 14px 22px; border-radius: 999px; text-decoration: none; font-weight: 600; }
    a.fallback { display: block; margin-top: 16px; color: #9a9a94; font-size: 12px; }
    .avatar { width: 96px; height: 96px; border-radius: 999px; object-fit: cover; background: #17171a; margin: 0 auto; }
    .kicker { font-family: ui-monospace, monospace; font-size: 11px; letter-spacing: 1.4px; text-transform: uppercase; color: #d4ff3a; }
  </style>
</head>
<body>
  <main>
    <div class="kicker">Andreas · vrienden</div>
    ${row?.avatarUrl ? `<img class="avatar" src="${escapeHtml(row.avatarUrl)}" alt="" />` : '<div class="avatar"></div>'}
    <h1>${escapeHtml(displayName || `@${handleLabel}`)}</h1>
    <p class="handle">@${escapeHtml(handleLabel)}</p>
    <a class="cta" href="${escapeHtml(appLink)}" id="open">Voeg toe in Andreas</a>
    <a class="fallback" href="${escapeHtml(APP_STORE_URL)}">Nog geen Andreas? Download in de App Store</a>
  </main>
  <script>
    (function () {
      var app = ${JSON.stringify(appLink)};
      var store = ${JSON.stringify(APP_STORE_URL)};
      var t = setTimeout(function () { window.location.href = store; }, 1200);
      window.addEventListener('pagehide', function () { clearTimeout(t); });
      window.location.href = app;
    })();
  </script>
</body>
</html>`;

  c.header('Content-Type', 'text/html; charset=utf-8');
  c.header('Cache-Control', 'public, max-age=300');
  return c.body(html);
});

shareRoute.get('/', (c) => {
  const playStoreUrl =
    process.env.PLAY_STORE_URL ?? 'https://play.google.com/store/apps/details?id=amsterdam.andreas.app';
  const html = `<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8" />
  <title>Andreas</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="impact-site-verification" value="fff70f25-b91e-4833-a018-ee1c1f216a6c" />
  <meta property="og:title" content="Andreas" />
  <meta property="og:description" content="Uitgaan in Amsterdam, op uitnodiging." />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;700;900&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #0a0a0b;
      color: #f2f2ef;
      font-family: 'Archivo', -apple-system, system-ui, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    main {
      flex: 1;
      max-width: 560px;
      width: 100%;
      margin: 0 auto;
      padding: 48px 28px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
    }

    /* Logo — wordmark in Archivo Black + acid ✕ als twee gedraaide
       rechthoeken, exact zoals de Cross-component in de app. */
    .logo {
      display: inline-flex;
      align-items: center;
      gap: 18px;
    }
    .logo-text {
      font-family: 'Archivo', sans-serif;
      font-weight: 900;
      font-size: 64px;
      letter-spacing: -2.4px;
      line-height: 1;
      color: #f2f2ef;
    }
    .cross {
      position: relative;
      width: 50px;
      height: 50px;
      flex-shrink: 0;
    }
    .cross::before, .cross::after {
      content: "";
      position: absolute;
      top: 50%;
      left: 0;
      width: 100%;
      height: 11px;
      margin-top: -5.5px;
      background: #d4ff3a;
    }
    .cross::before { transform: rotate(45deg); }
    .cross::after { transform: rotate(-45deg); }

    .kicker {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 11px;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: #9a9a94;
      margin: 18px 0 0;
    }

    .stores {
      margin-top: 64px;
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      justify-content: center;
      width: 100%;
    }
    .store-btn {
      flex: 1;
      min-width: 160px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 14px 20px;
      border: 1px solid #2a2a2d;
      border-radius: 999px;
      color: #f2f2ef;
      text-decoration: none;
      font-size: 14px;
      letter-spacing: -0.1px;
      transition: border-color 120ms, color 120ms;
      text-align: center;
    }
    .store-btn:hover { border-color: #d4ff3a; color: #d4ff3a; }
    .store-btn small {
      display: block;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 9px;
      letter-spacing: 1px;
      text-transform: uppercase;
      color: #6a6a64;
      margin-bottom: 2px;
    }
    .store-btn:hover small { color: #d4ff3a; }
    .store-btn span { font-weight: 700; }

    /* Footer in dezelfde gecentreerde stack onder de buttons. */
    footer { padding-top: 56px; width: 100%; max-width: 360px; }
    hr {
      border: 0;
      border-top: 1px solid #1d1d20;
      margin: 0 0 20px;
    }
    .colofon {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 11px;
      letter-spacing: 0.6px;
      color: #6a6a64;
      line-height: 1.8;
      margin: 0;
      text-align: center;
    }
    .colofon a {
      color: #9a9a94;
      text-decoration: none;
      border-bottom: 1px solid #2a2a2d;
    }
    .colofon a:hover { color: #d4ff3a; border-color: #d4ff3a; }

    @media (max-width: 480px) {
      main { padding: 64px 22px 32px; }
      .logo { gap: 14px; }
      .logo-text { font-size: 48px; letter-spacing: -1.8px; }
      .cross { width: 38px; height: 38px; }
      .cross::before, .cross::after { height: 9px; margin-top: -4.5px; }
      .stores { margin-top: 48px; }
    }
  </style>
</head>
<body>
  <main>
    <div class="logo">
      <span class="logo-text">Andreas</span>
      <span class="cross" aria-hidden="true"></span>
    </div>
    <p class="kicker">Amsterdam · ${new Date().getFullYear()}</p>

    <div class="stores">
      <a class="store-btn" href="${escapeHtml(APP_STORE_URL)}">
        <div>
          <small>Download op de</small>
          <span>App Store</span>
        </div>
      </a>
      <a class="store-btn" href="${escapeHtml(playStoreUrl)}">
        <div>
          <small>Verkrijgbaar via</small>
          <span>Google Play</span>
        </div>
      </a>
    </div>

    <footer>
      <hr/>
      <p class="colofon">
        <a href="/privacy">Privacy</a> · <a href="/voorwaarden">Voorwaarden</a><br/>
        Gemaakt in Amsterdam · gehost in Frankfurt, Ljubljana en Amsterdam.
      </p>
    </footer>
  </main>
</body>
</html>`;
  c.header('Content-Type', 'text/html; charset=utf-8');
  c.header('Cache-Control', 'public, max-age=300');
  return c.body(html);
});

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
