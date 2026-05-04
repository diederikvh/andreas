/**
 * Capacity-classificatie voor alle venues. Indicatief, alleen tonen op
 * detail-pagina — geen filter.
 *   klein   = ~tot 200
 *   middel  = 200–1000
 *   groot   = 1000–5000
 *   xl      = 5000+
 */

const BASE = process.env.ADMIN_BASE_URL ?? 'http://localhost:8787';
const KEY = process.env.ADMIN_API_KEY!;

type Capacity = 'klein' | 'middel' | 'groot' | 'xl';

const CAPACITIES: Record<string, Capacity> = {
  // ── XL (>5000) ─────────────────────────────────────────────────────
  // (geen in onze huidige lijst — Ziggodome komt hier ooit)

  // ── GROOT (1000–5000) ──────────────────────────────────────────────
  paradiso: 'groot',
  melkweg: 'groot',
  'het-concertgebouw': 'groot',
  'muziekgebouw-aan-het-ij': 'groot',
  ita: 'groot',
  'rijksmuseum': 'groot',
  'van-gogh-museum': 'groot',
  'stedelijk-museum': 'groot',
  'eye': 'groot',
  'anne-frank-huis': 'groot',
  'wereldmuseum-amsterdam': 'groot',
  'tolhuistuin': 'groot',
  'pakhuis-de-zwijger': 'groot',
  'shelter': 'groot',
  'marktkantine': 'groot',
  'thuishaven': 'groot',
  'warehouse-elementenstraat': 'groot',
  'aa-ndsm-loods': 'groot',
  'aa-ruigoord': 'groot',
  'aa-adm-noord-het-groene-veld': 'groot',
  'oude-kerk': 'groot',
  'frascati': 'groot',
  'compagnietheater': 'groot',
  'bijlmer-parktheater': 'groot',
  'het-veem': 'groot',

  // ── MIDDEL (200–1000) ──────────────────────────────────────────────
  'bitterzoet': 'middel',
  'q-factory': 'middel',
  'bimhuis': 'middel',
  'podium-mozaiek': 'middel',
  'casablanca-variete': 'middel',
  'de-balie': 'middel',
  'de-brakke-grond': 'middel',
  'de-krakeling': 'middel',
  'amsterdam-museum': 'middel',
  'cobra-museum': 'middel',
  'verzetsmuseum': 'middel',
  'foam': 'middel',
  'huis-marseille': 'middel',
  'nxt-museum': 'middel',
  'rialto': 'middel',
  'kriterion': 'middel',
  'the-movies': 'middel',
  'lab111': 'middel',
  'filmhallen': 'middel',
  'fc-hyena': 'middel',
  'de-uitkijk': 'middel',
  'cinetol': 'middel',
  'aa-studio-k': 'middel',
  'club-home': 'middel',
  'club-nl': 'middel',
  'madam': 'middel',
  'garage-noord': 'middel',
  'doka': 'middel',
  'lofi': 'middel',
  'radion': 'middel',
  'aa-pakhuis-wilhelmina': 'middel',
  'aa-volta': 'middel',
  'aa-de-ruimte': 'middel',
  'aa-zaal-100': 'middel',
  'aa-plein-theater': 'middel',
  'aa-zid-theater': 'middel',
  'aa-de-ceuvel': 'middel',
  'aa-a-lab': 'middel',
  'aa-treehouse-ndsm': 'middel',
  'aa-loods-6': 'middel',
  'loods-6': 'middel',
  'framer-framed': 'middel',
  'oscam': 'middel',
  'cbk-zuidoost': 'middel',
  'spui25': 'middel',
  'kanarie-club': 'middel',
  'aa-splendor': 'middel',
  'volta': 'middel',
  'rijksakademie': 'middel',
  'de-ateliers': 'middel',
  'sexyland-world': 'middel',
  'q-factory': 'middel',

  // ── KLEIN (<200) ───────────────────────────────────────────────────
  'occii': 'klein',
  'cavia': 'klein',
  'perdu': 'klein',
  'bourbon-street': 'klein',
  'jazz-cafe-alto': 'klein',
  'badcuyp': 'klein',
  'de-nieuwe-anita': 'klein',
  'aa-vondelbunker': 'klein',
  'aa-plantagedok': 'klein',
  'aa-fort-van-sjakoo': 'klein',
  'aa-nieuwland': 'klein',
  'aa-salon-de-ijzerstaven': 'klein',
  'aa-de-roze-tanker': 'klein',
  'aa-mike-s-badhuistheater': 'klein',
  'aa-teatro-munganga': 'klein',
  'aa-astarotheatro': 'klein',
  'aa-space-for-dance-art': 'klein',
  'aa-noon-coffee-culture': 'klein',
  'aa-atelierwg-foundation': 'klein',
  'aa-buurtwerkplaats-noorderhof': 'klein',
  'aa-kostgewonnen': 'klein',
  'aa-de-fabriek': 'klein',
  'aa-helicopter': 'klein',
  'aa-de-sloot': 'klein',
  'aa-lima': 'klein',
  'aa-de-culturele-stelling-van-amsterdam': 'klein',
  'aa-bajesdorp-grond': 'klein',
  'aa-workship-op-de-ceuvel': 'klein',
  'aa-woonruimte-cooperatief': 'klein',
  'aa-voedselpark-amsterdam': 'klein',
  'aa-kaskantine': 'klein',
  'aa-de-hoop': 'klein',
  'aa-de-omleiding': 'klein',
  'aa-rijkshemelvaartdienst': 'klein',
  'aa-steelhenge': 'klein',
  'aa-parknest': 'klein',
  'aa-huis-te-vraag': 'klein',
  'aa-zone-2-source': 'klein',
  'aa-ru-pare': 'klein',
  'ot301': 'klein',
  'ot-west': 'klein',
  'tilla-tec': 'klein',
  'bret': 'klein',
  'contact': 'klein',
  'claire': 'klein',
  'het-sieraad': 'klein',
  'nachbar': 'klein',
  'inn-amsterdam': 'klein',
  'radio-radio': 'klein',
  'radion': 'klein',
  'shelter': 'middel', // override: meer dan klein
  // Kleinere galleries — allemaal klein.
  'akinci': 'klein',
  'andriesse-eyck-galerie': 'klein',
  'borzo-gallery': 'klein',
  'galerie-bart': 'klein',
  'galerie-caroline-obreen': 'klein',
  'galerie-fontana': 'klein',
  'galerie-onrust': 'klein',
  'galerie-fons-welters': 'klein',
  'galerie-ron-mandos': 'klein',
  'lumen-travo': 'klein',
  'slewe-gallery': 'klein',
  'upstream-gallery': 'klein',
  'rutger-brandt-gallery': 'klein',
  'galerie-martin-van-zomeren': 'klein',
  'galerie-fleur-wouter': 'klein',
  'gallery-van-fanny-freytag': 'klein',
  'kersgallery': 'klein',
  'no-mans-art-gallery': 'klein',
  'enari-gallery': 'klein',
  'galerie-de-schans': 'klein',
  'galerie-dudokdegroot': 'klein',
  'langart': 'klein',
  'grimm': 'klein',
  'annet-gelink-gallery': 'klein',
  'stigter-van-doesburg': 'klein',
  'rozenstraat': 'klein',
  'puntwg': 'klein',
  'projectspace-38-40': 'klein',
  'm-simons': 'klein',
  'made-van-krimpen': 'klein',
  'gomulan-gallery': 'klein',
  'hama-gallery': 'klein',
  'tegenboschvanvreden': 'klein',
  'torch-gallery': 'klein',
  'josilda-da-conceicao': 'klein',
  'ellen-de-bruijne-projects': 'klein',
  'arti-et-amicitiae': 'klein',
  'no-limits-art-castle': 'klein',
  'bradwolff-projects': 'klein',
  'bradwolff-partners': 'klein',
  'w139': 'klein',
  'de-appel': 'klein',
  'kunstverein-amsterdam': 'klein',
  'buro-stedelijk': 'klein',
  'paktamsterdam': 'klein',
  'if-i-cant-dance': 'klein',
  'iso': 'klein',
  'marwan': 'klein',
  'athenaeum-boekhandel': 'klein',
};

const res = await fetch(`${BASE}/admin/api/venues`, {
  headers: { Authorization: `Bearer ${KEY}` },
});
const { venues } = (await res.json()) as {
  venues: Array<{ id: string; name: string }>;
};

let n = 0;
let unmatched = 0;
for (const v of venues) {
  const cap = CAPACITIES[v.id];
  if (!cap) {
    unmatched++;
    console.log(`? ${v.id} (${v.name}) — geen waarde, skip`);
    continue;
  }
  const r = await fetch(`${BASE}/admin/api/venues/${encodeURIComponent(v.id)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify({ capacity: cap }),
  });
  if (r.ok) {
    n++;
    console.log(`✓ ${v.id.padEnd(40)} → ${cap}`);
  }
}
console.log(`\nDone: ${n}/${venues.length} updated. ${unmatched} zonder mapping.`);
process.exit(0);
