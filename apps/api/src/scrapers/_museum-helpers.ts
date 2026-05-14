/**
 * Gedeelde helpers voor de museum-scrapers (rijksmuseum, vangoghmuseum,
 * cobramuseum, wereldmuseum, amsterdammuseum, nxtmuseum). Alle musea
 * volgen hetzelfde 2-step patroon:
 *
 *   1. Listing-page → URLs van detail-pages.
 *   2. Per detail-page → titel/image/datum-range parsen.
 *
 * Gemeenschappelijke bouwstenen:
 *   - `fetchHtml`: nette UA, returns null bij errors.
 *   - `decode` / `stripHtml`: minimale HTML entity-decode + tag-strip.
 *   - `shiftToLocalTime`: bouwt een Date in Europe/Amsterdam.
 *   - `parseDateRange*`: NL en EN varianten van "D maand YYYY tot/till
 *     D maand YYYY".
 *   - `parseOgTags`: pakt og:title / og:image / og:description.
 */

const NL_MONTHS: Record<string, number> = {
  januari: 0, jan: 0,
  februari: 1, feb: 1,
  maart: 2, mrt: 2,
  april: 3, apr: 3,
  mei: 4,
  juni: 5, jun: 5,
  juli: 6, jul: 6,
  augustus: 7, aug: 7,
  september: 8, sep: 8, sept: 8,
  oktober: 9, okt: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
};

const EN_MONTHS: Record<string, number> = {
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sep: 8, sept: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
};

export const ANDREAS_UA =
  'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';

export async function fetchHtml(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { 'user-agent': ANDREAS_UA } });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

export function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(parseInt(c, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, c) =>
      String.fromCodePoint(parseInt(c, 16))
    )
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

export function stripHtml(s: string): string {
  return decode(s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
}

export function shiftToLocalTime(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number
): Date {
  const tentative = new Date(Date.UTC(y, mo, d, h, mi, 0));
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Amsterdam',
    timeZoneName: 'longOffset',
  });
  const off = dtf
    .formatToParts(tentative)
    .find((p) => p.type === 'timeZoneName')?.value;
  const m = off?.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  const sign = m && m[1] === '+' ? 1 : -1;
  const oh = m ? parseInt(m[2], 10) : 0;
  const om = m ? parseInt(m[3] ?? '0', 10) : 0;
  return new Date(tentative.getTime() - sign * (oh * 60 + om) * 60_000);
}

/**
 * Pak een NL-datum range. Ondersteunt:
 *   - "13 februari 2026 tot 17 mei 2026"
 *   - "13 februari tot 17 mei 2026"  (start-jaar geinheriteerd)
 *   - "13 februari 2026 t/m 17 mei 2026"
 *   - "13 februari 2026 – 17 mei 2026"
 *   - "tot 17 mei 2026"  / "t/m 17 mei 2026"  (open-ended start; we
 *     gebruiken `now` als start zodat het event direct zichtbaar wordt)
 *   - "vanaf 13 februari 2026"  (geen end; we vullen aan met +6 maanden)
 */
export function parseDateRangeNL(text: string): {
  start: Date;
  end: Date;
} | null {
  // Eerst: volledige range "D maand [YYYY] (tot|t/m|–|—|-) D maand YYYY"
  const range = text.match(
    /(\d{1,2})\s+([a-zA-Z]+)(?:\s+(\d{4}))?\s+(?:tot en met|t\/m|tot|–|—|-)\s+(\d{1,2})\s+([a-zA-Z]+)\s+(\d{4})/i
  );
  if (range) {
    const sm = NL_MONTHS[range[2].toLowerCase()];
    const em = NL_MONTHS[range[5].toLowerCase()];
    if (sm !== undefined && em !== undefined) {
      const ey = parseInt(range[6], 10);
      let sy = range[3] ? parseInt(range[3], 10) : ey;
      if (!range[3] && sm > em) sy -= 1;
      return {
        start: shiftToLocalTime(sy, sm, parseInt(range[1], 10), 11, 0),
        end: shiftToLocalTime(ey, em, parseInt(range[4], 10), 18, 0),
      };
    }
  }
  // Open-ended start: "tot/t/m D maand YYYY"
  const endOnly = text.match(
    /(?:tot en met|t\/m|tot)\s+(\d{1,2})\s+([a-zA-Z]+)\s+(\d{4})/i
  );
  if (endOnly) {
    const em = NL_MONTHS[endOnly[2].toLowerCase()];
    if (em !== undefined) {
      const end = shiftToLocalTime(
        parseInt(endOnly[3], 10),
        em,
        parseInt(endOnly[1], 10),
        18,
        0
      );
      // Start = nu (zodat het event direct zichtbaar is). Voor
      // exhibitions die al lopen is dat correcter dan een fictieve
      // start. Voor toekomstige openings is dit OK want we hebben dan
      // toch geen betere data.
      return { start: new Date(), end };
    }
  }
  return null;
}

/**
 * EN-variant: "6 February till 25 May 2026" / "27 March 2026 to 21 March 2027".
 * Separators: till, to, until, through, –, —, -.
 */
export function parseDateRangeEN(text: string): {
  start: Date;
  end: Date;
} | null {
  const range = text.match(
    /(\d{1,2})\s+([A-Za-z]+)(?:\s+(\d{4}))?\s+(?:till|to|until|through|–|—|-)\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i
  );
  if (!range) return null;
  const sm = EN_MONTHS[range[2].toLowerCase()];
  const em = EN_MONTHS[range[5].toLowerCase()];
  if (sm === undefined || em === undefined) return null;
  const ey = parseInt(range[6], 10);
  let sy = range[3] ? parseInt(range[3], 10) : ey;
  if (!range[3] && sm > em) sy -= 1;
  return {
    start: shiftToLocalTime(sy, sm, parseInt(range[1], 10), 11, 0),
    end: shiftToLocalTime(ey, em, parseInt(range[4], 10), 18, 0),
  };
}

/**
 * Pakt alle og:* meta-tags uit de HTML-head. Met `baseUrl` worden
 * relatieve image-paden ("/assets/…") tot absolute URLs gemaakt —
 * Van Gogh Museum doet dat bv. expliciet.
 */
export function parseOgTags(
  html: string,
  baseUrl?: string
): {
  title: string | null;
  description: string | null;
  image: string | null;
} {
  const pick = (prop: string): string | null => {
    const re = new RegExp(
      `<meta\\s+property="og:${prop}"\\s+content="([^"]+)"`,
      'i'
    );
    const m = html.match(re);
    return m ? decode(m[1]) : null;
  };
  let image = pick('image');
  if (image && baseUrl && !image.match(/^https?:\/\//i)) {
    try {
      image = new URL(image, baseUrl).toString();
    } catch {
      image = null;
    }
  }
  return {
    title: pick('title'),
    description: pick('description'),
    image,
  };
}

/**
 * Helper om door HTML alle `<div class="markdown">…</div>` blokken te
 * lopen en de plain-text content terug te geven. Gebruikt door musea
 * waar de datum in een richtekst-blok zit (Rijksmuseum-stijl).
 */
export function extractTextBlocks(
  html: string,
  classNames: string[]
): string[] {
  const out: string[] = [];
  for (const cls of classNames) {
    const re = new RegExp(
      `<(?:div|section|article)\\s+[^>]*class="[^"]*${cls}[^"]*"[^>]*>([\\s\\S]*?)</(?:div|section|article)>`,
      'g'
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const text = stripHtml(m[1]);
      if (text) out.push(text);
    }
  }
  return out;
}
