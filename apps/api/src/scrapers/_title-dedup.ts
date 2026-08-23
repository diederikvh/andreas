/**
 * Venue-scoped dedup op titel, voor scrapers waarvan de bron per avond
 * (of per alias-URL) een eigen id geeft.
 *
 * Het probleem is overal hetzelfde: de event-id wordt afgeleid van iets
 * uit de bron — een slug, een ticketshop-id, een CMS-nummer — en dat is
 * niet de identiteit van de voorstelling. Gevolgen:
 *
 *   - Een wekelijkse clubavond wordt 14 losse events i.p.v. één event
 *     met 14 occurrences (Chin Chin "Dynasty | 21+", Melkweg "Cheeky
 *     Monday", Odessa "Ecstatic Dance | Yarun Dee").
 *   - Een show over drie avonden wordt drie events (Paradiso "Fat
 *     Freddy's Drop", Patronaat "Haarlem Live").
 *   - Een gecorrigeerde of aliased slug maakt een tweede event náást
 *     het bestaande (Frascati, Meervaart, Bijlmer).
 *
 * MAAR: niet elke gelijke titel is dezelfde voorstelling. `description`
 * zit op event-niveau, dus samenvoegen platslaat de tekst van avond
 * 2..N. Gemeten over 90 clusters met meer dan één description: 81 hebben
 * écht andere tekst (tot 1% overeenkomst) — "CinemAnita Fiber Factory"
 * bij De Nieuwe Anita is elke week een andere film, "Comedy Queens" een
 * andere line-up. Die horen los te blijven; daar is de titel-gelijkheid
 * toeval van een serienaam.
 *
 * Daarom mag een titel-match alleen samenvoegen als één van twee
 * signalen zegt "dit is echt dezelfde voorstelling":
 *
 *   description — >90% gemeenschappelijke prefix, of één van de twee is
 *                 leeg (dan valt er niets te verliezen). Het scherpste
 *                 signaal, maar niet elke scraper heeft de tekst al
 *                 binnen op het moment dat de id bepaald wordt.
 *   datum       — de nieuwe datum grenst aan een datum die dit event al
 *                 heeft (≤1 dag). Vangt alias-URLs (zelfde dag) en runs
 *                 over opeenvolgende avonden, en laat een wekelijkse
 *                 serie met los programma met rust.
 *
 * Geen van beide meegegeven? Dan valt 'ie terug op puur titel-matchen.
 *
 * Voor films bestaat een eigen laag (`_film-dedup.ts`) die cross-venue
 * werkt en filmspecifieke suffixen normaliseert — die blijft apart,
 * want daar is dezelfde film in twee bioscopen juist één event.
 */

import { asc, eq, inArray } from 'drizzle-orm';

import { db as dbDefault, schema } from '../db/index.js';

type Db = typeof dbDefault;

/** Identiteits-key voor een titel binnen één venue. Losser dan een
    slug: interpunctie en dubbele spaties vallen weg, zodat "Anansi (3+)
    — Vanaf2" en "Anansi (3+) - Vanaf2" dezelfde key geven. */
