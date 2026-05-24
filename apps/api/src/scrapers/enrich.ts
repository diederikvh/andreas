/**
 * Claude-enrichment voor scraper-output. Neemt rauwe event-data
 * (titel + description) en haalt er gestructureerde metadata uit:
 * lineup, genres, zaal, prijs-noot, kind. Gebruikt tool-use zodat de
 * output altijd valide JSON is — geen markdown-blok-parsing.
 *
 * Strict prompt-regel: liever NULL dan een gok. Velden mogen alleen
 * gevuld worden als de bron er expliciet of zeer duidelijk naar
 * verwijst. Dit voorkomt "troep" in de DB.
 *
 * Model: Claude Haiku 4.5 — snel + goedkoop voor structured extraction.
 * 30 events/dag voor alle 5 Stager-venues = ~€0,15/maand aan API-kosten.
 */

const MODEL = 'claude-haiku-4-5';
const ANTHROPIC_VERSION = '2023-06-01';

const SYSTEM_PROMPT =
  'Je bent een metadata-extractor voor een Amsterdamse uitgaansapp.\n' +
  '\n' +
  'Je krijgt informatie over één event. Roep de tool `extract_event_metadata` aan met gestructureerde metadata.\n' +
  '\n' +
  'STRIKTE REGEL: vul ALLEEN velden in als de bron er letterlijk of onmiskenbaar naar verwijst. Bij twijfel: null of lege array. Geen guessing op basis van titel of venue-naam alleen.\n' +
  '\n' +
  'Aanwijzingen per veld:\n' +
  '- genres: lowercase tags (max 4) zoals techno, house, jazz, hip-hop, arthouse, drama, dans, kunst, lezing, klassiek, performance, ambient, queer. Alleen als de bron een genre noemt of context onmiskenbaar is. Bij twijfel: lege array.\n' +
  '- lineup: artiesten/acts EXPLICIET genoemd in de tekst, met optionele rol. Geldige rollen: "dj", "support", "headliner", "act". Geen guessing op titel-basis. Bij geen expliciete vermelding: null. GEEN generieke placeholders als naam ("support", "special guest", "tba", "opening act", "onbekend"); zulke aanduidingen horen alleen in `role`, niet in `name`. Skip ze als er geen echte naam bij staat.\n' +
  '- room: zaal binnen het venue (bv. "Grote Zaal", "Kleine Zaal", "Tomastheater") — alleen als zaal-naam expliciet vermeld. Adres of stad telt NIET. Bij twijfel: null.\n' +
  '- priceNote: ALLEEN als de tekst een notitie OVER PRIJS bevat: bv. "lidmaatschap vereist", "donatie", "pay-what-you-can", "CJP-korting", "studentenkorting beschikbaar", "vanaf €5". NIET voor leeftijdsgrenzen ("21+", "18+"), huisregels (geen telefoon, geen foto), of dresscode. Bij twijfel: null.\n' +
  '- kind: "show" voor concert/club/voorstelling/film/lezing/opening. "exhibition" voor doorlopende tentoonstelling. Default: "show".\n' +
  '- category: kies altijd één van "Muziek" | "Theater" | "Literatuur" | "Film" | "Kunst" | "Lezing" op basis van titel + beschrijving + venue-context. Geef je BESTE GOK — niet null tenzij er ECHT helemaal geen aanknopingspunt is. Heuristiek: tentoonstelling/installatie/galerie-opening = "Kunst". Concert/feest/dj-set/album launch = "Muziek". Theatervoorstelling/dans/cabaret/performance = "Theater". Film/screening/cinema = "Film". Boekpresentatie/poëzie-avond/spoken word/literair = "Literatuur". Publiek debat/talkshow/lezing/college/in gesprek met/keynote = "Lezing" (Pakhuis de Zwijger, De Balie, SPUI25-stijl programma). Een lezing op een kunstgalerie blijft "Lezing" — kies op event, niet op venue.\n' +
  '- cleanedDescription: de description in plain text, zonder de lineup-block en zonder herhaalde meta-info (huisregels, ~~~~~~~ separators). NIET inkorten of herschrijven — alleen lineup-blok en boilerplate weghalen. Gebruik ECHTE newlines voor paragraph-breaks, NIET de literal 2 tekens backslash-n.';

const TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    genres: {
      type: 'array',
      items: { type: 'string' },
      description: 'Lowercase genre-tags, max 4. Lege array als onbekend.',
    },
    lineup: {
      type: ['array', 'null'],
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          role: {
            type: ['string', 'null'],
            enum: ['dj', 'support', 'headliner', 'act', null],
          },
        },
        required: ['name'],
      },
      description: 'Lineup-array of null als niet expliciet vermeld.',
    },
    room: {
      type: ['string', 'null'],
      description: 'Zaal binnen venue, of null.',
    },
    priceNote: {
      type: ['string', 'null'],
      description: 'Korte prijs-noot, of null.',
    },
    kind: {
      type: 'string',
      enum: ['show', 'exhibition'],
      description: 'show (point-in-time) of exhibition (doorlopend).',
    },
    category: {
      type: ['string', 'null'],
      enum: ['Muziek', 'Theater', 'Literatuur', 'Film', 'Kunst', 'Lezing', null],
      description:
        'Andreas-categorie. Bij echte twijfel: null — caller valt dan terug op venue-default.',
    },
    cleanedDescription: {
      type: ['string', 'null'],
      description: 'Schoongemaakte description als plain text.',
    },
  },
  required: [
    'genres',
    'lineup',
    'room',
    'priceNote',
    'kind',
    'category',
    'cleanedDescription',
  ],
} as const;

const TOOL_DEF = {
  name: 'extract_event_metadata',
  description:
    'Sla gestructureerde event-metadata op. Vul alleen velden waarvoor de bron expliciet bewijs levert.',
  input_schema: TOOL_INPUT_SCHEMA,
};

const ALLOWED_ROLES = ['dj', 'support', 'headliner', 'act'] as const;
type Role = (typeof ALLOWED_ROLES)[number];

/**
 * Lineup-`name`-waardes die geen echte artiestnaam zijn maar generieke
 * placeholders ("support", "tba", "special guest", "onbekend"). Zulke
 * entries leveren een dood-linkje op de artist-pagina ("naast hoofd-act
 * Allegaeon staat ook nog 'support'") en moeten dus eruit. De rol mag
 * apart in `role` staan; alleen de naam verwerpen we.
 */
const LINEUP_PLACEHOLDER_NAME =
  /^(support|special guest|guest|opening act|opener|tba|t\.b\.a\.|to be announced|onbekend|nnb|n\.n\.b\.|nog niet bekend|nog onbekend|line[\s-]?up tba|line[\s-]?up t\.b\.a\.|various|various artists|aanvullende artiest|aanvulling)$/i;

export function isLineupPlaceholderName(name: string): boolean {
  return LINEUP_PLACEHOLDER_NAME.test(name.trim());
}

export type EnrichInput = {
  title: string;
  description: string | null;
  venueName: string;
  venueCategory: string;
};

export type EventCategory =
  | 'Muziek'
  | 'Theater'
  | 'Literatuur'
  | 'Film'
  | 'Kunst'
  | 'Lezing';

export type EnrichOutput = {
  genres: string[];
  lineup: { name: string; role?: Role }[] | null;
  room: string | null;
  priceNote: string | null;
  kind: 'show' | 'exhibition';
  category: EventCategory | null;
  cleanedDescription: string | null;
};

const ALLOWED_CATEGORIES: EventCategory[] = [
  'Muziek',
  'Theater',
  'Literatuur',
  'Film',
  'Kunst',
  'Lezing',
];

const FALLBACK: EnrichOutput = {
  genres: [],
  lineup: null,
  room: null,
  priceNote: null,
  kind: 'show',
  category: null,
  cleanedDescription: null,
};

/**
 * Verrijk een event met Claude. Bij geen API-key of bij een te magere
 * input (geen titel én geen description) geven we de FALLBACK terug.
 * Anders altijd een Claude-call — ook bij events met lege description,
 * want de titel + venue-context kan al genoeg zijn om category te
 * bepalen (een kunstenaars-residency met "Marion Verboom: 'Loplop'" is
 * onmiskenbaar Kunst, ongeacht of er een beschrijving bij staat).
 *
 * Errors worden gevangen en als FALLBACK teruggegeven zodat de scraper-
 * pipeline blijft draaien als Claude tijdelijk down is.
 */
