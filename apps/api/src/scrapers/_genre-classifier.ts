/**
 * AI-classifier voor genres — kiest uit een vaste closed-list per
 * category zodat output altijd in onze chip-buckets valt. Geen
 * "STRIKTE REGEL: lege array bij twijfel" zoals enrich.ts — voor
 * post-hoc classificatie willen we juist een educated guess als de
 * signals dun zijn.
 *
 * Gebruikt Claude Haiku 4.5 via dezelfde fetch-pattern als enrich.ts.
 */

const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = 'claude-haiku-4-5';

const BUCKETS: Record<string, readonly string[]> = {
  Theater: ['toneel', 'dans', 'cabaret', 'musical', 'opera', 'familie'],
  Muziek: ['rock', 'hiphop', 'jazz', 'klassiek', 'pop', 'electronic', 'wereld', 'metal'],
  Film: ['drama', 'comedy', 'thriller', 'documentaire', 'animatie', 'actie', 'arthouse', 'romantiek'],
  Lezing: ['debat', 'college', 'talkshow', 'filosofie', 'politiek', 'maatschappij'],
  Kunst: ['fotografie', 'schilderkunst', 'sculpture', 'installatie', 'video-art', 'performance'],
  Literatuur: ['poezie', 'spoken-word', 'boekpresentatie', 'verhaal'],
};

export interface ClassifyInput {
  title: string;
  description: string | null;
  venueName: string;
  category: string;
}

export interface ClassifyOutput {
  genres: string[];
}

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    primary: {
      type: 'string',
      description: 'De primaire bucket — kies de meest passende uit de lijst.',
    },
    secondary: {
      type: 'string',
      description:
        "Optionele tweede bucket als 't event echt beide raakt. Anders leeg.",
    },
  },
  required: ['primary'],
} as const;

const SYSTEM_PROMPT_BASE =
  'Je bent een classifier voor culturele events in Amsterdam.\n' +
  '\n' +
  'Je krijgt category + titel + venue + (optioneel) description. Roep `classify_event` aan met een primaire bucket uit de gegeven lijst, en optioneel een secundaire bucket.\n' +
  '\n' +
  'BELANGRIJK: kies áltijd een primaire bucket — zelfs als de signals dun zijn. Baseer je keuze op:\n' +
  '- Titel en eventuele maker/gezelschap (vaak in de titel achter " — " of " - ")\n' +
  '- Venue-context (Bimhuis = jazz, ITA/Frascati = toneel, Comedy Cafe = cabaret, etc.)\n' +
  '- Description als beschikbaar\n' +
  '\n' +
  'Bij echt onmogelijk: pak de meest generieke bucket voor die category (Theater→toneel, Muziek→pop, Film→drama, etc.).';

interface ContentBlock {
  type: string;
  name?: string;
  input?: { primary?: string; secondary?: string };
}

export async function classifyEventGenres(
  input: ClassifyInput
): Promise<ClassifyOutput> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { genres: [] };

  const allowed = BUCKETS[input.category];
  if (!allowed) return { genres: [] };

  const allowedList = allowed.join(', ');
  const userPrompt = [
    `Category: ${input.category}`,
    `Venue: ${input.venueName}`,
    `Title: ${input.title}`,
    input.description ? `Description: ${input.description.slice(0, 600)}` : 'Description: (geen)',
    '',
    `Toegestane buckets voor deze category: ${allowedList}`,
  ].join('\n');

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        system: SYSTEM_PROMPT_BASE,
        tools: [
          {
            name: 'classify_event',
            description:
              'Kies primaire en optionele secundaire bucket. Alleen waarden uit de toegestane lijst.',
            input_schema: TOOL_SCHEMA,
          },
        ],
        tool_choice: { type: 'tool', name: 'classify_event' },
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    if (!response.ok) return { genres: [] };
    const data = (await response.json()) as { content?: ContentBlock[] };
    const toolBlock = data.content?.find(
      (c) => c.type === 'tool_use' && c.name === 'classify_event'
    );
    if (!toolBlock?.input) return { genres: [] };
    const { primary, secondary } = toolBlock.input;
    const out: string[] = [];
    if (primary && allowed.includes(primary)) out.push(primary);
    if (secondary && allowed.includes(secondary) && secondary !== primary) {
      out.push(secondary);
    }
    return { genres: out };
  } catch {
    return { genres: [] };
  }
}