export function titleKey(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Hoeveel van de kortste tekst is gemeenschappelijke prefix. Bewust
 * geen edit-distance: de venue-teksten die hetzelfde zijn, zijn
 * byte-identiek tot een eventuele slotzin, en die zijn we niet aan het
 * opsporen. Goedkoop en genoeg.
 */
export function descriptionSimilarity(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i / Math.max(1, Math.min(a.length, b.length));
}

/** Grens waarboven twee descriptions als "dezelfde voorstelling" gelden. */
export const SAME_SHOW_SIMILARITY = 0.9;

export type TitleMapEntry = {
  id: string;
  description: string | null;
  /** ISO-datums (YYYY-MM-DD) die dit event al heeft. */
  days: Set<string>;
};

/**
 * Map van genormaliseerde titel → bestaand event voor één venue.
 *
 * `idPrefix` houdt de scraper bij z'n eigen events: celebratix mag geen
 * event van de ticketmaster-scraper naar zich toe trekken, want die
 * hebben andere velden en een andere update-cadans.
 *
 * Vaste volgorde op id: bij al bestaande dubbelen bepaalt dit welk
 * event wint, en dat mag tussen runs niet wisselen.
 */
export async function loadVenueTitleMap(
  venueId: string,
  idPrefix: string,
  db: Db = dbDefault
): Promise<Map<string, TitleMapEntry>> {
  const rows = (
    await db
      .select({
        id: schema.events.id,
        title: schema.events.title,
        description: schema.events.description,
      })
      .from(schema.events)
      .where(eq(schema.events.venueId, venueId))
      .orderBy(asc(schema.events.id))
  ).filter((r) => r.id.startsWith(idPrefix));

  const occ = rows.length
    ? await db
        .select({
          eventId: schema.occurrences.eventId,
          startsAt: schema.occurrences.startsAt,
        })
        .from(schema.occurrences)
        .where(inArray(schema.occurrences.eventId, rows.map((r) => r.id)))
    : [];
  const daysOf = new Map<string, Set<string>>();
  for (const o of occ) {
    const set = daysOf.get(o.eventId) ?? new Set<string>();
    set.add(o.startsAt.toISOString().slice(0, 10));
    daysOf.set(o.eventId, set);
  }

  const map = new Map<string, TitleMapEntry>();
  for (const row of rows) {
    const k = titleKey(row.title);
    if (!k || map.has(k)) continue;
    map.set(k, {
      id: row.id,
      description: row.description,
      days: daysOf.get(row.id) ?? new Set<string>(),
    });
  }
  return map;
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/** Grenst `day` aan een datum die dit event al heeft (zelfde dag of ±1)? */
function touchesKnownDay(entry: TitleMapEntry, day: string): boolean {
  const t = Date.parse(day);
  for (const known of entry.days) {
    if (Math.abs(Date.parse(known) - t) <= 86_400_000) return true;
  }
  return false;
}

/**
 * Kies de event-id. Een bestaand event met dezelfde titel wint alléén
 * als description of datum bevestigt dat het dezelfde voorstelling is —
 * zie de uitleg boven dit bestand.
 *
 * Bij een miss wordt `sourceId` meteen gereserveerd — synchroon, zonder
 * await ertussen — zodat scrapers die meerdere items parallel verwerken
 * niet alsnog twee events voor dezelfde titel inserten.
 *
 * `owns` is false wanneer we naar een ander event zijn geremapt. Gebruik
 * dat om destructieve paden (een "afgelopen"-delete) over te slaan: die
 * mogen niet op een event vuren dat een andere bron-pagina bezit.
 */
export function resolveEventId(
  map: Map<string, TitleMapEntry>,
  title: string,
  sourceId: string,
  hints?: { startsAt?: Date | null; description?: string | null }
): { eventId: string; owns: boolean } {
  const k = titleKey(title);
  if (!k) return { eventId: sourceId, owns: true };

  const day = hints?.startsAt ? dayKey(hints.startsAt) : null;
  const entry = map.get(k);

  if (!entry) {
    map.set(k, {
      id: sourceId,
      description: hints?.description ?? null,
      days: new Set(day ? [day] : []),
    });
    return { eventId: sourceId, owns: true };
  }

  // OR, niet AND: de twee signalen dekken verschillende gevallen.
  //
  //   aangrenzende datum → een alias-URL op dezelfde dag, of een run
  //     over opeenvolgende avonden. Sterk bewijs, ook als de teksten
  //     per avond wat verschillen.
  //   gelijke description → een terugkerende avond die echt elke keer
  //     hetzelfde is ("Dynasty | 21+"). Datums liggen dan weken uit
  //     elkaar, dus alleen de tekst kan het bevestigen.
  //
  // Zegt geen van beide iets, dan blijft het een eigen event. Dat is de
  // veilige kant: liever een dubbel dat we later zien dan een
  // platgeslagen description.
  const incoming = (hints?.description ?? '').trim();
  const known = (entry.description ?? '').trim();
  const gotDescription = hints?.description !== undefined;

  const dayMatches = day ? touchesKnownDay(entry, day) : false;
  const descriptionMatches = gotDescription
    ? !incoming || !known
      // Eén van de twee is leeg: samenvoegen kost geen tekst.
      ? true
      : descriptionSimilarity(incoming, known) > SAME_SHOW_SIMILARITY
    : false;
  // Splitsen mag alleen op POSITIEF bewijs van verschil: we hebben de
  // description gezien én die wijkt af én de datums sluiten niet aan.
  //
  // Niet "geen bewijs van gelijkheid → splitsen", want scrapers die de
  // description pas ná dit punt ophalen (melkweg, paradiso) zouden dan
  // elke al samengevoegde serie bij de volgende run weer opsplitsen —
  // en de merge-migratie zou 'm daarna weer samenvoegen. Dat oscilleert.
  //
  // ponytail: voor die twee scrapers blijft dus de oude titel-match
  // staan, met het risico op een platgeslagen description bij een serie
  // die per avond verschilt. Upgrade-pad is hun description-fetch vóór
  // dit punt halen (bij odessa en patronaat kon dat gratis, want die
  // haalden de detail-pagina toch al voor elk item op; bij melkweg zijn
  // het ~400 extra requests per run en bij paradiso Playwright).
  if (gotDescription && !descriptionMatches && !dayMatches) {
    return { eventId: sourceId, owns: true };
  }

  if (day) entry.days.add(day);
  return { eventId: entry.id, owns: entry.id === sourceId };
}
