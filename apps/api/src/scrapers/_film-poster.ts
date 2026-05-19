/**
 * Wikipedia film-poster lookup.
 *
 * Voor cinema-scrapers (Kriterion, en straks andere indie's) die geen
 * eigen poster bij elke film publiceren. Wikipedia's REST API geeft
 * per page-summary een `originalimage.source` URL — voor de meeste
 * mainstream + arthouse-titels is dat de officiële poster (vaak
 * fair-use upload).
 *
 * Strategie:
 *   1. Probeer NL Wikipedia direct (vaak ondertiteld + originele
 *      poster), dan EN als fallback.
 *   2. Verifieer dat de gevonden page een film is (description bevat
 *      "film", of de page heeft een 'Film' infobox). Anders kun je
 *      een verkeerde poster pakken — Anora kan ook een
 *      voornaam-disambig zijn.
 *   3. Als directe zoek niets bruikbaars geeft: opensearch met
 *      "film"-context.
 *
 * Returnt `null` als we geen overtuigende match vinden.
 */

const UA = 'AndreasBot/1.0 (+https://andreas.amsterdam)';

interface WikiSummary {
  type?: string;
  description?: string;
  extract?: string;
  originalimage?: { source: string };
  thumbnail?: { source: string };
}

export async function fetchFilmPoster(
  title: string
): Promise<string | null> {
  if (!title || title.length < 2) return null;
  // Probeer eerst de oorspronkelijke titel; werkt voor mainstream
  // releases ("Anora") en behoudt regie-bedoelde varianten.
  // Daarna geschoonde varianten — cinema's plakken vaak "(ENG subs)",
  // "(4k Restoration)", festival-prefixen of jaartal-suffix achter
  // de titel die Wikipedia niet kent.
  const variants = [title, ...cleanTitleVariants(title)];
  for (const variant of variants) {
    for (const lang of ['nl', 'en'] as const) {
      const direct = await fetchSummary(lang, variant);
      if (direct && looksLikeFilm(direct)) {
        const src = direct.originalimage?.source ?? direct.thumbnail?.source;
        if (src) return src;
      }
    }
    // Opensearch op EN met "film"-context — vangt disambig op
    // ("Anora" → "Anora (film)"). Probeer alleen op de cleaned variant
    // om Wikipedia niet onnodig te bombarderen.
    const searched = await openSearchFilm(variant);
    if (searched) {
      const src = searched.originalimage?.source ?? searched.thumbnail?.source;
      if (src) return src;
    }
  }
  return null;
}

/** Verwijder cinematheek-stijl ruis voor zoekqueries: festival-prefix
    achter ` | `, technische haakjes ("(ENG subs)", "(4k Restoration)"),
    jaartallen achter de titel, leeftijdslabels ("(6+)"). Returnt
    [cleaned] of [] als 'r niets te schonen viel. Houd de oorspronkelijke
    intact als 't al schoon was — die wordt al apart geprobeerd. */
function cleanTitleVariants(title: string): string[] {
  const variants = new Set<string>();
  let s = title;
  // Strip alles na " | " (festival-/series-suffix).
  s = s.split(/\s*\|\s*/)[0];
  // Strip alle (haakjes-stukken) — "(ENG subs)", "(4k Restoration)",
  // "(1968, ENG subs)", "(6+)" etc.
  s = s.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  // Strip dubbele spaties.
  s = s.replace(/\s{2,}/g, ' ').trim();
  if (s && s !== title) variants.add(s);
  return [...variants];
}

async function fetchSummary(
  lang: string,
  title: string
): Promise<WikiSummary | null> {
  try {
    const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const r = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/json' },
    });
    if (!r.ok) return null;
    const d = (await r.json()) as WikiSummary;
    if (d.type === 'disambiguation') return null;
    return d;
  } catch {
    return null;
  }
}

function looksLikeFilm(s: WikiSummary): boolean {
  const text = `${s.description ?? ''} ${s.extract ?? ''}`.toLowerCase();
  // NL: "is een [Amerikaanse] film", "film uit 2024", etc.
  // EN: "is a [year] film", "American film", "film directed by".
  return /\bfilm\b/.test(text);
}

async function openSearchFilm(title: string): Promise<WikiSummary | null> {
  try {
    const api = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(
      title + ' film'
    )}&limit=5&namespace=0&format=json`;
    const r = await fetch(api, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const d = (await r.json()) as [string, string[], string[], string[]];
    const titles = d[1] ?? [];
    const titleNorm = title.toLowerCase().trim();
    for (const cand of titles) {
      const candNorm = cand
        .toLowerCase()
        .replace(/\s*\([^)]+\)\s*$/, '')
        .trim();
      if (
        candNorm === titleNorm ||
        candNorm.startsWith(titleNorm) ||
        titleNorm.startsWith(candNorm)
      ) {
        const summary = await fetchSummary('en', cand);
        if (summary && looksLikeFilm(summary)) return summary;
      }
    }
    return null;
  } catch {
    return null;
  }
}
