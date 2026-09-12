const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';

/**
 * Omschrijving uit de HTML van een Paradiso-detailpagina trekken.
 * Apart van paradiso.ts zodat de test geen DB-verbinding nodig heeft.
 */
/** Paradiso's origin geeft onder sequentiële load intermittent een 500;
    even wachten tussen detail-fetches scheelt meer dan nóg een poging. */
export const DETAIL_SPACING_MS = 150;

/**
 * Omschrijving van de detailpagina. Was Playwright, is nu een kale
 * fetch: de pagina is server-rendered, dus de tekst staat gewoon in de
 * HTML die je terugkrijgt. Gemeten op negen events — waaronder de vijf
 * waar de GraphQL `text` leeg is — geeft dit letterlijk dezelfde string
 * als de browser-versie.
 *
 * Dezelfde heuristiek als voorheen, alleen toegepast op server-HTML in
 * plaats van op een gerenderde DOM: eerste regel boven de 80 tekens is
 * de opening van de body, daarna maximaal zes regels tot een kopje als
 * "Line-up" of "Route". De `css-*`-klasse om de tekst heen is van
 * emotion en verandert per build, dus daar valt niet op te selecteren.
 */
export async function fetchDescription(url: string): Promise<string | null> {
  let html: string | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { 'user-agent': UA, 'accept-language': 'nl-NL' },
        signal: AbortSignal.timeout(15000),
      });
      if (r.ok) {
        // Soft-404: een verwijderd of hernoemd event geeft een 307 naar
        // een algemene pagina, en `fetch` volgt die. Zonder deze check
        // landt Paradiso's contacttekst ("Heb je een vraag of
        // opmerking...") als omschrijving in de agenda. Het numerieke
        // event-id moet in de eind-URL blijven staan: een slug-correctie
        // houdt dat id, een fallback niet.
        const id = url.match(/\/(\d+)\/?$/)?.[1];
        if (id && !r.url.includes(id)) return null;
        html = await r.text();
        break;
      }
    } catch {
      // volgende poging
    }
    if (attempt < 3) await new Promise((res) => setTimeout(res, 500 * attempt));
  }
  if (!html) return null;
  return descriptionFromHtml(html);
}

export function descriptionFromHtml(html: string): string | null {
  const main = html.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ?? html;
  // Emotion zet z'n CSS in <style> binnen main; zonder dit strippen is
  // de eerste "regel boven 80 tekens" een lap CSS.
  const zonderCode = main.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');
  const metRegels = zonderCode.replace(/<br\s*\/?>|<\/p>|<\/div>|<\/h[1-6]>|<\/li>/gi, '\n');
  const tekst = decodeEntities(metRegels.replace(/<[^>]+>/g, ''));
  const regels = tekst
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);
  const stop = regels.findIndex((l) => /^(Line-up|Route|Accepteer|Bovenzaal\s*$)/i.test(l));
  const first = regels.findIndex((l) => l.length > 80);
  if (first < 0) return null;
  const end = stop > first ? stop : Math.min(first + 6, regels.length);
  const desc = regels.slice(first, end).filter((l) => l.length > 30).join('\n\n');
  return desc || null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
