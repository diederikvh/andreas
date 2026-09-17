/**
 * Deezer als tweede bron voor artiestfoto's.
 *
 * Waarom naast Spotify: hun zoek-endpoint vraagt geen sleutel en geen
 * OAuth, dus het staat los van de app-sleutel die de zoek in de app
 * gebruikt. Een inhaalslag hier kan die zoek niet platleggen.
 *
 * **Alleen een exacte naammatch.** We hebben geen Deezer-id opgeslagen,
 * dus de naam is het enige bewijs dat we hebben. Dat is zwakker dan de
 * id-vergelijking bij Spotify: een naamgenoot glipt erdoor. De losse
 * matches weigeren we wel -- op een steekproef van 20 gaf Deezer voor 7
 * namen iets anders terug ("Lola Haro" -> "Lola Marsh") en die vallen
 * allemaal af op deze vergelijking.
 */
const SEARCH_URL = 'https://api.deezer.com/search/artist';

/** Fout bij de oproep zelf. Anders dan "niets gevonden": bij een fout
    heeft opnieuw proberen zin, bij niets gevonden niet. */
export class DeezerUnavailable extends Error {}

export async function deezerArtistImage(
  name: string,
  timeoutMs = 6000
): Promise<string | null> {
  const term = name.trim();
  if (term.length < 2) return null;
  let data: { data?: { name: string; picture_xl?: string; picture_big?: string }[] };
  try {
    const r = await fetch(`${SEARCH_URL}?q=${encodeURIComponent(term)}&limit=5`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new DeezerUnavailable(`deezer ${r.status}`);
    data = (await r.json()) as typeof data;
  } catch (e) {
    throw e instanceof DeezerUnavailable ? e : new DeezerUnavailable(String(e));
  }
  // Precies één exacte naammatch, anders weten we het niet. Twee
  // artiesten die allebei "90s" heten leveren een gok op, en een gok is
  // hier niets waard.
  const want = term.toLowerCase();
  const hits = (data.data ?? []).filter((a) => a.name.trim().toLowerCase() === want);
  if (hits.length !== 1) return null;
  return hits[0].picture_xl || hits[0].picture_big || null;
}
