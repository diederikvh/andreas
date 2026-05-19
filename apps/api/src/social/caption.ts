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

const SYSTEM_PROMPT = `Je schrijft Nederlandse IG-captions voor Andreas — een Amsterdam-uitgaansapp. De carrousel toont picks voor de aankomende week (4 tips, verspreid over verschillende dagen); jouw caption maakt concreet wat er speelt, vermeldt per pick de dag, en tagt de venues.

Toon: terloops en feitelijk. Korte zinnen of fragmenten. Geen brochure, geen tagline, geen sfeerpoëzie ("voor wie thuis wou blijven", "een avond waar je iets doet"). Vertel wát er is, niet hoe 't voelt.

Structuur:
- Eén pick krijgt een korte concrete vermelding (titel of wat 't is) + dag + venue als @-mention.
- De andere venues mét handle worden compact erbij genoemd, telkens met de dag erbij. Vorm: "Verder @x (donderdag) en @y (zaterdag)." Nieuwe regel mag.
- Venues zonder handle laat je weg in de mentions-rij, maar mag je wel in de hoofdzin gebruiken als ze de focus zijn.

Strikte regels:
- Maximaal 3 korte regels in de hoofdtekst.
- Tag ALLE picks die een IG-handle hebben (staat tussen haken als "@handle" in de input). Eén pick uitgebreid, rest compact — en altijd met de dag erbij zodat lezers ook later in de week weten wanneer.
- Geen kapstok-openingszin die "vanavond" of "vandaag" suggereert — de picks staan op verschillende dagen.
- Het exacte aantal picks niet noemen ("vier", "drie") — laat de carrousel het volume tonen.
- Geen vragen, geen uitroeptekens, geen verkooppraat ("vergeet niet", "mis dit niet").
- Geen vage sfeerwoorden ("leuk", "lekker", "fijn", "mooi") — wees concreet.
- Hashtags op laatste regel: lowercase, exact 2-3 stuks, altijd #andreas en #amsterdam.

Voorbeelden (fictief, alleen voor stem en structuur):

---
Bazart bij @paradisoadam, vrijdag — Belgische rock.
Verder @melkweg (dinsdag), @ot301 (donderdag), @sissisamsterdam (zaterdag).
#andreas #amsterdam
---
Iron Maiden in @melkweg, zondag — niet de band, een film.
Daarna @ot301 (woensdag) en @sissisamsterdam (vrijdag).
#andreas #amsterdam
---
Geometrisch Abstract bij @artietamicitiae, expo tot zes — woensdag tip.
Verder @paradisoadam (vr) en @ot301 (za).
#andreas #amsterdam #kunst
---
@theatermascini speelt Hoogeboom op donderdag.
Daarna @splendor (vr) en @denieuweanita (zo).
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
  return [
    'Komende week in Amsterdam.',
    input.picks
      .slice(0, 3)
      .map((p) => `${p.venueName} (${formatWeekdayInAmsterdam(p.startsAt)}).`)
      .join(' '),
    '',
    '#andreas #amsterdam',
  ].join('\n');
}

function formatTimeInAmsterdam(d: Date): string {
  return new Intl.DateTimeFormat('nl-NL', {
    timeZone: 'Europe/Amsterdam',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

/** "vrijdag" — locale-aware lange dagnaam in Amsterdam tz, voor in de
    prompt en de fallback-caption zodat Claude (en wij) per pick weten
    op welke dag 't valt. */
function formatWeekdayInAmsterdam(d: Date): string {
  return new Intl.DateTimeFormat('nl-NL', {
    timeZone: 'Europe/Amsterdam',
    weekday: 'long',
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
  const weekday = formatWeekdayInAmsterdam(p.startsAt);
  return `- ${p.title} — ${venueLabel}, ${weekday} ${timeLabel}${typeStr}`;
}

export async function generateCaption(
  input: CaptionInput
): Promise<CaptionResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { caption: fallbackCaption(input), source: 'fallback' };
  }

  const publishDate = new Intl.DateTimeFormat('nl-NL', {
    timeZone: 'Europe/Amsterdam',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(input.date);

  const userMessage = [
    `Publicatiedag: ${publishDate}.`,
    'Picks (verspreid over de aankomende week — vermeld per pick de dag):',
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
