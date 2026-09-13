const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';

/**
 * Pure helpers voor de Paradiso-scraper: omschrijving uit de HTML, plus
 * zaal en line-up uit de GraphQL. Apart van paradiso.ts zodat de tests
 * geen DB-verbinding nodig hebben.
 */

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


export type ParadisoArea = { label: string | null; value: string | null };
export type LineupItem = { name: string; role?: 'dj' | 'support' | 'headliner' | 'act' };

/**
 * Zaal uit `areas`. De labels zijn "Venue - Zaal": "Paradiso - Grote
 * Zaal", "Tolhuistuin - Club", "Bitterzoet - Concertzaal".
 *
 * Staat het venue-deel gelijk aan de venue waar we dit event al naartoe
 * routeren, dan is de rest de zaal en kan het voorvoegsel weg. Staat er
 * iets anders — "Zonnehuis - Theaterzaal" bij een Tolhuistuin-event —
 * dan is dat een ánder gebouw, en dan is juist dat voorvoegsel het
 * belangrijkste dat er staat: dat blijft dus heel.
 *
 * "Extern - Overig" zegt niets over waar je moet zijn en wordt null.
 */
export function roomFromAreas(areas: ParadisoArea[] | null | undefined, locationTitle: string): string | null {
  const label = areas?.[0]?.label?.trim();
  if (!label || /^extern\b/i.test(label)) return null;
  const m = label.match(/^(.+?)\s+-\s+(.+)$/);
  if (!m) return label;
  const [, gebouw, zaal] = m;
  return gebouw!.toLowerCase() === locationTitle.trim().toLowerCase() ? zaal!.trim() : label;
}

/**
 * Line-up uit `relatedArtists`. Bewust géén rol op basis van volgorde:
 * gemeten over 469 events komt `relatedArtists[0]` bij 70 ervan niet
 * overeen met de eventtitel, en bij "Mayhem - Death over Europe" staat
 * de support (Marduk) zelfs vooraan terwijl `supportAct` dat rechtzet.
 *
 * Dus alleen een rol als `supportAct` het met zoveel woorden zegt: wie
 * daarin genoemd wordt is support, en de rest is dan headliner. Zegt
 * Paradiso niets, dan laten wij de rol ook leeg — een clubnacht met
 * acht dj's heeft sowieso geen headliner. Gemeten: 36 van de 92
 * meerkoppige events hebben een supportAct, en in 33 daarvan staat die
 * naam ook echt in de artiestenlijst.
 */
export function lineupFromArtists(
  artists: { title: string | null }[] | null | undefined,
  supportAct: string | null
): LineupItem[] | null {
  const namen = (artists ?? []).map((a) => a?.title?.trim()).filter((x): x is string => !!x);
  if (!namen.length) return null;
  const support = (supportAct ?? '').trim().toLowerCase();
  const isSupport = (n: string) => !!support && support.includes(n.toLowerCase());
  const iemandIsSupport = namen.some(isSupport);
  return namen.map((name) => {
    if (!iemandIsSupport) return { name };
    return isSupport(name) ? { name, role: 'support' as const } : { name, role: 'headliner' as const };
  });
}
