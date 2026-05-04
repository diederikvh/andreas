/**
 * Eenmalige review-pass voor de 46 nieuwe `aa-…`-venues.
 * Per venue: handmatig bepaald type/dayNight/wijk/subtype op basis
 * van naam, adres en beschrijving van AA. Niet automatisch te draaien.
 *
 *   pnpm tsx --env-file=.env scripts/_review-aa-venues.ts
 */

const BASE = process.env.ADMIN_BASE_URL ?? 'http://localhost:8787';
const KEY = process.env.ADMIN_API_KEY;
if (!KEY) {
  console.error('ADMIN_API_KEY ontbreekt');
  process.exit(1);
}

type Patch = {
  type:
    | 'galerie'
    | 'museum'
    | 'podium'
    | 'club'
    | 'film'
    | 'ruimte'
    | 'boekhandel-cafe';
  dayNight: 'day' | 'night' | 'both';
  wijk:
    | 'centrum'
    | 'noord'
    | 'oost'
    | 'west'
    | 'zuid'
    | 'zuidoost'
    | 'nieuw-west'
    | null;
  subtype: string[];
};

const PATCHES: Record<string, Patch> = {
  'aa-a-lab': { type: 'ruimte', dayNight: 'both', wijk: 'noord', subtype: ['broedplaats', 'alternatief'] },
  'aa-adm-noord-het-groene-veld': { type: 'ruimte', dayNight: 'day', wijk: 'noord', subtype: ['natuur', 'alternatief'] },
  'aa-astarotheatro': { type: 'podium', dayNight: 'night', wijk: 'centrum', subtype: ['theater', 'alternatief'] },
  'aa-atelierwg-foundation': { type: 'ruimte', dayNight: 'day', wijk: 'west', subtype: ['artist-run', 'broedplaats'] },
  'aa-bajesdorp-grond': { type: 'galerie', dayNight: 'both', wijk: 'oost', subtype: ['artist-run', 'alternatief'] },
  'aa-buurtwerkplaats-noorderhof': { type: 'ruimte', dayNight: 'day', wijk: 'nieuw-west', subtype: ['cultureel-maatschappelijk', 'alternatief'] },
  'aa-de-roze-tanker': { type: 'podium', dayNight: 'night', wijk: 'noord', subtype: ['alternatief', 'queer'] },
  'aa-de-ceuvel': { type: 'ruimte', dayNight: 'both', wijk: 'noord', subtype: ['duurzaam', 'broedplaats', 'alternatief'] },
  'aa-de-culturele-stelling-van-amsterdam': { type: 'ruimte', dayNight: 'day', wijk: null, subtype: ['alternatief'] },
  'aa-de-fabriek': { type: 'ruimte', dayNight: 'both', wijk: 'zuid', subtype: ['broedplaats', 'alternatief'] },
  'aa-de-hoop': { type: 'ruimte', dayNight: 'day', wijk: 'noord', subtype: ['atelier', 'broedplaats'] },
  'aa-de-omleiding': { type: 'ruimte', dayNight: 'both', wijk: 'nieuw-west', subtype: ['alternatief'] },
  'aa-de-ruimte': { type: 'podium', dayNight: 'night', wijk: 'noord', subtype: ['alternatief', 'cultureel-maatschappelijk'] },
  'aa-de-sloot': { type: 'ruimte', dayNight: 'both', wijk: 'west', subtype: ['alternatief'] },
  'aa-fort-van-sjakoo': { type: 'boekhandel-cafe', dayNight: 'day', wijk: 'centrum', subtype: ['alternatief', 'politiek'] },
  'aa-helicopter': { type: 'galerie', dayNight: 'day', wijk: 'west', subtype: ['artist-run', 'project-space'] },
  'aa-huis-te-vraag': { type: 'ruimte', dayNight: 'day', wijk: 'west', subtype: ['natuur', 'cultureel-maatschappelijk'] },
  'aa-kaskantine': { type: 'ruimte', dayNight: 'both', wijk: 'nieuw-west', subtype: ['duurzaam', 'alternatief'] },
  'aa-kostgewonnen': { type: 'ruimte', dayNight: 'both', wijk: 'west', subtype: ['artist-run', 'broedplaats'] },
  'aa-lima': { type: 'ruimte', dayNight: 'day', wijk: 'west', subtype: ['archief', 'media'] },
  'aa-mike-s-badhuistheater': { type: 'podium', dayNight: 'night', wijk: 'oost', subtype: ['theater'] },
  'aa-ndsm-loods': { type: 'podium', dayNight: 'both', wijk: 'noord', subtype: ['alternatief', 'multidisciplinair'] },
  'aa-nieuwland': { type: 'ruimte', dayNight: 'both', wijk: 'oost', subtype: ['alternatief', 'broedplaats'] },
  'aa-noon-coffee-culture': { type: 'boekhandel-cafe', dayNight: 'day', wijk: 'oost', subtype: ['cafe', 'boekhandel'] },
  'aa-pakhuis-wilhelmina': { type: 'podium', dayNight: 'both', wijk: 'centrum', subtype: ['multidisciplinair', 'cultureel'] },
  'aa-parknest': { type: 'ruimte', dayNight: 'day', wijk: 'oost', subtype: ['cultureel-maatschappelijk'] },
  'aa-plantagedok': { type: 'ruimte', dayNight: 'both', wijk: 'centrum', subtype: ['broedplaats', 'alternatief'] },
  'aa-plein-theater': { type: 'podium', dayNight: 'night', wijk: 'oost', subtype: ['theater'] },
  'aa-rijkshemelvaartdienst': { type: 'ruimte', dayNight: 'day', wijk: 'nieuw-west', subtype: ['broedplaats', 'alternatief'] },
  'aa-ru-pare': { type: 'ruimte', dayNight: 'both', wijk: 'nieuw-west', subtype: ['cultureel-maatschappelijk'] },
  'aa-ruigoord': { type: 'ruimte', dayNight: 'day', wijk: 'nieuw-west', subtype: ['broedplaats', 'alternatief'] },
  'aa-salon-de-ijzerstaven': { type: 'podium', dayNight: 'night', wijk: 'centrum', subtype: ['klassiek', 'multidisciplinair'] },
  'aa-space-for-dance-art': { type: 'podium', dayNight: 'both', wijk: 'west', subtype: ['dans'] },
  'aa-splendor': { type: 'podium', dayNight: 'night', wijk: 'centrum', subtype: ['klassiek', 'experimenteel'] },
  'aa-steelhenge': { type: 'ruimte', dayNight: 'night', wijk: 'centrum', subtype: ['alternatief'] },
  'aa-studio-k': { type: 'film', dayNight: 'night', wijk: 'oost', subtype: ['arthouse', 'cafe'] },
  'aa-teatro-munganga': { type: 'podium', dayNight: 'night', wijk: 'zuid', subtype: ['theater', 'dans'] },
  'aa-treehouse-ndsm': { type: 'ruimte', dayNight: 'both', wijk: 'noord', subtype: ['broedplaats', 'alternatief'] },
  'aa-voedselpark-amsterdam': { type: 'ruimte', dayNight: 'day', wijk: 'nieuw-west', subtype: ['natuur', 'duurzaam'] },
  'aa-volta': { type: 'podium', dayNight: 'night', wijk: 'west', subtype: ['pop', 'alternatief'] },
  'aa-vondelbunker': { type: 'ruimte', dayNight: 'both', wijk: 'zuid', subtype: ['alternatief', 'artist-run'] },
  'aa-workship-op-de-ceuvel': { type: 'ruimte', dayNight: 'day', wijk: 'noord', subtype: ['artist-run', 'experimenteel'] },
  'aa-zaal-100': { type: 'podium', dayNight: 'night', wijk: 'west', subtype: ['alternatief', 'experimenteel'] },
  'aa-zid-theater': { type: 'podium', dayNight: 'night', wijk: 'nieuw-west', subtype: ['theater', 'cultureel-maatschappelijk'] },
  'aa-zone-2-source': { type: 'galerie', dayNight: 'day', wijk: 'zuid', subtype: ['experimenteel', 'natuur'] },
  'aa-woonruimte-cooperatief': { type: 'ruimte', dayNight: 'day', wijk: 'oost', subtype: ['alternatief', 'cultureel-maatschappelijk'] },
};

let n = 0;
for (const [id, patch] of Object.entries(PATCHES)) {
  const res = await fetch(`${BASE}/admin/api/venues/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify({
      type: patch.type,
      dayNight: patch.dayNight,
      wijk: patch.wijk,
      subtype: patch.subtype,
      published: true,
    }),
  });
  if (res.ok) {
    n++;
    console.log(`✓ ${id} → ${patch.type} / ${patch.dayNight} / ${patch.wijk ?? '—'}`);
  } else {
    console.warn(`✗ ${id}: ${res.status}`);
  }
}

console.log(`\nUpdated ${n}/${Object.keys(PATCHES).length} venues.`);
process.exit(0);
