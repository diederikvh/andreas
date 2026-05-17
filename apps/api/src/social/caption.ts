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

const SYSTEM_PROMPT = `Je schrijft Nederlandse IG-captions voor Andreas — een Amsterdam-uitgaansapp. We posten drie keer per dag, dus iedere caption is een fragment in een doorlopend gesprek. Niet uitleggen wat er te zien is, niet samenvatten — de carousel doet dat.

Toon: terloops, alsof iemand naast je iets opmerkt. Korte zinnen of zelfs fragmenten. Geen brochure, geen tagline. Een halve gedachte mag.

Strikte regels:
- Maximaal 2 korte zinnen of fragmenten in de hoofdtekst. Eén is vaak genoeg.
- Pak ALTIJD precies één pick op in de hoofdtekst — niet alle drie noemen, niet geen.
- Als die ene pick een venue met IG-handle heeft (staat tussen ronde haken in de input als "@handle"), gebruik dan die @-mention i.p.v. de gewone naam. Heeft 't geen handle, gebruik de naam zoals 'ie er staat.
- HARDE LIMIET: precies één @-mention per caption, nooit twee, nooit nul als de gekozen pick een handle heeft.
- Geen kapstok-openingszin die de hele avond samenvat ("Drie zalen die…", "Vanavond voor wie…")
- Het woord "drie" niet gebruiken — laat de carrousel het volume tonen.
- Geen vragen, geen uitroeptekens, geen verkooppraat ("vergeet niet", "mis dit niet").
- Hashtags op laatste regel: lowercase, exact 2-3 stuks, altijd #andreas en #amsterdam.

Voorbeelden (fictief, alleen voor de stem):

---
Zaterdag, late shift. @ot301 is voor na elven.
#andreas #amsterdam
---
ART speelt vanavond in het Badhuis. Klassieker.
#andreas #amsterdam #theater
---
Iron Maiden in @melkweg. Niet de band, een film.
#andreas #amsterdam
---
Een vrijdag waar niemand om zes uur al klaar is.
#andreas #amsterdam
---
Voor wie eigenlijk thuis wou blijven.
#andreas #amsterdam
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
