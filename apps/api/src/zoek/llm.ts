/**
 * LLM-stappen van de conversationele zoek.
 *
 * Twee gescheiden calls (brief §2):
 *  [1] runProfileUpdate — werkt het voorkeursprofiel bij op basis van het
 *      laatste bericht. Draait VÓÓR de retrieval, zodat de tijd-window/prijs/
 *      uitsluitingen van de huidige beurt meteen de kandidaten bepalen
 *      (anders loopt de retrieval een beurt achter). Goedkoop model.
 *  [3] runZoekTurn — kiest 3–5 events UITSLUITEND uit de aangereikte
 *      kandidaten en schrijft het gespreksantwoord. Verzint nooit iets.
 *
 * Zelfde raw-fetch-pattern als _genre-classifier.ts / caption.ts; de
 * ANTHROPIC_API_KEY blijft serverside.
 */
import type {
  PreferenceProfile,
  ZoekCandidate,
  ZoekChatTurn,
} from './types.js';

const ANTHROPIC_VERSION = '2023-06-01';
// Kiezen + natuurlijk NL-gesprek: sonnet. Profiel-extractie is licht: haiku.
const PRESENT_MODEL = 'claude-sonnet-4-6';
const PROFILE_MODEL = 'claude-haiku-4-5';

// ─── Gedeelde fetch-helper ───────────────────────────────────────────────────

type ToolUseBlock = { type: string; name?: string; input?: Record<string, unknown> };

/** Roept de Messages-API met geforceerde tool-keuze. Geeft de tool-input
    terug, of null bij geen key / non-200 / parse-fout. */
