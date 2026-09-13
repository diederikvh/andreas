/**
 * Agendategels uit de HTML van q-factory.com/nl.
 *
 * De pagina is server-rendered (Next.js/Storyblok); tot 13 sep 2026 werd
 * dit met Playwright uit de DOM gelezen. Apart van qfactory.ts zodat het
 * te testen is zonder DB-verbinding.
 *
 * De klassen zijn Tailwind-utility's en veranderen bij elke
 * design-tweak, dus daar selecteren we niet op. Wel op de structuur die
 * betekenis draagt: het datumformaat "Vr.18.Sep" en het `id="SH-.."` van
 * de titel.
 */

export type RawTile = {
  date: string;
  title: string;
  description: string;
  room: string;
  tags: string[];
  imageUrl: string;
};

const ORIGIN = 'https://q-factory.com';
const ZALEN = ['Grote Zaal', 'Q-Cafe', 'Loungezaal', 'Foyer', 'Kleine Zaal'];
const DATUM = /^(Ma|Di|Wo|Do|Vr|Za|Zo)\.\d{1,2}\./;

function tekst(fragment: string | undefined): string {
  if (!fragment) return '';
  return fragment
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseQfactoryTiles(html: string): RawTile[] {
  const i = html.indexOf('all-events-section');
  if (i < 0) return [];
  const sectie = html.slice(i);
  const out: RawTile[] = [];

  for (const tegel of sectie.split(/(?=<div[^>]*class="[^"]*cursor-pointer)/).slice(1)) {
    // `img.src` in de DOM is absoluut en heeft z'n entities al
    // gedecodeerd; het rauwe attribuut is relatief en bevat &amp;.
    // Beide gelijktrekken, anders faalt de image-mirror op een pad
    // zonder host.
    const ruw = tegel.match(/<img[^>]*\bsrc="([^"]+)"/i)?.[1] ?? '';
    if (!ruw) continue;
    const imageUrl = new URL(ruw.replace(/&amp;/g, '&'), ORIGIN).toString();

    const spans = [...tegel.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/gi)]
      .map((m) => tekst(m[1]))
      .filter(Boolean);
    const date = spans.find((s) => DATUM.test(s));
    if (!date) continue;

    const title = tekst(tegel.match(/<span[^>]*\bid="SH-[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1])
      || tekst(tegel.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i)?.[1]);

    // Zelfde aanpak als de DOM-versie: alles ná de titel is de
    // omschrijving, met de zaalnaam eruit.
    const vol = tekst(tegel);
    const idx = title ? vol.indexOf(title) : -1;
    let description = idx >= 0 && title ? vol.slice(idx + title.length).trim() : '';

    const laatste = spans.slice(-6);
    const room = laatste.find((s) => ZALEN.includes(s)) ?? '';
    const tags = laatste.filter(
      (s) =>
        !DATUM.test(s) &&
        s !== title &&
        s !== room &&
        s.length < 40 &&
        !/keert terug|terug|tijdens/i.test(s)
    );

    if (room) description = description.replace(room, '').trim();
    out.push({
      date,
      title,
      description: description.slice(0, 600),
      room,
      tags: [...new Set(tags)].slice(0, 5),
      imageUrl,
    });
  }
  return out;
}
