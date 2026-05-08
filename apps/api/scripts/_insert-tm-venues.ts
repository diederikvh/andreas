import { db, schema } from '../src/db/index.js';

type VenueInsert = typeof schema.venues.$inferInsert;

const venues: VenueInsert[] = [
  {
    id: 'johan-cruijff-arena',
    slug: 'johan-cruijff-arena',
    name: 'Johan Cruijff ArenA',
    address: 'Johan Cruijff Boulevard 1, 1101 AX Amsterdam',
    lat: 52.3142,
    lng: 4.9419,
    type: 'podium',
    scene: 'mainstream',
    capacity: 'xl',
    wijk: 'zuidoost',
    dayNight: 'night',
    categories: ['Muziek'],
    description:
      'Het stadion van Ajax met 55.000 capaciteit, sinds 1996, in 2018 hernoemd naar Johan Cruijff. Naast voetbal het podium voor de allergrootste tour-acts: Beyoncé, Coldplay, Taylor Swift, Bruce Springsteen, AC/DC en de zomerse stadion-shows. Een paar avonden per jaar — de events die je over jaren onthoudt.',
    imageUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c7/Johan_Cruijff_Arena_2.jpg/1280px-Johan_Cruijff_Arena_2.jpg',
    subtype: ['stadion', 'arena', 'tour-acts', 'pop', 'rock'],
    website: 'https://www.johancruijffarena.nl',
    instagram: 'johancruijffarena',
    published: true,
  },
  {
    id: 'boom-chicago',
    slug: 'boom-chicago',
    name: 'Boom Chicago',
    address: 'Rozengracht 117, 1016 LV Amsterdam',
    lat: 52.3742,
    lng: 4.8804,
    type: 'podium',
    scene: 'mainstream',
    capacity: 'middel',
    wijk: 'centrum',
    dayNight: 'night',
    categories: ['Theater'],
    description:
      'Engelstalige improv- en comedy-club aan de Rozengracht, sinds 1993 en al sinds jaren een bekende eerste-stap voor Amerikaanse comedy-talenten (Seth Meyers, Amber Ruffin, Jordan Peele zijn hier ooit begonnen). Programmering: improv-shows, stand-up, sketches en touring acts. Tweetalig publiek van expats en Amsterdammers met humor.',
    imageUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0e/Boom_Chicago_Rozentheater_2010.jpg/1280px-Boom_Chicago_Rozentheater_2010.jpg',
    subtype: ['comedy', 'improv', 'stand-up', 'engelstalig', 'expats'],
    website: 'https://www.boomchicago.nl',
    instagram: 'boomchicagoamsterdam',
    published: true,
  },
  {
    id: 'rai-theater',
    slug: 'rai-theater',
    name: 'RAI Theater',
    address: 'Europaplein 24, 1078 GZ Amsterdam',
    lat: 52.3413,
    lng: 4.8916,
    type: 'podium',
    scene: 'mainstream',
    capacity: 'groot',
    wijk: 'zuid',
    dayNight: 'night',
    categories: ['Muziek', 'Theater'],
    description:
      'Theaterzaal binnen het RAI-congrescentrum aan het Europaplein, gebouwd in 1969 met circa 1.750 stoelen in een klassiek-volgepakte opstelling. Programmering: musicals, comedy-grootnamen, klassieke concerten en internationale tour-acts die niet in Carré of de Stopera passen. Zakelijk maar functioneel: grote stage, royale lobbies, parking onder.',
    imageUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a4/RAI_Amsterdam.jpg/1280px-RAI_Amsterdam.jpg',
    subtype: ['theater', 'musical', 'comedy', 'klassiek', 'congres'],
    website: 'https://www.rai.nl',
    instagram: 'raiamsterdam',
    published: true,
  },
];

let inserted = 0;
let skipped = 0;
for (const v of venues) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await db.insert(schema.venues).values(v as any).onConflictDoNothing().returning();
  if (r.length > 0) {
    console.log(`  + ${v.slug}`);
    inserted++;
  } else {
    console.log(`  · ${v.slug} (bestond al)`);
    skipped++;
  }
}
console.log(`\n${inserted} nieuw, ${skipped} bestond al.`);
process.exit(0);
