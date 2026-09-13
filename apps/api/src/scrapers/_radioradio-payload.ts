/**
 * De DatoCMS-events uit de Nuxt-payload van radioradio.radio/club.
 *
 * Nuxt 3 zet z'n state in `<script id="__NUXT_DATA__">` als devalue: een
 * platte array waarin elk geheel getal een verwijzing is naar een andere
 * positie in diezelfde array. `{"allEvents":1285}` betekent dus "de
 * waarde staat op index 1285". Uitpakken is één functie met een cache —
 * zonder die cache loopt het vast, want de verwijzingen delen takken en
 * kunnen naar elkaar terugwijzen.
 *
 * Dit liep tot 13 sep 2026 via Playwright, dat `window.__NUXT__` uit de
 * gerenderde pagina las. Niet nodig: de payload staat in de HTML die je
 * terugkrijgt.
 *
 * Waarom niet de Weeztix-shop, die een nette JSON-API heeft
 * (shop.api.openticket.tech/{guid}/data): die heeft geen enkel
 * beeldveld en één omschrijving op veertien events, terwijl DatoCMS ze
 * wél levert. Bovendien zou de event-id veranderen van de DatoCMS-id
 * naar een Weeztix-guid, en dat geeft dubbelingen met wat er al staat.
 */

export type DatoEvent = {
  id: string;
  title: string;
  date: string;
  startTime: string | null;
  endTime: string | null;
  ticket: string | null;
  description: string | null;
  soldOut: boolean;
  image: unknown;
  artists: unknown;
};

/** Los een devalue-array op naar gewone waarden. */
function maakResolver(arr: unknown[]) {
  const cache = new Map<number, unknown>();
  const deref = (i: unknown): unknown => {
    if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= arr.length) return i;
    if (cache.has(i)) return cache.get(i);
    // Alvast zetten: een tak die naar zichzelf terugwijst krijgt null in
    // plaats van een oneindige lus.
    cache.set(i, null);
    const v = arr[i];
    let uit: unknown;
    if (Array.isArray(v)) uit = v.map(deref);
    else if (v && typeof v === 'object') {
      uit = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, deref(x)]));
    } else uit = v;
    cache.set(i, uit);
    return uit;
  };
  return deref;
}

export function parseRadioRadioEvents(html: string): DatoEvent[] {
  const m = html.match(
    /<script type="application\/json"[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (!m) return [];
  let arr: unknown[];
  try {
    arr = JSON.parse(m[1]!);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const deref = maakResolver(arr);

  for (const v of arr) {
    if (v && typeof v === 'object' && !Array.isArray(v) && 'allEvents' in (v as object)) {
      const evs = deref((v as Record<string, unknown>).allEvents);
      if (Array.isArray(evs)) {
        return evs.filter(
          (e): e is DatoEvent =>
            !!e && typeof e === 'object' && typeof (e as DatoEvent).id === 'string'
        );
      }
    }
  }
  return [];
}
