/**
 * Agendakaarten uit de HTML van muziekgebouw.nl/nl/agenda.
 *
 * Apart van muziekgebouw.ts zodat dit te testen is zonder DB-verbinding.
 * Dit was een `page.evaluate` met querySelectors; de pagina blijkt
 * server-rendered, dus een kale fetch volstaat. Twintig kaarten per
 * pagina, doorbladeren via ?page=N.
 */

export type RawCard = {
  title: string | null;
  subtitle: string | null;
  dateText: string | null;
  timeText: string | null;
  room: string | null;
  tagline: string | null;
  href: string | null;
  imageUrl: string | null;
};

const tekst = (s: string | undefined): string | null => {
  if (s === undefined) return null;
  const t = s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return t || null;
};

/** Eerste treffer van `<tag class="...naam...">inhoud</tag>` binnen één kaart. */
function veld(kaart: string, naam: string): string | null {
  const re = new RegExp(
    `<(h[1-6]|div|span|p)[^>]*\\bclass="[^"]*\\b${naam}\\b[^"]*"[^>]*>([\\s\\S]*?)</\\1>`,
    'i'
  );
  return tekst(kaart.match(re)?.[2]);
}

export function parseAgendaCards(html: string): { cards: RawCard[]; hasNext: boolean } {
  // Splitsen op de kaart-opening: elk stuk loopt tot de volgende kaart,
  // dus een veld-regex kan niet per ongeluk bij de buren kijken.
  const stukken = html.split(/(?=<li[^>]*class="[^"]*\beventCard\b)/).slice(1);
  const cards = stukken.map((k) => ({
    title: veld(k, 'title'),
    subtitle: veld(k, 'subtitle'),
    dateText: veld(k, 'start'),
    timeText: veld(k, 'time'),
    room: veld(k, 'venue'),
    tagline: veld(k, 'tagline'),
    href: k.match(/<a[^>]*\bclass="[^"]*\bdesc\b[^"]*"[^>]*\bhref="([^"]+)"/i)?.[1] ?? null,
    // De thumb staat vóór de rest van de kaart, dus de eerste <img> is
    // de juiste. <source srcset> ervoor negeren we bewust: die is
    // afgesneden op een andere ratio.
    imageUrl: k.match(/<img[^>]*\bsrc="([^"]+)"/i)?.[1] ?? null,
  }));
  const hasNext = /<a[^>]*\bclass="[^"]*\bnext\b[^"]*"/i.test(html);
  return { cards, hasNext };
}
