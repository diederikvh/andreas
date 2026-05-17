/**
 * Caption-generator voor IG-posts. Roept Claude (Haiku 4.5) direct via
 * fetch aan — geen Anthropic SDK om consistent te blijven met de
 * bestaande scrapers (zie `scrapers/enrich.ts`).
 *
 * Tone-of-voice woont in de SYSTEM_PROMPT. Seed-voorbeelden zijn fictief
 * — als Diederik later een corpus van 10-15 'echte' captions levert
 * vervangen we die hier door zijn eigen voorbeelden.
 *
 * Fallback: als de API faalt of geen key gezet is, returnt een
 * deterministische template-caption zodat de pipeline niet breekt.
 */

const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = 'claude-haiku-4-5';

const SYSTEM_PROMPT = `Je schrijft Nederlandse IG-captions voor Andreas — een Amsterdam-uitgaansapp. Twee posts per dag (ochtend + avond). De carrousel toont drie picks; jouw caption maakt concreet wat er speelt en tagt de venues.

Toon: terloops en feitelijk. Korte zinnen of fragmenten. Geen brochure, geen tagline, geen sfeerpoëzie ("voor wie thuis wou blijven", "een avond waar je iets doet"). Vertel wát er is, niet hoe 't voelt.

Structuur:
- Eén pick krijgt een korte concrete vermelding (titel of wat 't is) en de venue als @-mention.
- De andere venues mét handle worden compact erbij genoemd. Vorm: "Daarna ook @x en @y." of "Of @x en @y." Nieuwe regel mag.
- Venues zonder handle laat je weg in de mentions-rij, maar mag je wel in de hoofdzin gebruiken als ze de focus zijn.

Strikte regels:
- Maximaal 3 korte regels in de hoofdtekst.
- Tag ALLE picks die een IG-handle hebben (staat tussen haken als "@handle" in de input). Eén pick uitgebreid, rest compact.
- Geen kapstok-openingszin die de hele dag samenvat ("Drie zalen die…", "Vanavond in Amsterdam:")
- Het woord "drie" niet gebruiken — laat de carrousel het volume tonen.
- Geen vragen, geen uitroeptekens, geen verkooppraat ("vergeet niet", "mis dit niet").
- Geen vage sfeerwoorden ("leuk", "lekker", "fijn", "mooi") — wees concreet.
- Hashtags op laatste regel: lowercase, exact 2-3 stuks, altijd #andreas en #amsterdam.

Voorbeelden (fictief, alleen voor stem en structuur):

---
Bazart in @paradisoadam, Belgische rock.
Ook @ot301 en @artietamicitiae open vanavond.
#andreas #amsterdam
---
Iron Maiden in @melkweg, niet de band — een film.
Daarna @ot301 en @sissisamsterdam.
#andreas #amsterdam
---
Geometrisch Abstract bij @artietamicitiae, expo tot zes.
Vanavond verder @paradisoadam en @ot301.
#andreas #amsterdam #kunst
---
@theatermascini speelt Hoogeboom. Daarna @splendor en @denieuweanita.
#andreas #amsterdam #theater
---`;

export interface CaptionPickInput {
  title: string;
  venueName: string;
  venueType: string | null;
  /** IG-handle van het venue zonder @ (bv. "paradiso"). Wordt aan Claude
      meegegeven zodat 'ie er @-mentions van kan maken. */
  venueInstagram: string | null;
  category: string;
  startsAt: Date;
  endsAt?: Date | null;
}

interface CaptionInput {
  picks: CaptionPickInput[];
  date: Date;
}

interface CaptionResult {
  caption: string;
  source: 'claude' | 'fallback';
}

/** Korte fallback-caption als de API niet beschikbaar is. Genereert
    een minimaal-bruikbare tekst zodat de admin-UI niet leeg blijft. */
function fallbackCaption(input: CaptionInput): string {
  const fmt = new Intl.DateTimeFormat('nl-NL', {
    timeZone: 'Europe/Amsterdam',
    weekday: 'long',
  });
  const day = fmt.format(input.date);
  return [
    `Vanavond — ${input.picks.length} picks voor ${day}.`,
    input.picks
      .slice(0, 2)
      .map((p) => `${p.venueName}.`)
      .join(' '),
    '',
    '#andreas #amsterdam #vanavond',
  ].join('\n');
}

function formatTimeInAmsterdam(d: Date): string {
  return new Intl.DateTimeFormat('nl-NL', {
    timeZone: 'Europe/Amsterdam',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

/**
 * Een "hele dag" event detecteren: startsAt = 00:00 en endsAt = 23:00
 * of later op dezelfde dag (of het volgt direct na in de nacht).
 * Scrapers vullen vaak 00:00 → 23:59 in voor doorlopende exposities of
 * full-day-events; die tijd toevoegen aan een caption/slide klopt niet.
 */
function isFullDay(startsAt: Date, endsAt: Date | null | undefined): boolean {
  if (!endsAt) return false;
  if (formatTimeInAmsterdam(startsAt) !== '00:00') return false;
  const end = formatTimeInAmsterdam(endsAt);
  return end === '23:59' || end === '23:00' || end === '00:00';
}

function formatPickForPrompt(p: CaptionPickInput): string {
  const typeBits = [p.venueType, p.category]
    .filter(Boolean)
    .map((s) => s!.toLowerCase())
    .filter((v, i, arr) => arr.indexOf(v) === i);
  const typeStr = typeBits.length > 0 ? ` (${typeBits.join(' / ')})` : '';
  const venueLabel = p.venueInstagram
    ? `${p.venueName} (@${p.venueInstagram})`
    : p.venueName;
  const fullDay = isFullDay(p.startsAt, p.endsAt ?? null);
  const timeLabel = fullDay ? 'hele dag' : formatTimeInAmsterdam(p.startsAt);
  return `- ${p.title} — ${venueLabel}, ${timeLabel}${typeStr}`;
}

export async function generateCaption(
  input: CaptionInput
): Promise<CaptionResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { caption: fallbackCaption(input), source: 'fallback' };
  }

  const dateLine = new Intl.DateTimeFormat('nl-NL', {
    timeZone: 'Europe/Amsterdam',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(input.date);

  const userMessage = [
    `Datum: ${dateLine}`,
    'Picks:',
    ...input.picks.map(formatPickForPrompt),
    '',
    'Schrijf één caption volgens het format. Alleen de caption, geen toelichting.',
  ].join('\n');

  let response: Response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
  } catch (e) {
    console.warn(`[caption] fetch failed: ${(e as Error).message}`);
    return { caption: fallbackCaption(input), source: 'fallback' };
  }

  if (!response.ok) {
    const body = await response.text();
    console.warn(`[caption] Anthropic ${response.status}: ${body.slice(0, 200)}`);
    return { caption: fallbackCaption(input), source: 'fallback' };
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text?: string }>;
  };
  const text = data.content.find((c) => c.type === 'text')?.text?.trim();
  if (!text) {
    console.warn('[caption] no text content in response');
    return { caption: fallbackCaption(input), source: 'fallback' };
  }

  return { caption: text, source: 'claude' };
}
