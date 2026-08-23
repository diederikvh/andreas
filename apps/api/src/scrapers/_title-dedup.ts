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
 * De titel binnen één venue is de betere identiteit. Deze helper laadt
 * die map één keer per venue-run; daarna zijn het in-memory lookups.
 *
 * Voor films bestaat een eigen laag (`_film-dedup.ts`) die cross-venue
 * werkt en filmspecifieke suffixen normaliseert — die blijft apart,
 * want daar is dezelfde film in twee bioscopen juist één event.
 */

import { asc, eq } from 'drizzle-orm';

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
 * Map van genormaliseerde titel → bestaand eventId voor één venue.
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
): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: schema.events.id, title: schema.events.title })
    .from(schema.events)
    .where(eq(schema.events.venueId, venueId))
    .orderBy(asc(schema.events.id));

  const map = new Map<string, string>();
  for (const row of rows) {
    if (!row.id.startsWith(idPrefix)) continue;
    const k = titleKey(row.title);
    if (k && !map.has(k)) map.set(k, row.id);
  }
  return map;
}

/**
 * Kies de event-id: een bestaand event met dezelfde titel wint van de
 * bron-id. Bij een miss wordt `sourceId` meteen gereserveerd — synchroon,
 * zonder await ertussen — zodat scrapers die meerdere items parallel
 * verwerken niet alsnog twee events voor dezelfde titel inserten.
 *
 * `owns` is false wanneer we naar een ander event zijn geremapt. Gebruik
 * dat om destructieve paden (een "afgelopen"-delete) over te slaan: die
 * mogen niet op een event vuren dat een andere bron-pagina bezit.
 */
export function resolveEventId(
  map: Map<string, string>,
  title: string,
  sourceId: string
): { eventId: string; owns: boolean } {
  const k = titleKey(title);
  if (!k) return { eventId: sourceId, owns: true };
  const hit = map.get(k);
  if (hit) return { eventId: hit, owns: hit === sourceId };
  map.set(k, sourceId);
  return { eventId: sourceId, owns: true };
}
