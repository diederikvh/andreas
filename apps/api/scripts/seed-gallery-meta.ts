/**
 * seed-gallery-meta.ts
 *
 * Verrijkt 55 Amsterdamse galeries met betere `description` en consistentere `subtype`.
 *
 * --- VOCABULARY (max 20 labels, consequent toegepast) ---
 *
 * Organisatievorm (kies altijd 1):
 *   - commercieel            (regulier handels-model, verkoopt vertegenwoordigd werk)
 *   - artist-run             (gerund door kunstenaars zelf)
 *   - non-profit             (stichting / publiek gefinancierd, geen handelsmotief)
 *   - project-space          (presentatie-platform, vaak naast commercie of als non-profit)
 *
 * Focus-discipline (0–2):
 *   - schilderkunst
 *   - fotografie
 *   - beeldhouwkunst
 *   - installatie
 *   - conceptueel
 *   - nieuwe-media           (digitale kunst, crypto, video, internet-based)
 *   - performance
 *   - keramiek-textiel       (craft-based contemporary: keramiek, textiel, glas)
 *
 * Niche / positionering (0–2):
 *   - jonge-kunst            (opkomende, recent afgestudeerd)
 *   - midcareer
 *   - bluechip               (internationale top, secundaire markt)
 *   - internationaal         (uitgesproken internationaal programma)
 *   - queer-feministisch
 *   - dekoloniaal            (postkoloniaal / globaal-zuid / migratie-perspectief)
 *
 * Bijzonderheid (0–2):
 *   - residentie
 *   - educatie
 *   - cultureel-maatschappelijk
 *   - experimenteel
 *
 * Totaal: 20 labels. Een galerie krijgt 2–5 labels: altijd 1 organisatievorm + 1–4 anderen.
 */

import { eq } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

type Target = { id: string; description: string; subtype: string[] };