async function callTool(opts: {
  model: string;
  system: string;
  toolName: string;
  toolDescription: string;
  schema: unknown;
  messages: { role: string; content: string }[];
  maxTokens: number;
}): Promise<Record<string, unknown> | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens,
        system: opts.system,
        tools: [
          {
            name: opts.toolName,
            description: opts.toolDescription,
            input_schema: opts.schema,
          },
        ],
        tool_choice: { type: 'tool', name: opts.toolName },
        messages: opts.messages,
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      console.warn(`[zoek] Anthropic ${response.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const data = (await response.json()) as { content?: ToolUseBlock[] };
    const tool = data.content?.find(
      (b) => b.type === 'tool_use' && b.name === opts.toolName
    );
    return tool?.input ?? null;
  } catch (e) {
    console.warn('[zoek] Anthropic fetch failed:', (e as Error).message);
    return null;
  }
}

// ─── [1] Profiel-update ──────────────────────────────────────────────────────

const PROFILE_SCHEMA = {
  type: 'object',
  properties: {
    want: { type: 'array', items: { type: 'string' } },
    avoid: { type: 'array', items: { type: 'string' } },
    excludeVenueIds: { type: 'array', items: { type: 'string' } },
    excludeEventIds: { type: 'array', items: { type: 'string' } },
    maxDistanceKm: { type: ['number', 'null'] },
    priceMax: { type: ['integer', 'null'], enum: [0, 1, 2, 3, null] },
    when: {
      type: 'string',
      enum: [
        'tonight',
        'this_weekend',
        'this_week',
        'this_month',
        'this_year',
        'next_weekend',
        'next_week',
        'next_month',
        'specific',
      ],
    },
    whenDate: { type: 'string', description: 'YYYY-MM-DD, alleen bij when=specific.' },
  },
  required: [
    'want',
    'avoid',
    'excludeVenueIds',
    'excludeEventIds',
    'maxDistanceKm',
    'priceMax',
    'when',
  ],
} as const;

function nlDateContext(now: Date): { iso: string; human: string } {
  const iso = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam',
  }).format(now);
  const human = new Intl.DateTimeFormat('nl-NL', {
    timeZone: 'Europe/Amsterdam',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(now);
  return { iso, human };
}

export type ProfileUpdateArgs = {
  message: string;
  profile: PreferenceProfile;
  history: ZoekChatTurn[];
};

/**
 * Werk het profiel bij op basis van het laatste bericht. Verandert alleen
 * wat het bericht aangeeft; behoudt de rest. Bij geen key/fout: geef het
 * binnengekomen profiel ongewijzigd terug (retrieval draait dan op de
 * bestaande staat).
 */
export async function runProfileUpdate(
  args: ProfileUpdateArgs,
  now: Date
): Promise<PreferenceProfile> {
  const { iso, human } = nlDateContext(now);

  const system =
    'Je onderhoudt een zoekprofiel voor een uitgaans-app in Amsterdam. ' +
    `Vandaag is ${human} (${iso}). ` +
    'Werk het profiel bij op basis van het LAATSTE bericht van de gebruiker. ' +
    'Verander alleen wat dit bericht aangeeft; behoud de rest van het profiel.\n\n' +
    'Bepaal `when`:\n' +
    '- "tonight" — vanavond, vannacht, nu, straks.\n' +
    '- "this_weekend" — dit weekend, vrijdag/zaterdag/zondag als groep.\n' +
    '- "this_week" — deze week, de hele week, komende dagen.\n' +
    '- "this_month" — deze maand, komende weken.\n' +
    '- "this_year" — dit jaar, komende maanden.\n' +
    '- "next_weekend" — volgend weekend (het weekend ná dit).\n' +
    '- "next_week" — volgende week (de kalenderweek ná deze).\n' +
    '- "next_month" — volgende maand.\n' +
    'Let op: "volgende week/weekend/maand" verwijst naar de periode ná de ' +
    'huidige — gebruik dan next_*, NIET this_*.\n' +
    '- "specific" — één concrete dag (morgen, of een weekdag zoals "vrijdag"); ' +
    'zet dan `whenDate` op de eerstvolgende datum die daarbij past (YYYY-MM-DD).\n' +
    'Kies altijd de ruimste periode die het bericht noemt (bv. "deze maand" → this_month). ' +
    'Vraagt de gebruiker om meer/andere opties, een langere of latere periode, of is ' +
    'hij ontevreden over wat er vanavond is? Verbreed dan `when` een stap ' +
    '(tonight → this_week → this_month → this_year). ' +
    'Noemt het bericht geen tijd én geen wens om te verbreden? Laat `when` ongewijzigd.\n\n' +
    'Genoemde genres/sferen → `want`. Afgewezen genres/sferen → `avoid` ' +
    '(en haal ze uit `want`). Prijswens → `priceMax` (0 gratis · 1 goedkoop · ' +
    '2 gemiddeld · 3 duur mag). "Niet te ver" zonder afstand: laat ' +
    '`maxDistanceKm` null (we hebben geen locatie).';

  const userContent =
    `HUIDIG PROFIEL:\n${JSON.stringify(args.profile)}\n\n` +
    `LAATSTE BERICHT:\n${args.message}`;

  const messages = [
    ...args.history.map((t) => ({ role: t.role, content: t.content })),
    { role: 'user', content: userContent },
  ];

  const raw = await callTool({
    model: PROFILE_MODEL,
    system,
    toolName: 'update_profile',
    toolDescription:
      'Geef het volledige, bijgewerkte voorkeursprofiel terug. Verander alleen ' +
      'wat het laatste bericht aangeeft.',
    schema: PROFILE_SCHEMA,
    messages,
    maxTokens: 400,
  });

  return sanitizeProfile(raw, args.profile);
}

// ─── [3] Kiezen + gesprek ────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Je bent de uitgaans-gids van ANDREAS, een agenda-app voor Amsterdam. Je helpt iemand in een kort gesprek de juiste avond te kiezen uit het écht beschikbare aanbod.

Je krijgt per beurt het ANDREAS-AANBOD: de events die voor de gevraagde periode beschikbaar zijn. Dat is je enige bron.

REGELS — strikt:
- Kies events UITSLUITEND uit het aangereikte aanbod. Noem nooit een event, venue, tijd of prijs die daar niet in staat. Verzin niets.
- Kies ALLEEN events die echt bij de wens passen. Past er niets of bijna niets? Geef dan een lege lijst (chosenEventIds: []) en zeg dat eerlijk, met een richting (verder weg, andere avond, ander genre). Vul NOOIT aan met events die niet matchen — drie goede is beter dan vijf middelmatige, en nul is beter dan iets willekeurigs.
- Je antwoord mag geen dag, datum of tijd noemen die niet exact klopt met de gekozen events. Zeg niet "vanavond" als de events op een andere dag vallen. Bij twijfel: noem geen tijdsaanduiding — de kaarten tonen de tijd zelf.
- Beloof geen acties buiten dit gesprek: je kunt geen notificaties sturen, niets "onthouden voor later" of achteraf iets opsturen. Bied alleen aan om nú anders te zoeken.
- Reageer op afwijzingen door dit in je keuze mee te nemen (een afgewezen venue of genre niet opnieuw voorstellen).

TOON:
- Kort, direct, sfeervol. Nederlands. Geen superlatieven ("geweldig", "fantastisch", "te gek"), geen uitroeptekens, geen verkooptaal.
- Gebruik de woorden "kandidaat", "kandidaten" of "kandidatenlijst" NIET in je antwoord. Spreek over "het aanbod" of "wat er is".
- Eén of twee zinnen per antwoord is genoeg; de events spreken voor zich.
- Stel hooguit één gerichte vervolgvraag, en alleen als de wens echt te vaag is om te kiezen.`;

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    chosenEventIds: {
      type: 'array',
      items: { type: 'string' },
      description:
        "Alleen id's die exact in het aangereikte aanbod voorkomen. 3 tot 5 als ze passen; leeg als niets past.",
    },
    reasonByEventId: {
      type: 'object',
      description: 'Per gekozen event-id één korte zin waarom het past.',
      additionalProperties: { type: 'string' },
    },
    reply: {
      type: 'string',
      description: 'Gespreksantwoord in het Nederlands, kort en zonder superlatieven.',
    },
    needsMoreInfo: {
      type: 'string',
      description: 'Optioneel: één gerichte vervolgvraag als de wens nog te vaag is.',
    },
  },
  required: ['chosenEventIds', 'reasonByEventId', 'reply'],
} as const;

