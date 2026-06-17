/**
 * MCP-UI card-renderer voor `search_events`. Bouwt een zelf-dragende,
 * on-brand HTML-widget (Andreas dag-palet: cream + karmijn) die élke
 * MCP-UI-host (Claude, Goose, Postman, eigen agents) als iframe rendert.
 *
 * We hand-rollen de MCP-UI resource i.p.v. `@mcp-ui/server` te importeren:
 * het contract is stabiel en klein (`uri: ui://…` + `mimeType: text/html` +
 * `text`), en zo houden we de Docker-build dependency-vrij. De host detecteert
 * `resource.uri` die met `ui://` begint en rendert de HTML in een sandbox-iframe.
 *
 * De tool blijft óók een tekst-samenvatting + structuredContent teruggeven, dus
 * hosts zónder UI-ondersteuning verliezen niks (progressive enhancement).
 */
import { escapeHtml as esc } from '../routes/_seo.js';
import type { McpEvent } from './events.js';

/** MCP-UI embedded resource shape (== MCP EmbeddedResource met ui://-uri). */
export type UiResource = {
  type: 'resource';
  resource: { uri: string; mimeType: 'text/html'; text: string };
};

const WHEN_LABEL: Record<string, string> = {
  tonight: 'vanavond',
  this_weekend: 'dit weekend',
  this_week: 'deze week',
  this_month: 'deze maand',
  this_year: 'dit jaar',
  next_weekend: 'volgend weekend',
  next_week: 'volgende week',
  next_month: 'volgende maand',
};

// Andreas dag-palet (theme/tokens.ts). Cream canvas, karmijn accent, soil-ink.
const C = {
  bg: '#f5f1e8',
  card: '#ebe6d8',
  chip: '#d9d1bf',
  ink: '#1a1410',
  inkRead: '#3d342a',
  inkMuted: '#5a4e3f',
  accent: '#c9453a',
} as const;

