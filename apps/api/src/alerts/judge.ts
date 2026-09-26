/**
 * De keurder voor smaakregels: past dit nieuwe event bij "gitaarbands met
 * een jaren-90-randje, zoals Afghan Whigs"?
 *
 * Vaste labels kunnen die vraag niet beantwoorden: de genres van de zalen
 * zijn te grof en vaak fout. Een model dat de artiesten kent wel. Het krijgt
 * alles wat we van het event weten, inclusief de genres van de artiesten in
 * de line-up, en geeft ja/nee plus een korte reden die in de push komt.
 *
 * Draait alleen op events die al door de harde filters van de regel kwamen
 * (zaal, stad, categorie), dus een paar tientallen per week. Claude Haiku
 * 4.5, zelfde fetch-patroon als `scrapers/_genre-classifier.ts`.
 */
import { inArray, sql } from 'drizzle-orm';

import { db } from '../db/index.js';

const MODEL = 'claude-haiku-4-5';

export type EventInfo = {
  id: string;
  title: string;
  category: string;
  venue: string;
  city: string;
  genres: string[];
  description: string | null;
  startsAt: Date;
  /** Line-up met de genres die we van die artiesten kennen. */
  lineup: { name: string; genres: string[] }[];
};

export type Verdict = { match: boolean; reason: string };

/** Alles wat de keurder over deze events moet weten, in één query. */
export async function loadEventInfo(eventIds: string[]): Promise<Map<string, EventInfo>> {
  if (eventIds.length === 0) return new Map();
  const res = await db.execute<{
    id: string;
    title: string;
    category: string;
    venue: string;
    city: string;
    genres: string[];
    description: string | null;
    starts_at: string;
    lineup: { name: string; genres: string[] }[] | null;
  }>(sql`
    SELECT e.id, e.title, e.category::text AS category, v.name AS venue, v.city::text AS city,
           e.genres, e.description,
           (SELECT MIN(o.starts_at) FROM occurrences o WHERE o.event_id = e.id AND o.starts_at > NOW()) AS starts_at,
           (
             SELECT jsonb_agg(DISTINCT jsonb_build_object(
               'name', le->>'name',
               'genres', COALESCE(to_jsonb(ar.genres), '[]'::jsonb)
             ))
             FROM occurrences o
             CROSS JOIN LATERAL jsonb_array_elements(
               CASE WHEN jsonb_typeof(o.lineup) = 'array' THEN o.lineup ELSE '[]'::jsonb END
             ) le
             LEFT JOIN artists ar ON ar.id = le->>'artistId'
             WHERE o.event_id = e.id
           ) AS lineup
    FROM events e
    JOIN venues v ON v.id = e.venue_id
    WHERE ${inArray(sql`e.id`, eventIds)}
  `);
  return new Map(
    res.rows.map((r) => [
      r.id,
      {
        id: r.id,
        title: r.title,
        category: r.category,
        venue: r.venue,
        city: r.city,
        genres: r.genres,
        description: r.description,
        startsAt: new Date(r.starts_at),
        lineup: (r.lineup ?? []).slice(0, 12),
      },
    ])
  );
}

const SYSTEM = [
  'Je beoordeelt voor één persoon of een nieuw aangekondigd event in Andreas (een uitgaansgids) bij diens smaak past.',
  'De smaak staat in de eigen woorden van die persoon, vaak met voorbeeldartiesten.',
  '',
  'Gebruik je kennis van de artiesten in de titel en de line-up: wie zijn het, hoe klinken ze, lijken ze op de voorbeelden of op de omschrijving?',
  'De genre-labels van de zaal zijn grof en vaak fout. Weeg ze licht; de artiest zelf telt.',
  '',
  'Zeg ja als iemand met deze smaak dit event waarschijnlijk wil weten. Zeg nee als je twijfelt en je kennis van de artiest die twijfel niet wegneemt.',
  'Verzin niets. Ken je de artiest niet en zeggen beschrijving en line-up niets over de muziek, dan weet je het niet: zet `onderbouwd` op false en zeg nee. Een titel en een los label zijn geen onderbouwing.',
  'Tribute- en coverbands, feesten met hits uit een decennium en kinderprogramma zijn nee, tenzij de smaak daar expliciet om vraagt.',
  '',
  'De reden leest de persoon in een pushbericht: kort (hooguit 15 woorden), Nederlands, concreet over de muziek of de artiest.',
  "Bijvoorbeeld: 'Donkere gitaarrock uit de jaren 90, verwant aan Afghan Whigs.' Noem geen labels en zeg niet dat je een model bent.",
].join('\n');

