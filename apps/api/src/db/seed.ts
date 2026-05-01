import { db, schema } from './index.js';

/**
 * Idempotent seed for V1. Truncates the curated tables and re-inserts
 * a small set of Amsterdam venues + events so the app has data to
 * render against during development.
 *
 * Users / friendships / saves blijven leeg — die vullen we via de auth
 * + save-flows zodra die echt door de DB heen gaan.
 */

const VENUES: SeededVenue[] = [
  {
    id: 'occii',
    slug: 'occii',
    name: 'OCCII',
    address: 'Amstelveenseweg 134, Amsterdam',
    lat: 52.3499,
    lng: 4.865,
    imageUrl:
      'https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?w=600&q=70&auto=format&fit=crop',
    description:
      'Ongesubsidieerde concertkelder in zuid. Klein podium, scherp programma — punk, drone, experimentele elektronica.',
  },
  {
    id: 'paradiso',
    slug: 'paradiso',
    name: 'Paradiso',
    address: 'Weteringschans 6-8, Amsterdam',
    lat: 52.3622,
    lng: 4.8836,
    imageUrl:
      'https://images.unsplash.com/photo-1501386761578-eac5c94b800a?w=600&q=70&auto=format&fit=crop',
    description: 'De pop-tempel in een oud kerkgebouw aan de Weteringschans.',
  },
  {
    id: 'perdu',
    slug: 'perdu',
    name: 'Perdu',
    address: 'Kloveniersburgwal 86, Amsterdam',
    lat: 52.3713,
    lng: 4.8989,
    imageUrl:
      'https://images.unsplash.com/photo-1485579149621-3123dd979885?w=600&q=70&auto=format&fit=crop',
    description: 'Podium voor poëzie, essay en literaire lezingen.',
  },
  {
    id: 'eye',
    slug: 'eye',
    name: 'EYE Filmmuseum',
    address: 'IJpromenade 1, Amsterdam',
    lat: 52.3838,
    lng: 4.9019,
    imageUrl:
      'https://images.unsplash.com/photo-1478720568477-152d9b164e26?w=600&q=70&auto=format&fit=crop',
    description: 'Filmhuis aan het IJ — retrospectives, premières, matinees.',
  },
  {
    id: 'frascati',
    slug: 'frascati',
    name: 'Frascati',
    address: 'Nes 63, Amsterdam',
    lat: 52.3711,
    lng: 4.895,
    imageUrl:
      'https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=600&q=70&auto=format&fit=crop',
    description: 'Theaterhuis in de Nes met vier zalen — voorstelling tot late nacht.',
  },
];

type VenueId = 'occii' | 'paradiso' | 'perdu' | 'eye' | 'frascati';

type SeededVenue = {
  id: VenueId;
  slug: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  imageUrl: string;
  description: string;
};

type SeededEvent = {
  id: string;
  venueId: VenueId;
  title: string;
  description: string;
  startsAt: Date;
  endsAt: Date | null;
  priceCents: number | null;
  ticketUrl: string | null;
  imageUrl: string;
  category: 'Muziek' | 'Theater' | 'Literatuur' | 'Film';
};

