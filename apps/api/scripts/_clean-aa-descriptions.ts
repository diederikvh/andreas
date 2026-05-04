/**
 * Eenmalige cleanup voor de aa-venues:
 *   - HTML-entities decoden (&eacute; → é, &nbsp; → spatie, etc.)
 *   - Engelse beschrijvingen vertalen naar Nederlands
 *
 *   pnpm tsx --env-file=.env scripts/_clean-aa-descriptions.ts
 */

const BASE = process.env.ADMIN_BASE_URL ?? 'http://localhost:8787';
const KEY = process.env.ADMIN_API_KEY;
if (!KEY) {
  console.error('ADMIN_API_KEY ontbreekt');
  process.exit(1);
}

// Volledige Nederlandse vertalingen voor venues die in het Engels stonden.
const TRANSLATIONS: Record<string, string> = {
  'aa-adm-noord-het-groene-veld':
    'Het Groene Veld is een groene plek op de grens van stad en platteland. Op deze mooie locatie werken kunstenaars, buurtbewoners en sociale initiatieven aan bijzondere projecten.',
  'aa-astarotheatro':
    'AstaroTheatro is een onafhankelijke, niet-mainstream open ruimte voor theater, kunst, muziek, culturen, films, evenementen, discussies en activisme. Een plek om elkaar echt te ontmoeten en met elkaar te delen. AstaroTheatro wil gemeenschap en bewustzijn creëren.',
  'aa-atelierwg-foundation':
    'In Oud-West huisvest het oude Wilhelmina Gasthuis-gebouw nu atelierWG, een complex met kunstenaarsateliers, puntWG (een interdisciplinaire tentoonstellingsruimte) en het artist-in-residence-programma airWG.',
  'aa-bajesdorp-grond':
    'GROND is een nieuwe kunstruimte en collectief op het Nieuwe Bajesdorp, met als kern collectiviteit, duurzaamheid, kruisbestuiving en proces-gericht werken.',
  'aa-helicopter':
    'Helicopter Amsterdam is een initiatief van Vincent Polak, Sophie Neijts en Bernard van Veen, opgericht in 2010 — toen nog onder de naam Sink Or Swim. Ons doel is werkruimte bieden aan podiumkunstenaars, voornamelijk (live-)muzikanten. Sinds 2020 beheert Helicopter Amsterdam 500 m² creatieve ruimte verdeeld over 13 kamers en 2 gemeenschappelijke ruimtes.',
  'aa-kaskantine':
    'Als off-grid organisatie gebruiken we tijdelijk beschikbare stukken grond. In de afgelopen jaren hadden we vier verschillende locaties; nu zitten we in Amsterdam-Slotervaart. Daar hebben we elf zeecontainers en twee kassen omgebouwd tot een ontmoetings-, kweek-, eet- en samenwerkplek. Off-grid werken laat ons grond in de stad gebruiken die tijdelijk leegstaat en weinig marktwaarde heeft.',
  'aa-mike-s-badhuistheater':
    "Mike's Badhuistheater is hét huis van het Engelstalige theater in Amsterdam. Een vriendelijke, gastvrije plek in Amsterdam-Oost voor muziek, dans, theater, feesten en bijeenkomsten.",
  'aa-nieuwland':
    'NieuwLand is een solidaire, zelf-gebouwde woon- en werkplek én een niet-commercieel, vrijwilliger-gerund sociaal-politiek buurtcentrum in de Dapperbuurt, Amsterdam-Oost. Ons maandprogramma staat vol filmavonden, info-avonden over activisme, discussies, ruilbeurzen, schaakavonden, yogalessen, radicale gratis kappers en meer.',
  'aa-pakhuis-wilhelmina':
    'Pakhuis Wilhelmina is een uniek cultuurcentrum aan de Amsterdamse IJ-oevers. Op 25 juni 1988, midden in het EK voetbal toen Nederland Europees kampioen werd, kraakte een groep kunstenaars het pand. Sindsdien is het uitgegroeid tot een alternatief cultuurplatform met 94 ateliers en publieke ruimtes.',
  'aa-plein-theater':
    'Het Plein Theater in Amsterdam-Oost is een levendige hub voor verbeelding en uitwisseling. In de historische Amstelbrouwerij aan de Mauritskade maken en tonen we genre-overstijgende voorstellingen. Een theater waar buurtbewoners zowel kijken als zelf maken — voorloper in hedendaagse dans & muziek, poppen- en objecttheater en sociaal-geëngageerde exposities. Het scharniert tussen de buurt en de bredere stad.',
  'aa-ru-pare':
    'De Ru Paré Community is een buurtcentrum in een voormalig basisschoolgebouw in Slotervaart. Tientallen organisaties en initiatieven hebben hier hun thuis. Er is een podium met een maandelijks sociaal-cultureel programma met muziek, theater, workshops en discussie. Daarnaast is het een prettige, toegankelijke hangplek die dagelijks open is van maandag tot vrijdag tot 21:00. We staan voor inclusie en solidariteit door de sociale infrastructuur te versterken via commoning.',
  'aa-ruigoord':
    'Ruigoord is een groen dorp waar kunstenaars in ateliers en werkplaatsen voor zichzelf werken maar ook deelnemen aan de gemeenschap. Er is een sterke traditie van samenwerking, versterkt door de bredere kring van verwante geesten in Nederland en daarbuiten. Daardoor kan Ruigoord functioneren als publieke voorziening met een zeer divers programma.',
  'aa-space-for-dance-art':
    'Sinds september 2021 zit ICK Dans Amsterdam in het iconische Westbeat-gebouw in Amsterdam Nieuw-West. In samenwerking met kunstenaars uit verschillende disciplines heeft het dansgezelschap hier Space for Dance Art opgericht — een plek voor voorstellingen, workshops en symposia, geboren uit artistieke drang.',
  'aa-splendor':
    'In het hart van Amsterdam vind je Splendor: een podium voor alle soorten muziek, opgericht door 50 vooraanstaande musici en hun publiek. Splendor is een ontmoetingsplek, een club, een werkplaats, een muzikaal laboratorium en zoveel meer.',
  'aa-steelhenge':
    'Steelhenge is een migrerende spirituele ruimte die voortborduurt op de erfenis van Robodock. Het biedt ruimte aan diverse kunstvormen en disciplines en roept ons op te reflecteren op de tijd waarin we leven en de crises en verschuivingen die haar vormen.',
  'aa-teatro-munganga':
    "Theatergroep Munganga komt uit Brazilië. De naam Munganga (uitgesproken: 'moen-gang-gaa') is afgeleid van Mganga — een Afrikaanse stam waarvan de priesters tijdens rituelen grootse, uitbundige gebaren maken. Sinds de oprichting in 1987 geeft Teatro Munganga een hoofdrol aan de visuele taal in haar voorstellingen. Door theater te mengen met muziek, dans en poppenspel toont de groep de poëzie van het alledaagse. Hun voorstellingen behandelen universele thema's, waarin verschillende culturen en hun contrasten de leidraad vormen.",
  'aa-treehouse-ndsm':
    'Treehouse NDSM, in het creatieve hart van Amsterdam, is een speeltuin voor toegewijde kunstenaars. Of je nu net bent afgestudeerd en je netwerk opbouwt, of een ervaren professional die zoekt naar de volgende stap — ons doel is jouw artistieke project te laten groeien en zichtbaar maken.',
  'aa-vondelbunker':
    "De Vondelbunker is een 100% door vrijwilligers gerunde ruimte die met DIY-politiek een plek schept voor counterculture in het hyperkapitalistische stadscentrum. Gevestigd in een oude schuilkelder onder een brug in het Vondelpark — bands en DJ's spelen er, performances worden getoond, films vertoond, kunst geëxposeerd en discussies gevoerd.",
  'aa-zone-2-source':
    'Sinds 2013 is Zone2Source een dynamisch laboratorium voor kunst en ecologie, verspreid over diverse paviljoens, kunstenaarstuinen en de buitenruimtes van het Amstelpark in Amsterdam-Zuid. Geïnspireerd op de geschiedenis van het park als locatie van de Floriade 1972 werken we samen met kunstenaars en publiek aan tentoonstellingen, onderzoeksresidenties, buitenprojecten, performances, workshops, expedities en debatten. Samen verkennen we nieuwe visies op de relatie tussen natuur en cultuur.',
  'aa-woonruimte-cooperatief':
    '[ woonruimte coöperatief ] is een non-profit coöperatie die de ontwikkeling van betaalbare woningen ondersteunt. Als integraal onderdeel van Wooncoöperatie de Nieuwe Meent in Amsterdam-Oost runnen we een ruimte waar mensen elkaar kunnen ontmoeten, werken, maken en samenkomen. Woonruimte huisvest een coworking-ruimte, een evenementenruimte en Noon Coffee and Culture.',
};

