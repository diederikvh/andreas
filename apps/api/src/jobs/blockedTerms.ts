/**
 * De trefwoordenfilter: wat niet in het aanbod hoort, gaat uit.
 *
 * Eén functie voor twee aanroepers, en dat is het hele punt. De knop in de
 * admin en de stap na een sync lopen door exact dezelfde query, dus wat een
 * droge run je laat zien is precies wat er gebeurt als je 'm echt draait.
 * Twee losse implementaties zouden langzaam uit elkaar lopen en dan is een
 * droge run niet meer dan een gok.
 *
 * Match: als deel van een woord, ongevoelig voor kapitalen. "lunch" pakt
 * dus ook "Lunchconcert". Dat is bewust ruim — een trefwoord moet werken
 * zonder dat je verbuigingen gaat bedenken — en daarom is de droge run
 * geen extraatje maar de manier waarop je een woord invoert: "art" vindt
 * ook Mozart, en dat wil je zien vóór je 'm opslaat.
 *
 * We kijken naar de titel en naar de namen in de line-up. Niet naar de
 * beschrijving: daar staat bij een willekeurige zaal zo veel tekst in dat
 * elk kort woord iets raakt.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { db, schema } from '../db/index.js';

export type BlockedHit = {
  /** Welk woord dit event pakte. */
  term: string;
  eventId: string;
  title: string;
  venue: string;
  /** Waar het woord in stond, zodat een rare match uit te leggen is. */
  found: 'titel' | 'line-up';
};

export async function listBlockedTerms() {
  return db
    .select()
    .from(schema.blockedTerms)
    .orderBy(asc(schema.blockedTerms.term));
}

export function normalizeTerm(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Welke live events zou deze lijst uitzetten? Verandert niets.
 *
 * Alleen `published = true`: wat al uit staat hoeft niet nog een keer uit,
 * en anders groeit de uitkomst elke run met alles wat je ooit hebt
 * weggezet.
 */
export async function findBlockedEvents(terms: string[]): Promise<BlockedHit[]> {
  const hits: BlockedHit[] = [];
  const seen = new Set<string>();

  for (const term of terms) {
    const needle = `%${normalizeTerm(term)}%`;
    const rows = await db
      .select({
        id: schema.events.id,
        title: schema.events.title,
        venue: schema.venues.name,
        inTitle: sql<boolean>`${schema.events.title} ILIKE ${needle}`,
      })
      .from(schema.events)
      .innerJoin(schema.venues, eq(schema.venues.id, schema.events.venueId))
      .where(
        and(
          eq(schema.events.published, true),
          sql`(
            ${schema.events.title} ILIKE ${needle}
            OR EXISTS (
              SELECT 1
              FROM occurrences o, jsonb_array_elements(o.lineup) le
              WHERE o.event_id = ${schema.events.id}
                AND jsonb_typeof(o.lineup) = 'array'
                AND le->>'name' ILIKE ${needle}
            )
          )`
        )
      )
      .orderBy(asc(schema.events.title));

    for (const row of rows) {
      // Eén regel per event, ook als twee woorden 'm pakken: je wil een
      // lijst van wat er uit gaat, niet van alle redenen waarom.
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      hits.push({
        term,
        eventId: row.id,
        title: row.title,
        venue: row.venue,
        found: row.inTitle ? 'titel' : 'line-up',
      });
    }
  }

  return hits;
}

/**
 * De lijst draaien. `dryRun` laat alles staan en geeft alleen terug wat er
 * zou gebeuren; `terms` overschrijft de opgeslagen lijst, zodat je een woord
 * kan uitproberen voordat je het bewaart.
 */
export async function applyBlockedTerms(
  opts: { dryRun?: boolean; terms?: string[] } = {}
): Promise<{ hits: BlockedHit[]; unpublished: number }> {
  const terms = (
    opts.terms ?? (await listBlockedTerms()).map((t) => t.term)
  )
    .map(normalizeTerm)
    .filter((t) => t.length > 0);
  if (terms.length === 0) return { hits: [], unpublished: 0 };

  const hits = await findBlockedEvents(terms);
  if (opts.dryRun || hits.length === 0) return { hits, unpublished: 0 };

  await db
    .update(schema.events)
    .set({ published: false })
    .where(
      inArray(
        schema.events.id,
        hits.map((h) => h.eventId)
      )
    );

  return { hits, unpublished: hits.length };
}
