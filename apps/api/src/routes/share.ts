import { eq } from 'drizzle-orm';
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
      startsAt: schema.events.startsAt,
      imageUrl: schema.events.imageUrl,
      venue: { name: schema.venues.name },
    })
    .from(schema.events)
    .innerJoin(schema.venues, eq(schema.venues.id, schema.events.venueId))
    .where(eq(schema.events.id, id))
    .limit(1);

  const eventTitle = row?.title ?? 'Andreas';
  const eventDesc = row?.description ?? row?.venue?.name ?? '';
  const eventImage = row?.imageUrl ?? '';
  const dateLabel = row?.startsAt
    ? new Date(row.startsAt).toLocaleString('nl-NL', {
        weekday: 'short',
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';

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

shareRoute.get('/', (c) => {
  const html = `<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8" />
  <title>Andreas — uitgaan in Amsterdam</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; background: #0a0a0b; color: #f2f2ef; font-family: -apple-system, system-ui, sans-serif; min-height: 100vh; display: grid; place-items: center; }
    main { text-align: center; padding: 24px; }
    h1 { font-size: 36px; letter-spacing: -1.5px; font-weight: 900; margin: 0 0 8px; }
    p { color: #9a9a94; margin: 0; }
    a { color: #d4ff3a; }
  </style>
</head>
<body>
  <main>
    <h1>Andreas</h1>
    <p>Anti-algoritme uitgaan, alleen via je vrienden.<br/><a href="${escapeHtml(APP_STORE_URL)}">Download in de App Store</a></p>
  </main>
</body>
</html>`;
  c.header('Content-Type', 'text/html; charset=utf-8');
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
