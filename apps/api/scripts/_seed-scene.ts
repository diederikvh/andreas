/**
 * Eenmalige scene-classificatie voor alle venues.
 *
 *   pnpm tsx --env-file=.env scripts/_seed-scene.ts
 *
 * Per venue handmatig bepaald op basis van naam, type en culturele
 * positie. Bij twijfel → `alternatief` (default fallback).
 */

const BASE = process.env.ADMIN_BASE_URL ?? 'http://localhost:8787';
const KEY = process.env.ADMIN_API_KEY;
if (!KEY) {
  console.error('ADMIN_API_KEY ontbreekt');
  process.exit(1);
}

type Scene = 'mainstream' | 'alternatief' | 'underground' | 'fringe';

const SCENES: Record<string, Scene> = {
  // ── MAINSTREAM ─────────────────────────────────────────────────────
  // Grote popzalen, kerngezelschappen, nationale musea, grote bioscopen.
  paradiso: 'mainstream',
  melkweg: 'mainstream',
  'het-concertgebouw': 'mainstream',
  'muziekgebouw-aan-het-ij': 'mainstream',
  bimhuis: 'mainstream',
  ita: 'mainstream',
  frascati: 'mainstream',
  'de-krakeling': 'mainstream',
  'de-brakke-grond': 'mainstream',
  'het-veem': 'mainstream',
  'bijlmer-parktheater': 'mainstream',
  compagnietheater: 'mainstream',
  // Musea — allemaal mainstream-instellingen.
  'stedelijk-museum': 'mainstream',
  'van-gogh-museum': 'mainstream',
  rijksmuseum: 'mainstream',
  'anne-frank-huis': 'mainstream',
  foam: 'mainstream',
  eye: 'mainstream',
  'oude-kerk': 'mainstream',
  'cobra-museum': 'mainstream',
  'wereldmuseum-amsterdam': 'mainstream',
  verzetsmuseum: 'mainstream',
  'amsterdam-museum': 'mainstream',
  'huis-marseille': 'mainstream',
  'nxt-museum': 'mainstream',
  // Bioscopen — gevestigd, breed publiek.
  rialto: 'mainstream',
  kriterion: 'mainstream',
  'the-movies': 'mainstream',
  lab111: 'mainstream',
  filmhallen: 'mainstream',
  'de-uitkijk': 'mainstream',
  // Cultuur-/debatcentra — gevestigd, breed publiek.
  'pakhuis-de-zwijger': 'mainstream',
  'de-balie': 'mainstream',
  spui25: 'mainstream',
  tolhuistuin: 'mainstream',
  'athenaeum-boekhandel': 'mainstream',
  // Mainstream-clubs / commercieel.
  shelter: 'mainstream',
  marktkantine: 'mainstream',
  thuishaven: 'mainstream',
  madam: 'mainstream',
  'club-home': 'mainstream',
  'club-nl': 'mainstream',
  'warehouse-elementenstraat': 'mainstream',
  // Internationaal-bekende commerciële galleries.
  grimm: 'mainstream',
  'annet-gelink-gallery': 'mainstream',
  'stigter-van-doesburg': 'mainstream',
  'galerie-ron-mandos': 'mainstream',

  // ── ALTERNATIEF ────────────────────────────────────────────────────
  // Niet-mainstream maar toegankelijk, eigen identiteit.
  volta: 'alternatief',
  bitterzoet: 'alternatief',
  'q-factory': 'alternatief',
  'de-nieuwe-anita': 'alternatief',
  'podium-mozaiek': 'alternatief',
  'casablanca-variete': 'alternatief',
  'bourbon-street': 'alternatief',
  'jazz-cafe-alto': 'alternatief',
  badcuyp: 'alternatief',
  'fc-hyena': 'alternatief',
  cinetol: 'alternatief',
  'aa-studio-k': 'alternatief',
  'aa-pakhuis-wilhelmina': 'alternatief',
  'aa-splendor': 'alternatief',
  'aa-volta': 'alternatief', // duplicate? if exists
  'aa-de-ruimte': 'alternatief',
  'aa-ndsm-loods': 'alternatief',
  'aa-treehouse-ndsm': 'alternatief',
  'aa-a-lab': 'alternatief',
  'aa-de-ceuvel': 'alternatief',
  'aa-loods-6': 'alternatief',
  'loods-6': 'alternatief',
  'aa-plein-theater': 'alternatief',
  'aa-zid-theater': 'alternatief',
  'aa-mike-s-badhuistheater': 'alternatief',
  'aa-teatro-munganga': 'alternatief',
  'aa-astarotheatro': 'alternatief',
  'aa-space-for-dance-art': 'alternatief',
  'aa-noon-coffee-culture': 'alternatief',
  'kanarie-club': 'alternatief',
  // Alternatieve clubs.
  'garage-noord': 'alternatief',
  'radio-radio': 'alternatief',
  doka: 'alternatief',
  lofi: 'alternatief',
  radion: 'alternatief',
  bret: 'alternatief',
  contact: 'alternatief',
  claire: 'alternatief',
  'tilla-tec': 'alternatief',
  'het-sieraad': 'alternatief',
  nachbar: 'alternatief',
  'inn-amsterdam': 'alternatief',
  // Mid-tier galleries.
  akinci: 'alternatief',
  'andriesse-eyck-galerie': 'alternatief',
  'borzo-gallery': 'alternatief',
  'galerie-bart': 'alternatief',
  'galerie-caroline-obreen': 'alternatief',
  'galerie-fontana': 'alternatief',
  'galerie-onrust': 'alternatief',
  'galerie-fons-welters': 'alternatief',
  'lumen-travo': 'alternatief',
  'slewe-gallery': 'alternatief',
  'upstream-gallery': 'alternatief',
  'rutger-brandt-gallery': 'alternatief',
  'galerie-martin-van-zomeren': 'alternatief',
  'galerie-fleur-wouter': 'alternatief',
  'gallery-van-fanny-freytag': 'alternatief',
  'kersgallery': 'alternatief',
  'no-mans-art-gallery': 'alternatief',
  'enari-gallery': 'alternatief',
  'galerie-de-schans': 'alternatief',
  'galerie-dudokdegroot': 'alternatief',
  langart: 'alternatief',
  'oscam': 'alternatief',
  'cbk-zuidoost': 'alternatief',
  'framer-framed': 'alternatief',
  'aa-kostgewonnen': 'alternatief',
  'aa-de-fabriek': 'alternatief',
  'aa-helicopter': 'alternatief',
  'aa-de-sloot': 'alternatief',
  'aa-lima': 'alternatief',
  'aa-de-culturele-stelling-van-amsterdam': 'alternatief',
  'sexyland-world': 'alternatief',
  'ot-west': 'alternatief',
  'aa-ru-pare': 'alternatief',

  // ── UNDERGROUND ────────────────────────────────────────────────────
  // DIY, vrijplaats, zelf-gerund, kleinere niche.
  occii: 'underground',
  'aa-occii': 'underground',
  cavia: 'underground',
  perdu: 'underground',
  'aa-vondelbunker': 'underground',
  'aa-plantagedok': 'underground',
  'aa-zaal-100': 'underground',
  'aa-fort-van-sjakoo': 'underground',
  'aa-nieuwland': 'underground',
  'aa-salon-de-ijzerstaven': 'underground',
  'aa-de-roze-tanker': 'underground',
  'aa-atelierwg-foundation': 'underground',
  'aa-buurtwerkplaats-noorderhof': 'underground',
  'aa-workship-op-de-ceuvel': 'underground',
  'aa-woonruimte-cooperatief': 'underground',
  ot301: 'underground',
  w139: 'underground',
  'de-appel': 'underground',
  'kunstverein-amsterdam': 'underground',
  'buro-stedelijk': 'underground',
  'paktamsterdam': 'underground',
  'rijksakademie': 'underground',
  'de-ateliers': 'underground',
  'if-i-cant-dance': 'underground',
  iso: 'underground',
  marwan: 'underground',
  rozenstraat: 'underground',
  puntwg: 'underground',
  'projectspace-38-40': 'underground',
  'm-simons': 'underground',
  'made-van-krimpen': 'underground',
  'gomulan-gallery': 'underground',
  'hama-gallery': 'underground',
  'tegenboschvanvreden': 'underground',
  'torch-gallery': 'underground',
  'josilda-da-conceicao': 'underground',
  'ellen-de-bruijne-projects': 'underground',
  'arti-et-amicitiae': 'underground',
  'no-limits-art-castle': 'underground',
  'bradwolff-projects': 'underground',
  'bradwolff-partners': 'underground',
  'aa-bajesdorp-grond': 'underground',

  // ── FRINGE ─────────────────────────────────────────────────────────
  // Extra-niche, micro-schaal, doelgroep zoekt actief.
  'aa-adm-noord-het-groene-veld': 'fringe',
  'aa-ruigoord': 'fringe',
  'aa-voedselpark-amsterdam': 'fringe',
  'aa-kaskantine': 'fringe',
  'aa-de-hoop': 'fringe',
  'aa-de-omleiding': 'fringe',
  'aa-rijkshemelvaartdienst': 'fringe',
  'aa-steelhenge': 'fringe',
  'aa-parknest': 'fringe',
  'aa-huis-te-vraag': 'fringe',
  'aa-zone-2-source': 'fringe',
};

// Default scene voor venues die niet in de mapping staan.
const DEFAULT_SCENE: Scene = 'alternatief';

// Haal alle venues op om te zien welke we moeten patchen.
const venuesRes = await fetch(`${BASE}/admin/api/venues`, {
  headers: { Authorization: `Bearer ${KEY}` },
});
const { venues } = (await venuesRes.json()) as {
  venues: Array<{ id: string; name: string }>;
};

let n = 0;
let defaulted = 0;
for (const v of venues) {
  const scene = SCENES[v.id] ?? DEFAULT_SCENE;
  const isDefault = !(v.id in SCENES);
  const res = await fetch(`${BASE}/admin/api/venues/${encodeURIComponent(v.id)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify({ scene }),
  });
  if (res.ok) {
    n++;
    const flag = isDefault ? '?' : '✓';
    if (isDefault) defaulted++;
    console.log(`${flag} ${v.id.padEnd(40)} → ${scene}${isDefault ? ' (default)' : ''}`);
  } else {
    console.warn(`✗ ${v.id}: ${res.status}`);
  }
}

console.log(
  `\nDone: ${n}/${venues.length} updated. ${defaulted} kreeg default '${DEFAULT_SCENE}' — review in admin.`
);
process.exit(0);
