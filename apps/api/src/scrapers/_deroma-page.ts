/**
 * Parsers voor deroma.be. Apart van deroma.ts zodat ze te testen zijn
 * zonder DB-verbinding.
 *
 * De agenda is server-rendered: tien pagina's van zestien tegels via
 * `?page=N`. Elke tegel draagt titel, datum, tijd, beeld en een korte
 * teaser. De detailpagina heeft JSON-LD met de volle omschrijving en de
 * zaal.
 *
 * Let op de datums in die JSON-LD: `2026-09-13CEST20:00:00+0200`. Daar
 * zit de tijdzone-afkorting letterlijk tussen datum en tijd en de
 * offset mist z'n dubbele punt — `new Date()` geeft daar Invalid Date
 * op. Vandaar dat we de tegel als bron voor de starttijd nemen en deze
 * string alleen uitkleden voor de eindtijd.
 */

export type RomaTile = {
  url: string;
  title: string;
  date: string;           // YYYY-MM-DD uit het datetime-attribuut
  time: string | null;    // HH:MM achter de bullet
  imageUrl: string | null;
  teaser: string | null;
  soldOut: boolean;
};

const ORIGIN = 'https://www.deroma.be';

function tekst(fragment: string | undefined): string | null {
  if (!fragment) return null;
  const t = fragment
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
  return t || null;
}

export function parseRomaTiles(html: string): RomaTile[] {
  const uit: RomaTile[] = [];
  for (const m of html.matchAll(/<article class="event-tile">([\s\S]*?)<\/article>/g)) {
    const t = m[1]!;
    const href = t.match(/href="(\/[a-z]{2}\/event\/[^"]+)"/i)?.[1];
    const title = tekst(t.match(/<h3[^>]*class="[^"]*event-tile__title[^"]*"[^>]*>([\s\S]*?)<\/h3>/i)?.[1]);
    const tijd = t.match(/<time[^>]*datetime="(\d{4}-\d{2}-\d{2})"[^>]*>([\s\S]*?)<\/time>/i);
    if (!href || !title || !tijd) continue;
    const status = tekst(t.match(/class="[^"]*event-tile__status[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1]);
    uit.push({
      url: ORIGIN + href,
      title,
      date: tijd[1]!,
      // "zo 13 september • 20:00" — de tijd staat achter de bullet.
      time: tekst(tijd[2])?.match(/(\d{1,2}:\d{2})/)?.[1] ?? null,
      imageUrl: t.match(/<img[^>]*\bsrc="([^"]+)"/i)?.[1] ?? null,
      teaser: tekst(t.match(/class="[^"]*event-tile__teaser[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1]),
      soldOut: /uitverkocht|sold\s*out/i.test(status ?? ''),
    });
  }
  return uit;
}

export type RomaDetail = {
  description: string | null;
  room: string | null;
  /** "2026-09-13T21:05:00" — wandkloktijd, zonder de rare afkorting. */
  endLocal: string | null;
};

/** Haal `2026-09-13CEST21:05:00+0200` uit elkaar naar een kale
    wandklok-ISO. Geeft null als het formaat niet klopt. */
export function romaWallClock(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})[A-Za-z]*T?(\d{2}:\d{2}:\d{2})/);
  return m ? `${m[1]}T${m[2]}` : null;
}

export function parseRomaDetail(html: string): RomaDetail {
  const leeg: RomaDetail = { description: null, room: null, endLocal: null };
  const m = html.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return leeg;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(m[1]!) as Record<string, unknown>;
  } catch {
    return leeg;
  }
  if (j['@type'] !== 'Event') return leeg;
  const loc = j.location as { name?: string } | undefined;
  return {
    description: tekst(typeof j.description === 'string' ? j.description : undefined),
    room: loc?.name?.trim() || null,
    endLocal: romaWallClock(j.endDate),
  };
}