const TOOL = {
  name: 'oordeel',
  description: 'Geef je oordeel over dit event voor deze smaak.',
  input_schema: {
    type: 'object',
    properties: {
      match: { type: 'boolean', description: 'Past het bij de smaak?' },
      onderbouwd: {
        type: 'boolean',
        description:
          'True als je oordeel rust op concrete kennis van deze artiest of op wat beschrijving/line-up over de muziek zeggen. False als je gokt.',
      },
      reason: { type: 'string', description: 'Korte reden voor de persoon, hooguit 15 woorden.' },
    },
    required: ['match', 'onderbouwd', 'reason'],
  },
} as const;

function describeEvent(e: EventInfo): string {
  const day = new Intl.DateTimeFormat('nl-NL', {
    timeZone: 'Europe/Amsterdam',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(e.startsAt);
  const lineup = e.lineup.length
    ? e.lineup
        .map((l) => (l.genres.length ? `${l.name} (${l.genres.slice(0, 5).join(', ')})` : l.name))
        .join('; ')
    : '(onbekend)';
  return [
    `Titel: ${e.title}`,
    `Categorie: ${e.category}`,
    `Zaal: ${e.venue} (${e.city})`,
    `Datum: ${day}`,
    `Labels van de zaal: ${e.genres.join(', ') || '(geen)'}`,
    `Line-up: ${lineup}`,
    `Beschrijving: ${e.description?.replace(/\s+/g, ' ').slice(0, 800) || '(geen)'}`,
  ].join('\n');
}

/**
 * Eén oordeel. `null` als het model niet bereikbaar is of geen bruikbaar
 * antwoord gaf: dan leggen we niets vast en probeert de volgende tik het
 * opnieuw, in plaats van een event voorgoed af te keuren om een storing.
 */
export async function judgeEvent(taste: string, event: EventInfo): Promise<Verdict | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        temperature: 0,
        system: SYSTEM,
        tools: [TOOL],
        tool_choice: { type: 'tool', name: TOOL.name },
        messages: [{ role: 'user', content: `Smaak: ${taste}\n\nEvent:\n${describeEvent(event)}` }],
      }),
    });
    if (!response.ok) {
      console.warn('[judge] Anthropic', response.status, (await response.text()).slice(0, 200));
      return null;
    }
    const data = (await response.json()) as {
      content?: {
        type: string;
        name?: string;
        input?: { match?: unknown; onderbouwd?: unknown; reason?: unknown };
      }[];
    };
    const input = data.content?.find((c) => c.type === 'tool_use' && c.name === TOOL.name)?.input;
    if (typeof input?.match !== 'boolean') return null;
    // Een ja zonder onderbouwing is een gok; een gok is geen melding waard.
    // (Loavies X Chin Chin: alleen een titel en "pop", en toch "dromerige
    // gitaren met synths".)
    return {
      match: input.match && input.onderbouwd === true,
      reason: typeof input.reason === 'string' ? input.reason.trim() : '',
    };
  } catch (err) {
    console.warn('[judge] mislukt', (err as Error).message);
    return null;
  }
}

/** Meerdere events keuren, een paar tegelijk (niet allemaal: rate limits). */
export async function judgeMany(
  taste: string,
  events: EventInfo[],
  concurrency = 5
): Promise<Map<string, Verdict>> {
  const out = new Map<string, Verdict>();
  let next = 0;
  const worker = async () => {
    while (next < events.length) {
      const e = events[next++];
      const v = await judgeEvent(taste, e);
      if (v) out.set(e.id, v);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, events.length) }, worker));
  return out;
}