/** "vr 20 jun · 20:00" in Amsterdamse tijd. */
function fmtWhen(iso: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('nl-NL', {
    timeZone: 'Europe/Amsterdam',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = `${get('weekday')} ${get('day')} ${get('month')}`.replace(/\.$/, '');
  return `${day} · ${get('hour')}:${get('minute')}`;
}

/** null = geen prijs bekend (geen chip); 0 = Gratis; anders €-bedrag. */
function fmtPrice(cents: number | null): string | null {
  if (cents == null) return null;
  if (cents === 0) return 'Gratis';
  const euro = cents / 100;
  return Number.isInteger(euro) ? `€${euro}` : `€${euro.toFixed(2).replace('.', ',')}`;
}

/** Veilig voor een CSS `url('...')`-context: alleen http(s), en geen tekens
    die uit de string/declaratie kunnen breken (quotes, haakjes, backslash,
    whitespace). HTML-escapen volstaat hier niet — de browser decodeert dat
    vóór de CSS-parser. Faalt 't, dan geen background (placeholder). */
function safeCssImageUrl(url: string | null): string | null {
  if (!url) return null;
  if (!/^https:\/\/[^\s'"()\\<>]+$/i.test(url)) return null;
  return url;
}

function cardHtml(e: McpEvent): string {
  const safeImg = safeCssImageUrl(e.imageUrl);
  const img = safeImg
    ? `<div class="thumb" style="background-image:url('${safeImg}')"></div>`
    : `<div class="thumb thumb--empty">✕</div>`;
  const wijk = e.wijk ? ` · ${esc(e.wijk)}` : '';
  const price = fmtPrice(e.priceCents);
  const chips = [
    e.category ? `<span class="chip chip--cat">${esc(e.category)}</span>` : '',
    ...(e.genres ?? []).slice(0, 2).map((g) => `<span class="chip">${esc(g)}</span>`),
    price ? `<span class="chip chip--price">${esc(price)}</span>` : '',
  ]
    .filter(Boolean)
    .join('');
  return `
  <a class="card" href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">
    ${img}
    <div class="body">
      <div class="title">${esc(e.title)}</div>
      <div class="meta">${esc(e.venue)}${wijk}</div>
      <div class="when">${esc(fmtWhen(e.start))}</div>
      <div class="chips">${chips}</div>
    </div>
    <div class="go">→</div>
  </a>`;
}

function emptyHtml(whenLabel: string): string {
  return `<div class="empty">Geen events gevonden voor <b>${esc(whenLabel)}</b>.<br/>Probeer een andere periode of zoekterm.</div>`;
}

/** Bouw de volledige HTML-widget (zelf-dragend, inline CSS). */
function renderHtml(events: McpEvent[], when: string): string {
  const whenLabel = WHEN_LABEL[when] ?? when;
  const heading =
    events.length > 0
      ? `${events.length} ${events.length === 1 ? 'tip' : 'tips'} voor ${esc(whenLabel)}`
      : `Niets gevonden voor ${esc(whenLabel)}`;
  const list = events.length > 0 ? events.map(cardHtml).join('') : emptyHtml(whenLabel);

  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
       background:${C.bg};color:${C.ink};padding:14px;-webkit-font-smoothing:antialiased}
  .wrap{max-width:680px;margin:0 auto}
  .head{display:flex;align-items:center;gap:8px;margin:2px 2px 12px}
  .logo{font-weight:800;color:${C.accent};font-size:18px;line-height:1}
  .brand{font-weight:800;font-size:15px;letter-spacing:.2px}
  .sub{margin-left:auto;font-size:12px;color:${C.inkMuted}}
  .card{display:flex;align-items:center;gap:12px;background:${C.card};border-radius:14px;
        padding:10px;margin-bottom:10px;text-decoration:none;color:inherit;
        border:1px solid rgba(26,20,16,.06);transition:transform .12s ease}
  .card:hover{transform:translateY(-1px);border-color:${C.accent}}
  .thumb{width:72px;height:72px;flex:0 0 72px;border-radius:10px;background-size:cover;
         background-position:center;background-color:${C.chip}}
  .thumb--empty{display:flex;align-items:center;justify-content:center;color:${C.inkMuted};
                font-weight:800;font-size:22px}
  .body{flex:1;min-width:0}
  .title{font-weight:700;font-size:15px;line-height:1.25;color:${C.ink};
         overflow:hidden;text-overflow:ellipsis;display:-webkit-box;
         -webkit-line-clamp:2;-webkit-box-orient:vertical}
  .meta{font-size:13px;color:${C.inkRead};margin-top:2px;white-space:nowrap;
        overflow:hidden;text-overflow:ellipsis}
  .when{font-size:12px;color:${C.accent};font-weight:600;margin-top:3px}
  .chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px}
  .chip{font-size:11px;color:${C.inkMuted};background:${C.chip};border-radius:999px;
        padding:2px 8px;white-space:nowrap}
  .chip--cat{color:${C.ink};font-weight:600}
  .chip--price{color:${C.ink};font-weight:600}
  .go{flex:0 0 auto;color:${C.inkMuted};font-size:18px;padding:0 4px}
  .empty{background:${C.card};border-radius:14px;padding:22px;text-align:center;
         color:${C.inkRead};font-size:14px;line-height:1.5}
</style></head>
<body><div class="wrap">
  <div class="head"><span class="logo">✕</span><span class="brand">Andreas</span><span class="sub">${heading}</span></div>
  ${list}
</div>
<script>
  // Best-effort: meld de inhoudshoogte aan de MCP-UI-host zodat de iframe
  // niet afkapt. Faalt stil als de sandbox scripts blokkeert.
  try {
    var report = function () {
      var h = document.documentElement.scrollHeight;
      parent.postMessage({ type: 'ui-size-change', payload: { height: h } }, '*');
    };
    window.addEventListener('load', report);
    setTimeout(report, 50);
  } catch (e) {}
</script>
</body></html>`;
}

/**
 * Bouw de MCP-UI resource voor een set events. Plaats deze náást de
 * tekst-samenvatting in het tool-resultaat (`content`-array).
 */
export function buildEventsUiResource(events: McpEvent[], when: string): UiResource {
  return {
    type: 'resource',
    resource: {
      uri: `ui://andreas/events/${when}-${events.length}`,
      mimeType: 'text/html',
      text: renderHtml(events, when),
    },
  };
}