// Eenvoudige HTML-entity decoder (geen externe deps).
const ENTITY_MAP: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&eacute;': 'é',
  '&egrave;': 'è',
  '&euml;': 'ë',
  '&ecirc;': 'ê',
  '&iacute;': 'í',
  '&igrave;': 'ì',
  '&iuml;': 'ï',
  '&oacute;': 'ó',
  '&ograve;': 'ò',
  '&ouml;': 'ö',
  '&ocirc;': 'ô',
  '&uacute;': 'ú',
  '&ugrave;': 'ù',
  '&uuml;': 'ü',
  '&ucirc;': 'û',
  '&aacute;': 'á',
  '&agrave;': 'à',
  '&auml;': 'ä',
  '&acirc;': 'â',
  '&atilde;': 'ã',
  '&ntilde;': 'ñ',
  '&ccedil;': 'ç',
  '&Eacute;': 'É',
  '&Auml;': 'Ä',
  '&Ouml;': 'Ö',
  '&Uuml;': 'Ü',
  '&rsquo;': '’',
  '&lsquo;': '‘',
  '&rdquo;': '”',
  '&ldquo;': '“',
  '&ndash;': '–',
  '&mdash;': '—',
  '&hellip;': '…',
  '&sup2;': '²',
  '&sup3;': '³',
  '&deg;': '°',
};