const EVENTS: SeededEvent[] = [
  {
    id: 'evt-lewsberg',
    venueId: 'occii',
    title: 'Lewsberg + Personal Trainer',
    description:
      'Dubbelconcert in de kelder. Lewsberg brengt een korte set uit het nieuwe album, Personal Trainer sluit af.',
    startsAt: new Date('2026-05-08T21:30:00+02:00'),
    endsAt: new Date('2026-05-09T01:30:00+02:00'),
    priceCents: 1200,
    ticketUrl: 'https://occii.org/event/lewsberg',
    imageUrl:
      'https://images.unsplash.com/photo-1501612780327-45045538702b?w=800&q=70&auto=format&fit=crop',
    category: 'Muziek',
  },
  {
    id: 'evt-future-islands',
    venueId: 'paradiso',
    title: 'Future Islands — extra show',
    description: 'Tweede avond toegevoegd na uitverkochte eerste.',
    startsAt: new Date('2026-05-10T20:30:00+02:00'),
    endsAt: new Date('2026-05-10T23:00:00+02:00'),
    priceCents: 3250,
    ticketUrl: 'https://paradiso.nl/event/future-islands-2',
    imageUrl:
      'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=800&q=70&auto=format&fit=crop',
    category: 'Muziek',
  },
  {
    id: 'evt-poezie-middenmoot',
    venueId: 'perdu',
    title: 'Poëzie van de Middenmoot',
    description:
      'Open mic-avond met dichters die "bijna" maar net niet in de canon staan. Maria Barnas presenteert.',
    startsAt: new Date('2026-05-11T20:00:00+02:00'),
    endsAt: new Date('2026-05-11T22:30:00+02:00'),
    priceCents: 800,
    ticketUrl: null,
    imageUrl:
      'https://images.unsplash.com/photo-1506157786151-b8491531f063?w=800&q=70&auto=format&fit=crop',
    category: 'Literatuur',
  },
  {
    id: 'evt-late-lezing-doorwaakt',
    venueId: 'perdu',
    title: 'Late Lezing: Doorwaakt',
    description: 'Late lezing over slaap en wakker zijn in de moderne stad.',
    startsAt: new Date('2026-05-12T22:00:00+02:00'),
    endsAt: new Date('2026-05-13T00:00:00+02:00'),
    priceCents: 700,
    ticketUrl: null,
    imageUrl:
      'https://images.unsplash.com/photo-1485579149621-3123dd979885?w=800&q=70&auto=format&fit=crop',
    category: 'Literatuur',
  },
  {
    id: 'evt-eisensteins-stakes',
    venueId: 'eye',
    title: 'Matinee: Eisensteins Stakes',
    description: 'Restored print, met inleiding van filmhistorica Tessa van Wijck.',
    startsAt: new Date('2026-05-09T14:00:00+02:00'),
    endsAt: new Date('2026-05-09T16:30:00+02:00'),
    priceCents: 1100,
    ticketUrl: 'https://eyefilm.nl/event/eisensteins-stakes',
    imageUrl:
      'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=800&q=70&auto=format&fit=crop',
    category: 'Film',
  },
  {
    id: 'evt-mosquito',
    venueId: 'eye',
    title: 'Mosquito Screening',
    description: 'Première van Mosquito met de regisseur in zaal.',
    startsAt: new Date('2026-05-13T22:00:00+02:00'),
    endsAt: new Date('2026-05-14T00:30:00+02:00'),
    priceCents: 1400,
    ticketUrl: null,
    imageUrl:
      'https://images.unsplash.com/photo-1518609878373-06d740f60d8b?w=800&q=70&auto=format&fit=crop',
    category: 'Film',
  },
  {
    id: 'evt-de-wake',
    venueId: 'frascati',
    title: 'Nachttheater: De Wake',
    description:
      'Een twee-uurs voorstelling over een familie die een kind kwijt is. In Frascati 4.',
    startsAt: new Date('2026-05-08T22:00:00+02:00'),
    endsAt: new Date('2026-05-09T00:00:00+02:00'),
    priceCents: 1450,
    ticketUrl: 'https://frascati.nl/event/de-wake',
    imageUrl:
      'https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=800&q=70&auto=format&fit=crop',
    category: 'Theater',
  },
  {
    id: 'evt-moeders-oorlogspad',
    venueId: 'frascati',
    title: 'Moeders op Oorlogspad',
    description: 'Première van het nieuwe stuk van Wouter Snip in Frascati 5.',
    startsAt: new Date('2026-05-15T21:00:00+02:00'),
    endsAt: new Date('2026-05-15T23:00:00+02:00'),
    priceCents: 1850,
    ticketUrl: 'https://frascati.nl/event/moeders-oorlogspad',
    imageUrl:
      'https://images.unsplash.com/photo-1518609878373-06d740f60d8b?w=800&q=70&auto=format&fit=crop',
    category: 'Theater',
  },
  {
    id: 'evt-sussie-solo',
    venueId: 'paradiso',
    title: 'Sussie — solo',
    description: 'Sussie speelt nieuw materiaal in de kleine zaal.',
    startsAt: new Date('2026-05-09T21:30:00+02:00'),
    endsAt: new Date('2026-05-10T00:00:00+02:00'),
    priceCents: 2100,
    ticketUrl: 'https://paradiso.nl/event/sussie-solo',
    imageUrl:
      'https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?w=800&q=70&auto=format&fit=crop',
    category: 'Muziek',
  },
  {
    id: 'evt-fassbinder',
    venueId: 'eye',
    title: 'Fassbinder dubbelprogramma',
    description: 'Twee Fassbinders op één avond — Angst essen Seele auf + In a Year of 13 Moons.',
    startsAt: new Date('2026-05-16T22:30:00+02:00'),
    endsAt: new Date('2026-05-17T02:30:00+02:00'),
    priceCents: 1200,
    ticketUrl: null,
    imageUrl:
      'https://images.unsplash.com/photo-1478720568477-152d9b164e26?w=800&q=70&auto=format&fit=crop',
    category: 'Film',
  },
];

await db.delete(schema.events);
await db.delete(schema.venues);

await db.insert(schema.venues).values(VENUES);
await db.insert(schema.events).values(EVENTS);

console.log(`Seeded ${VENUES.length} venues and ${EVENTS.length} events.`);
