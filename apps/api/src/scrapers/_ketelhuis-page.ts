/**
 * Film-index en detailpagina's van ketelhuis.nl uit de HTML.
 *
 * De pagina's zijn server-rendered en dragen hun voorstellingen in
 * JSON-LD; tot 13 sep 2026 werd dit met Playwright uit de DOM gelezen.
 * Apart van ketelhuis.ts zodat het te testen is zonder DB-verbinding.
 */

export type FilmPage = {
  blocks: string[];
  ogImage: string | null;
  titleH1: string | null;
  descP: string | null;
};

function tekst(fragment: string | undefined): string | null {
  if (!fragment) return null;
  const t = fragment
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return t || null;
}

/** Unieke film-URLs van /films/. Alleen uit <a>: in een <link> zit de
    RSS-feed (/films/feed), en die is geen film. */
export function parseFilmUrls(html: string): string[] {
  const uit = new Set<string>();
  for (const m of html.matchAll(/<a\s[^>]*\bhref="([^"]*\/films\/[^"?#]+\/?)"/gi)) {
    const href = m[1]!;
    if (/\/films\/[^/]+\/?$/.test(href)) uit.add(href);
  }
  return [...uit];
}

export function parseFilmPage(html: string): FilmPage {
  const blocks = [...html.matchAll(
    /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi
  )].map((m) => m[1]!.trim()).filter(Boolean);

  const ogImage =
    html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]*)"/i)?.[1] ??
    html.match(/<meta[^>]+content="([^"]*)"[^>]+property="og:image"/i)?.[1] ??
    null;

  const titleH1 = tekst(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]);

  // querySelector('.single-film p, main p, article p') pakt het eerste
  // element in documentvolgorde dat aan één van die selectors voldoet.
  // Dus: bepaal de regio, pak daarbinnen de eerste <p>.
  const regio =
    html.match(/<[^>]*\bclass="[^"]*\bsingle-film\b[^"]*"[^>]*>([\s\S]*)$/i)?.[1] ??
    html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ??
    html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ??
    '';
  const descP = tekst(regio.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1]);

  return { blocks, ogImage, titleH1, descP };
}