const TARGETS: Target[] = [
  {
    id: 'akinci',
    description:
      'Commerciële galerie sinds 1988, opgericht door Nazif Topçuoğlu en sinds eind jaren ’90 voortgezet door Aiko Akinci. Programma met overwegend conceptueel en politiek geladen werk van internationale midcareer-kunstenaars; bekend om langdurige samenwerkingen en een eigen podcast.',
    subtype: ['commercieel', 'conceptueel', 'internationaal', 'midcareer'],
  },
  {
    id: 'andriesse-eyck-galerie',
    description:
      'Jordaan-galerie (voortzetting van het programma van wijlen Paul Andriesse, voortgezet door Pim van der Eyck) met een Nederlandse signatuur in schilderkunst, beeldhouwkunst en fotografie. Werkt langjarig met namen als Sylvie Zijlmans, Hewald Jongenelis en Emmeline de Mooij.',
    subtype: ['commercieel', 'schilderkunst', 'midcareer'],
  },
  {
    id: 'annet-gelink-gallery',
    description:
      'Toonaangevende commerciële galerie aan de Laurierstraat sinds 2000, met een internationaal programma rond namen als Ryan Gander, Yael Bartana, David Maljkovic en Meiro Koizumi. Focus op conceptueel en film/video-werk; vaste deelnemer aan Art Basel en Frieze.',
    subtype: ['commercieel', 'conceptueel', 'internationaal', 'midcareer'],
  },
  {
    id: 'arti-et-amicitiae',
    description:
      'Kunstenaarsvereniging op het Rokin sinds 1839 — een van de oudste van Nederland. Leden-gestuurde tentoonstellingen op de eerste verdieping (boven de befaamde Berlage-zaal), met een mix van gevestigde en recent afgestudeerde Nederlandse kunstenaars en een eigenzinnig randprogramma.',
    subtype: ['artist-run', 'non-profit', 'midcareer'],
  },
  {
    id: 'aa-bajesdorp-grond',
    description:
      'Artist-run kunstruimte en collectief op het Nieuwe Bajesdorp in Oost, opgericht in 2024. Programma rond duurzaamheid, collectiviteit en proces-gericht werken; deels expositieruimte, deels werkplaats.',
    subtype: ['artist-run', 'experimenteel', 'cultureel-maatschappelijk'],
  },
  {
    id: 'borzo-gallery',
    description:
      'Gevestigde galerie sinds 1974, met een dubbele focus op klassiek-modern Nederlands werk (CoBrA, Carel Visser, Constant) en hedendaagse beeldhouwkunst en werken op papier. Bedient zowel verzamelaars als de secundaire markt.',
    subtype: ['commercieel', 'beeldhouwkunst', 'bluechip'],
  },
  {
    id: 'bradwolff-partners',
    description:
      'Commerciële tak van Bradwolff in Oost, met focus op conceptueel en sociaal-geëngageerd werk van mid-career kunstenaars. Klein, gecureerd programma met een eigen project-space (Bradwolff Projects) als experimenteel laboratorium ernaast.',
    subtype: ['commercieel', 'conceptueel', 'midcareer'],
  },
  {
    id: 'bradwolff-projects',
    description:
      'Non-profit project-space gelieerd aan Bradwolff & Partners in Oost. Biedt ruimte aan experimenteel, langlopend onderzoek van kunstenaars buiten het commerciële tentoonstellingsritme — vaak in samenwerking met curatoren en onderzoekers.',
    subtype: ['project-space', 'non-profit', 'experimenteel', 'conceptueel'],
  },
  {
    id: 'buro-stedelijk',
    description:
      'Project-ruimte van het Stedelijk Museum, gewijd aan opkomende kunstenaars, korte experimenten en publieke programma’s rond de hoofdcollectie. Curatoriaal speelterrein binnen een gevestigd instituut.',
    subtype: ['project-space', 'non-profit', 'experimenteel', 'jonge-kunst'],
  },
  {
    id: 'cbk-zuidoost',
    description:
      'Publiek Centrum Beeldende Kunst in de Bijlmer, met collectie, expositieruimte en het residentie-programma BijlmAIR voor kunstenaars met een binding aan Zuidoost. Sterk dekoloniaal en cultureel-maatschappelijk geladen profiel.',
    subtype: ['non-profit', 'cultureel-maatschappelijk', 'residentie', 'dekoloniaal'],
  },
  {
    id: 'de-appel',
    description:
      'Sinds 1975 invloedrijk Amsterdams instituut voor hedendaagse kunst, performance en curatorial practice — bekend om de De Appel Curatorial Programme. Verhuisde naar Nieuw-West (Broedplaats Lely); focus op experiment, theorie en discursieve formats.',
    subtype: ['non-profit', 'project-space', 'experimenteel', 'educatie'],
  },
  {
    id: 'ellen-de-bruijne-projects',
    description:
      'Commerciële galerie sinds 1999 met een uitgesproken conceptuele, feministische en politiek geëngageerde signatuur. Werkt met namen als Lily van der Stokker, Pauline Boudry / Renate Lorenz, Maria Pask en Anne-lise Coste — vaak performance-georiënteerd.',
    subtype: ['commercieel', 'conceptueel', 'queer-feministisch', 'performance'],
  },
  {
    id: 'enari-gallery',
    description:
      'Jonge commerciële galerie aan de Utrechtsestraat met focus op opkomende internationale schilders. Klein, dichtbij geprogrammeerd; sterke aanwezigheid op Europese beurzen voor emerging art.',
    subtype: ['commercieel', 'schilderkunst', 'jonge-kunst', 'internationaal'],
  },
  {
    id: 'framer-framed',
    description:
      'Non-profit platform op de Oranje-Vrijstaatkade (Oost) met een nadrukkelijk dekoloniaal, intercultureel programma — tentoonstellingen, debat, film en residenties rond migratie, identiteit en globale machtsverhoudingen.',
    subtype: ['non-profit', 'project-space', 'dekoloniaal', 'cultureel-maatschappelijk'],
  },
  {
    id: 'framer-framed-noord',
    description:
      'Tweede vestiging van Framer Framed in Noord, met de nadruk op productie, residenties en langlopende projecten — een rustigere, groene werkplek naast de publieksvleugel in Oost.',
    subtype: ['non-profit', 'project-space', 'residentie', 'experimenteel'],
  },
  {
    id: 'grimm',
    description:
      'Internationaal opererende galerie met vestigingen in Amsterdam, New York en Londen. Programmeert bluechip en mid-career schilders en beeldhouwers zoals Daniel Richter, Charles Avery, Volker Hüller en Matthias Weischer; vaste speler op Art Basel en Frieze.',
    subtype: ['commercieel', 'schilderkunst', 'internationaal', 'bluechip'],
  },
  {
    id: 'galerie-bart',
    description:
      'Galerie van Bart Hoogwegt aan de Elandsgracht (sinds 2007 in Amsterdam, oorspronkelijk Nijmegen 2003). Focus op kunstenaars die in Nederland afstudeerden — schilders, tekenaars, fotografen, beeldhouwers — met ongeveer tien solo’s per jaar.',
    subtype: ['commercieel', 'schilderkunst', 'jonge-kunst'],
  },
  {
    id: 'galerie-caroline-obreen',
    description:
      'Commerciële fotografie-galerie met focus op Nederlandse en internationale documentaire- en kunstfotografie. Programmeert zowel gevestigde fotografen als jonge makers; vaste deelnemer aan Unseen Amsterdam.',
    subtype: ['commercieel', 'fotografie', 'internationaal'],
  },
  {
    id: 'galerie-fleur-wouter',
    description:
      'Commerciële galerie in De Pijp (Van Ostadestraat) met een interdisciplinair programma — schilderkunst, beeldhouwkunst, glas en installatie. Werkt met midcareer Nederlandse kunstenaars zoals Erik Mattijssen en Fiona Lutjenhuis, wier werk in collecties als het Stedelijk en het Noordbrabants Museum hangt.',
    subtype: ['commercieel', 'schilderkunst', 'midcareer'],
  },
  {
    id: 'galerie-fons-welters',
    description:
      'Toonaangevende galerie sinds 1988, gevestigd aan de Bloemstraat in een ruimte met de iconische Atelier Van Lieshout-entree. Sterke focus op beeldhouwkunst en installatie van Nederlandse kunstenaars zoals Job Koelewijn, Folkert de Jong en Berend Strik; lange tijd springplank voor jong talent.',
    subtype: ['commercieel', 'beeldhouwkunst', 'installatie', 'midcareer'],
  },
  {
    id: 'galerie-fontana',
    description:
      'Commerciële galerie met vestigingen in Amsterdam (Lauriergracht) en Brussel, gespecialiseerd in hedendaagse keramiek en textiel. Toont kunstenaars die ambachtelijke disciplines conceptueel en sculpturaal openbreken.',
    subtype: ['commercieel', 'keramiek-textiel', 'beeldhouwkunst'],
  },
  {
    id: 'galerie-martin-van-zomeren',
    description:
      'Conceptueel georiënteerde commerciële galerie met internationaal programma — werkt met onder anderen David Jablonowski, Lily van der Stokker en Sara van der Heide. Vaste presentatie op beurzen als Art Brussels en Liste.',
    subtype: ['commercieel', 'conceptueel', 'internationaal', 'midcareer'],
  },
  {
    id: 'galerie-onrust',
    description:
      'Galerie van Milco Onrust sinds augustus 1986 (sinds 2011 aan de Planciusstraat), gespecialiseerd in hedendaagse schilderkunst van Nederlandse en Duitse kunstenaars. Bekend om langdurige relaties met namen als Toon Verhoef, Robert Zandvliet en Marijn van Kreij.',
    subtype: ['commercieel', 'schilderkunst', 'midcareer'],
  },
  {
    id: 'galerie-ron-mandos',
    description:
      'Grote commerciële galerie in de Jordaan met een uitgesproken internationaal en publieksgericht profiel. Bekend om het jaarlijkse Best of Graduates-overzicht; programmeert kunstenaars als Levi van Veluw, Isaac Julien en Erwin Olaf-erfgenamen.',
    subtype: ['commercieel', 'internationaal', 'midcareer', 'jonge-kunst'],
  },
  {
    id: 'galerie-de-schans',
    description:
      'Non-profit galerie met een uniek profiel: focus op kunstenaars met een psychiatrische achtergrond of beperking. Outsider-art en hedendaagse praktijk worden bewust niet gescheiden gehouden; sociaal-cultureel gemotiveerd programma.',
    subtype: ['non-profit', 'cultureel-maatschappelijk', 'project-space'],
  },
  {
    id: 'gallery-van-fanny-freytag',
    description:
      'Kleine commerciële galerie met focus op opkomende hedendaagse kunstenaars, vooral schilderkunst en werk op papier. Programmeert solo’s en duo-presentaties in een intieme setting in het centrum.',
    subtype: ['commercieel', 'schilderkunst', 'jonge-kunst'],
  },
  {
    id: 'gomulan-gallery',
    description:
      'Commerciële galerie met focus op Aziatische — vooral Nederlands-Chinese — hedendaagse kunst. Een van de weinige Amsterdamse galeries die deze diaspora structureel programmeert; mix van schilderkunst en installatie.',
    subtype: ['commercieel', 'schilderkunst', 'internationaal', 'dekoloniaal'],
  },
  {
    id: 'hama-gallery',
    description:
      'Jonge commerciële galerie met focus op opkomende internationale kunstenaars (Chiara Caselli, Hoshyar Rasheed, Melissa Schriek). Toegankelijk geprogrammeerd over meerdere disciplines, met een actieve online shop voor edities.',
    subtype: ['commercieel', 'jonge-kunst', 'internationaal'],
  },
  {
    id: 'aa-helicopter',
    description:
      'Artist-run werkplek en presentatieruimte in West, opgericht in 2010 door Vincent Polak, Sophie Neijts en Bernard van Veen (oorspronkelijk Sink Or Swim). 500 m² verdeeld over 13 ateliers, met podiumkunstenaars en (live-)muzikanten als kern; presenteert af en toe publiekswerk.',
    subtype: ['artist-run', 'project-space', 'experimenteel'],
  },
  {
    id: 'iso',
    description:
      'Kleine artist-run project-space in Noord, gerund door een rouleerend collectief. Korte tentoonstellingen en presentaties van recent afgestudeerden en mid-career kunstenaars, vaak gekoppeld aan publicaties of performances.',
    subtype: ['project-space', 'artist-run', 'jonge-kunst', 'experimenteel'],
  },
  {
    id: 'if-i-cant-dance',
    description:
      'Non-profit platform opgericht in 2005, gewijd aan performance, choreografie en de productie van nieuw werk via meerjarige onderzoeksprogramma’s (Editions). Belangrijke speler in het Amsterdamse performance-veld, met een feministische en queer signatuur.',
    subtype: ['non-profit', 'performance', 'queer-feministisch', 'experimenteel'],
  },
  {
    id: 'josilda-da-conceicao',
    description:
      'Commerciële galerie met focus op hedendaagse kunstenaars die postkoloniale en globale verhalen onderzoeken — ontwikkeling, identiteit, migratie. Programmeert internationaal en buiten westerse hoofdstromen; gelieerd aan de Kunstkoop.',
    subtype: ['commercieel', 'dekoloniaal', 'internationaal', 'conceptueel'],
  },
  {
    id: 'kersgallery',
    description:
      'Commerciële galerie aan de Lindengracht met sterke focus op hedendaagse schilderkunst — overwegend Nederlandse mid-career kunstenaars als Eline Boerma en Lotte Wieringa, vaak in solo-formats. Vaste deelnemer aan Art Rotterdam.',
    subtype: ['commercieel', 'schilderkunst', 'midcareer'],
  },
  {
    id: 'kunstverein-amsterdam',
    description:
      'Curatorial-driven Kunstverein op een appartement aan de Gerard Doustraat (lid van het internationale Kunstverein-netwerk). Geen reguliere tentoonstellingen maar publicaties, edities en gesprekken — een bewust kleinschalig en discursief model.',
    subtype: ['non-profit', 'project-space', 'conceptueel', 'experimenteel'],
  },
  {
    id: 'langart',
    description:
      'Commerciële galerie (recent doorgegaan onder de naam LANG Gallery) met focus op figuratieve en abstracte schilderkunst, vaak rond thema’s als migratie, identiteit en cultureel meervoudige achtergrond. Werkt met laureaten als Faria van Creij-Callender.',
    subtype: ['commercieel', 'schilderkunst', 'midcareer'],
  },
  {
    id: 'lumen-travo',
    description:
      'Commerciële galerie sinds 1990, met een conceptueel en politiek geladen internationaal programma — kunstenaars als Rossella Biscotti, Patricia Kaersenhout en Quinsy Gario. Sterke focus op dekoloniaal en globaal-zuid perspectief.',
    subtype: ['commercieel', 'conceptueel', 'internationaal', 'dekoloniaal'],
  },
  {
    id: 'made-van-krimpen',
    description:
      'Commerciële galerie met een interdisciplinair programma — schilderkunst, beeldhouwkunst, fotografie en installatie. Werkt zowel met gevestigde namen (Henk Visch, Paul Kooiker, Iris Kensmil) als met opkomende kunstenaars.',
    subtype: ['commercieel', 'schilderkunst', 'midcareer'],
  },
  {
    id: 'marwan',
    description:
      'Artist-run project-space in het centrum, gerund als een nomadische curatoriële praktijk. Korte, scherp gecureerde projecten van overwegend jonge internationale kunstenaars; sterk discursief, met regelmatig publicaties en talks. TODO: beperkte openbare info beschikbaar.',
    subtype: ['project-space', 'artist-run', 'jonge-kunst', 'experimenteel'],
  },
  {
    id: 'no-limits-art-castle',
    description:
      'Ongebonden, eigenzinnige kunstruimte op De Wallen — een mix van presentatieruimte, performance-podium en kunstenaarsbar. Programmeert experimenteel werk buiten het reguliere galerie- en instituutscircuit. TODO: beperkte openbare info beschikbaar.',
    subtype: ['artist-run', 'experimenteel', 'performance'],
  },
  {
    id: 'no-mans-art-gallery',
    description:
      'Commerciële galerie in Bos en Lommer (met een kleinere KIOSK-locatie) en jaarlijkse pop-ups in steden als Mexico City, Teheran, Shanghai en Kaapstad. Focus op opkomende kunstenaars uit ondervertegenwoordigde kunstgemeenschappen; lid van de NGA.',
    subtype: ['commercieel', 'internationaal', 'jonge-kunst', 'dekoloniaal'],
  },
  {
    id: 'oscam',
    description:
      'Open Space Contemporary Art Museum in de Bijlmer — non-profit hybride van museum, galerie en community-platform. Programmeert kunstenaars en thema’s met sterke binding aan Zuidoost, hip-hop-cultuur en Black/diaspora-perspectieven.',
    subtype: ['non-profit', 'cultureel-maatschappelijk', 'dekoloniaal', 'project-space'],
  },
  {
    id: 'paktamsterdam',
    description:
      'Non-profit, artist-run project-space in Oost (sinds 2002), gewijd aan solo-presentaties van opkomende kunstenaars uit Nederland en daarbuiten. Lange productie-trajecten met inhoudelijke begeleiding; belangrijke springplank voor jonge makers.',
    subtype: ['artist-run', 'project-space', 'non-profit', 'jonge-kunst'],
  },
  {
    id: 'projectspace-38-40',
    description:
      'Artist-run project-space in Noord (Distelweg) gewijd aan experimentele installatie- en performance-praktijken van opkomende kunstenaars. Klein, eigenzinnig programma buiten het galerie-circuit.',
    subtype: ['project-space', 'artist-run', 'experimenteel', 'installatie'],
  },
  {
    id: 'rozenstraat',
    description:
      'Non-profit project-space in de Jordaan in de voormalige Stedelijk-filiaalruimte (SMBA). Curatorial-driven programma rond hedendaagse kunst, vaak met een experimenteel of discursief randje.',
    subtype: ['project-space', 'non-profit', 'experimenteel', 'conceptueel'],
  },
  {
    id: 'rutger-brandt-gallery',
    description:
      'Commerciële galerie met focus op hedendaagse Nederlandse en internationale schilderkunst en werken op papier. Werkt met midcareer kunstenaars en is actief op binnen- en buitenlandse beurzen. TODO: beperkte openbare info beschikbaar.',
    subtype: ['commercieel', 'schilderkunst', 'midcareer'],
  },
  {
    id: 'slewe-gallery',
    description:
      'Commerciële galerie aan de Kerkstraat met specialisatie in geometrische en abstracte hedendaagse kunst — schilderkunst, beeldhouwkunst en werken op papier. Werkt met namen als Steven Aalders, Michael Jacklin en Tomma Abts.',
    subtype: ['commercieel', 'schilderkunst', 'conceptueel', 'midcareer'],
  },
  {
    id: 'stigter-van-doesburg',
    description:
      'Toonaangevende galerie aan de Elandsstraat (sinds 2005, voortgekomen uit Galerie Paul Andriesse). Internationaal programma met conceptueel en fotografisch werk van onder anderen Anya Gallaccio, Mathilde ter Heijne en Erik van Lieshout; geeft eigen magazine ARTICHOKE uit.',
    subtype: ['commercieel', 'conceptueel', 'fotografie', 'internationaal'],
  },
  {
    id: 'torch-gallery',
    description:
      'Galerie van wijlen Adriaan van der Have, sinds 1984 — pionier in fotografie, video en pop-art in Nederland (Andres Serrano, Anton Corbijn, Inez & Vinoodh, Erwin Olaf). Programmeert nog steeds een lens-based en pop-georiënteerd programma.',
    subtype: ['commercieel', 'fotografie', 'bluechip', 'internationaal'],
  },
  {
    id: 'upstream-gallery',
    description:
      'Commerciële galerie sinds 2007, sinds 2017 internationaal toonaangevend in digitale kunst, generative art en crypto/NFT-werk. Programmeert pioniers als Rafaël Rozendaal, Harm van den Dorpel en Jan Robert Leegte naast traditioneler werk.',
    subtype: ['commercieel', 'nieuwe-media', 'experimenteel', 'internationaal'],
  },
  {
    id: 'w139',
    description:
      'Iconische artist-run kunstruimte in de Warmoesstraat sinds 1979 — een van de oudste van Nederland. Grote, ruwe presentatieruimte met experimenteel programma van overwegend recent afgestudeerde en mid-career kunstenaars; sterk performance- en installatie-georiënteerd.',
    subtype: ['artist-run', 'non-profit', 'experimenteel', 'jonge-kunst'],
  },
  {
    id: 'aa-zone-2-source',
    description:
      'Sinds 2013 een laboratorium voor kunst en ecologie in het Amstelpark (Zuid), verspreid over paviljoens en kunstenaarstuinen. Programmeert tentoonstellingen, residenties, performances en expedities rond de relatie tussen natuur en cultuur.',
    subtype: ['non-profit', 'project-space', 'experimenteel', 'residentie'],
  },
  {
    id: 'galerie-dudokdegroot',
    description:
      'Intieme commerciële galerie aan de Bloemgracht met focus op hedendaagse Nederlandse schilderkunst en werken op papier. Klein, persoonlijk programma met midcareer kunstenaars en een trouwe verzamelaarskring.',
    subtype: ['commercieel', 'schilderkunst', 'midcareer'],
  },
  {
    id: 'm-simons',
    description:
      'Jonge commerciële galerie in het centrum, gericht op opkomende hedendaagse kunstenaars. Klein, gecureerd programma over meerdere disciplines. TODO: beperkte openbare info beschikbaar.',
    subtype: ['commercieel', 'jonge-kunst'],
  },
  {
    id: 'puntwg',
    description:
      'Artist-run project-space op het WG-terrein in West, gerund door bewoners-kunstenaars van het complex. Korte, vaak experimentele presentaties van opkomende kunstenaars; ingebed in een breder kunstenaars-collectief.',
    subtype: ['artist-run', 'project-space', 'experimenteel', 'jonge-kunst'],
  },
  {
    id: 'tegenboschvanvreden',
    description:
      'Commerciële galerie aan de Bloemgracht sinds 2009, gerund door Jan Tegenbosch en Pietje van Vreden. Conceptueel georiënteerd programma met midcareer kunstenaars als Pere Llobera, Anne Geene en Berend Strik; werkt ook met "wild walls"-muurschilderingen.',
    subtype: ['commercieel', 'conceptueel', 'midcareer'],
  },
];

let updated = 0;
let missing = 0;

for (const t of TARGETS) {
  const [v] = await db
    .select({ id: schema.venues.id, name: schema.venues.name })
    .from(schema.venues)
    .where(eq(schema.venues.id, t.id));
  if (!v) {
    console.warn(`! ${t.id} niet gevonden — overgeslagen`);
    missing++;
    continue;
  }
  await db
    .update(schema.venues)
    .set({ description: t.description, subtype: t.subtype })
    .where(eq(schema.venues.id, t.id));
  console.log(`+ ${v.id} (${v.name}) → subtype=${JSON.stringify(t.subtype)}`);
  updated++;
}

console.log(`\nKlaar. ${updated} galeries verrijkt, ${missing} niet gevonden.`);
process.exit(0);