function decodeEntities(s: string): string {
  let out = s;
  for (const [k, v] of Object.entries(ENTITY_MAP)) {
    out = out.split(k).join(v);
  }
  // Numerieke entities: &#39; = '
  out = out.replace(/&#(\d+);/g, (_, n) =>
    String.fromCodePoint(Number(n))
  );
  // Hex: &#x27;
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, n) =>
    String.fromCodePoint(parseInt(n, 16))
  );
  // Restant: opeenvolgende spaties tot één.
  out = out.replace(/[ \t]+/g, ' ').trim();
  return out;
}

// Haal alle aa-venues op om te zien welke nog bestaan.
const venuesRes = await fetch(`${BASE}/admin/api/venues`, {
  headers: { Authorization: `Bearer ${KEY}` },
});
const venuesData = (await venuesRes.json()) as {
  venues: Array<{ id: string; description: string | null }>;
};
const aaVenues = venuesData.venues.filter((v) => v.id.startsWith('aa-'));

let translated = 0;
let decoded = 0;
let skipped = 0;

for (const v of aaVenues) {
  let next: string | null = null;
  if (TRANSLATIONS[v.id]) {
    next = TRANSLATIONS[v.id];
    translated++;
  } else if (v.description) {
    const decodedDesc = decodeEntities(v.description);
    if (decodedDesc !== v.description) {
      next = decodedDesc;
      decoded++;
    } else {
      skipped++;
      continue;
    }
  } else {
    skipped++;
    continue;
  }

  const res = await fetch(
    `${BASE}/admin/api/venues/${encodeURIComponent(v.id)}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${KEY}`,
      },
      body: JSON.stringify({ description: next }),
    }
  );
  if (res.ok) {
    console.log(
      `${TRANSLATIONS[v.id] ? '🇳🇱' : '✓'} ${v.id} (${TRANSLATIONS[v.id] ? 'vertaald' : 'decoded'})`
    );
  } else {
    console.warn(`✗ ${v.id}: ${res.status}`);
  }
}

console.log(
  `\nDone: ${translated} vertaald, ${decoded} decoded, ${skipped} overgeslagen.`
);
process.exit(0);