export type ZoekTurnResult = {
  chosenEventIds: string[];
  reply: string;
  reasonByEventId: Record<string, string>;
  needsMoreInfo?: string;
  /** Aantal door het LLM genoemde ids die NIET in de kandidaten zaten —
      vangnet-telemetrie (brief §9). >0 = systeemprompt aanscherpen. */
  hallucinatedIdCount: number;
};

export type RunTurnArgs = {
  message: string;
  profile: PreferenceProfile;
  history: ZoekChatTurn[];
  candidates: ZoekCandidate[];
  sparse: boolean;
};

/**
 * Kies + praat. Geeft `null` terug bij geen key / fout — de route valt dan
 * terug op een neutraal antwoord met de top-kandidaten.
 */
export async function runZoekTurn(args: RunTurnArgs): Promise<ZoekTurnResult | null> {
  const candidateIds = new Set(args.candidates.map((c) => c.id));

  const userContent = [
    `HUIDIG PROFIEL:\n${JSON.stringify(args.profile)}`,
    args.sparse
      ? 'LET OP: er zijn minder dan 3 passende events in het aanbod. Wees eerlijk en bied een richting aan i.p.v. de lijst vol te maken.'
      : '',
    `ANDREAS-AANBOD (kies alleen hieruit):\n${JSON.stringify(args.candidates)}`,
    `BERICHT VAN GEBRUIKER:\n${args.message}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const messages = [
    ...args.history.map((t) => ({ role: t.role, content: t.content })),
    { role: 'user', content: userContent },
  ];

  const raw = await callTool({
    model: PRESENT_MODEL,
    system: SYSTEM_PROMPT,
    toolName: 'present_events',
    toolDescription:
      'Kies 0 tot 5 passende events UITSLUITEND uit het aangereikte Andreas-aanbod en schrijf een kort, natuurlijk gespreksantwoord in het Nederlands. Verzin nooit events, venues, tijden of prijzen.',
    schema: TOOL_SCHEMA,
    messages,
    maxTokens: 1024,
  });
  if (!raw) return null;

  // Validatie ná de call (brief §6): gooi onbekende ids weg — het vangnet
  // tegen hallucinatie. De frontend rendert events uitsluitend uit DB-data
  // op basis van deze gevalideerde ids, nooit uit `reply`.
  const requested = Array.isArray(raw.chosenEventIds)
    ? (raw.chosenEventIds as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  const chosenEventIds = requested.filter((id) => candidateIds.has(id));
  const hallucinatedIdCount = requested.length - chosenEventIds.length;
  if (hallucinatedIdCount > 0) {
    console.warn(`[zoek] ${hallucinatedIdCount} onbekende event-id(s) van LLM weggegooid`);
  }

  const reasonByEventId: Record<string, string> = {};
  const rawReasons = (raw.reasonByEventId ?? {}) as Record<string, unknown>;
  for (const id of chosenEventIds) {
    const r = rawReasons[id];
    if (typeof r === 'string') reasonByEventId[id] = r;
  }

  return {
    chosenEventIds,
    reply: typeof raw.reply === 'string' ? raw.reply : '',
    reasonByEventId,
    needsMoreInfo:
      typeof raw.needsMoreInfo === 'string' && raw.needsMoreInfo.trim()
        ? raw.needsMoreInfo
        : undefined,
    hallucinatedIdCount,
  };
}

// ─── Profiel-sanitisatie ─────────────────────────────────────────────────────

const WHENS = new Set(['tonight', 'this_weekend', 'this_week', 'specific']);

/** Defensief mergen: neem geldige velden uit het LLM-profiel, val terug op
    het binnengekomen profiel zodat een half-leeg model-object niets wist. */
function sanitizeProfile(
  raw: unknown,
  prev: PreferenceProfile
): PreferenceProfile {
  const p = (raw ?? {}) as Record<string, unknown>;
  const strArr = (v: unknown, fallback: string[]): string[] =>
    Array.isArray(v) && v.every((x) => typeof x === 'string')
      ? (v as string[])
      : fallback;

  const priceMax =
    p.priceMax === 0 || p.priceMax === 1 || p.priceMax === 2 || p.priceMax === 3
      ? (p.priceMax as 0 | 1 | 2 | 3)
      : p.priceMax === null
        ? null
        : prev.priceMax;

  const origin =
    p.origin &&
    typeof p.origin === 'object' &&
    typeof (p.origin as { lat?: unknown }).lat === 'number' &&
    typeof (p.origin as { lng?: unknown }).lng === 'number'
      ? (p.origin as { lat: number; lng: number })
      : prev.origin;

  return {
    want: strArr(p.want, prev.want),
    avoid: strArr(p.avoid, prev.avoid),
    excludeVenueIds: strArr(p.excludeVenueIds, prev.excludeVenueIds),
    excludeEventIds: strArr(p.excludeEventIds, prev.excludeEventIds),
    maxDistanceKm:
      typeof p.maxDistanceKm === 'number'
        ? p.maxDistanceKm
        : p.maxDistanceKm === null
          ? null
          : prev.maxDistanceKm,
    priceMax,
    when: typeof p.when === 'string' && WHENS.has(p.when)
      ? (p.when as PreferenceProfile['when'])
      : prev.when,
    whenDate: typeof p.whenDate === 'string' ? p.whenDate : prev.whenDate,
    origin,
  };
}