export async function enrichEvent(input: EnrichInput): Promise<EnrichOutput> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ...FALLBACK, cleanedDescription: input.description };
  }
  const hasContent = (input.title ?? '').trim().length > 2;
  if (!hasContent) {
    return { ...FALLBACK, cleanedDescription: input.description };
  }

  const userMessage =
    `Venue: ${input.venueName} (categorie: ${input.venueCategory})\n` +
    `Event-titel: ${input.title}\n\n` +
    `Description:\n${input.description ?? '(geen beschrijving — bepaal velden op basis van titel + venue-context)'}`;

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
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        tools: [TOOL_DEF],
        tool_choice: { type: 'tool', name: TOOL_DEF.name },
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
  } catch (e) {
    console.warn(`[enrich] fetch failed: ${(e as Error).message}`);
    return { ...FALLBACK, cleanedDescription: input.description };
  }

  if (!response.ok) {
    const body = await response.text();
    console.warn(
      `[enrich] Anthropic ${response.status}: ${body.slice(0, 200)}`
    );
    return { ...FALLBACK, cleanedDescription: input.description };
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; name?: string; input?: unknown }>;
  };
  const toolUse = data.content.find(
    (c) => c.type === 'tool_use' && c.name === TOOL_DEF.name
  );
  if (!toolUse?.input || typeof toolUse.input !== 'object') {
    console.warn('[enrich] no tool_use in response');
    return { ...FALLBACK, cleanedDescription: input.description };
  }

  const raw = toolUse.input as Record<string, unknown>;

  const genres = Array.isArray(raw.genres)
    ? (raw.genres as unknown[])
        .filter((g): g is string => typeof g === 'string')
        .map((g) => g.trim().toLowerCase())
        .filter((g) => g.length > 0 && g.length < 30)
        .slice(0, 4)
    : [];

  const rawLineup = Array.isArray(raw.lineup) ? (raw.lineup as unknown[]) : [];
  const lineupCleaned = rawLineup
    .filter(
      (l): l is Record<string, unknown> =>
        l !== null && typeof l === 'object' && typeof (l as { name?: unknown }).name === 'string'
    )
    .map((l) => {
      const name = String(l.name).trim();
      const role = typeof l.role === 'string' ? l.role : null;
      const out: { name: string; role?: Role } = { name };
      if (role && (ALLOWED_ROLES as readonly string[]).includes(role)) {
        out.role = role as Role;
      }
      return out;
    })
    .filter((l) => l.name.length > 0 && !isLineupPlaceholderName(l.name));
  const lineup = lineupCleaned.length > 0 ? lineupCleaned : null;

  const room =
    typeof raw.room === 'string' && raw.room.trim() ? raw.room.trim() : null;
  const priceNote =
    typeof raw.priceNote === 'string' && raw.priceNote.trim()
      ? raw.priceNote.trim()
      : null;
  const kind = raw.kind === 'exhibition' ? 'exhibition' : 'show';
  const category =
    typeof raw.category === 'string' &&
    (ALLOWED_CATEGORIES as readonly string[]).includes(raw.category)
      ? (raw.category as EventCategory)
      : null;
  // Defensief: Claude schrijft soms `\n` als 2 letterlijke tekens
  // (backslash + n) i.p.v. een echte newline. Vervangen door echte
  // newline zodat de UI de paragraaf-breaks goed rendert.
  const cleanedDescription =
    typeof raw.cleanedDescription === 'string' && raw.cleanedDescription.trim()
      ? raw.cleanedDescription.trim().replace(/\\n/g, '\n')
      : input.description;

  return {
    genres,
    lineup,
    room,
    priceNote,
    kind,
    category,
    cleanedDescription,
  };
}

/**
 * Override `kind=show` naar `'exhibition'` bij events die op lokale
 * middernacht starten én ≥7 dagen duren — typisch venue-summer-breaks
 * of doorlopende tentoonstellingen die als 'show' worden ge-enriched.
 *
 * Conservatief: een 3-daags festival (`kind=show`) blijft show, alleen
 * échte multi-week-spans worden exhibitions.
 */
export function refineKindByDuration(
  kind: 'show' | 'exhibition',
  startsAt: Date,
  endsAt: Date | null
): 'show' | 'exhibition' {
  if (kind === 'exhibition') return kind;
  if (!endsAt) return kind;
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  if (endsAt.getTime() - startsAt.getTime() < sevenDays) return kind;
  // Lokale middernacht-check timezone-aware via Intl.
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Amsterdam',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = dtf.formatToParts(startsAt);
  const h = parts.find((p) => p.type === 'hour')?.value;
  const m = parts.find((p) => p.type === 'minute')?.value;
  if (h !== '00' && h !== '24') return kind; // sommige Intl-impl geven '24' voor 00:00
  if (m !== '00') return kind;
  return 'exhibition';
}
