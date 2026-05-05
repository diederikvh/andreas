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
    categories: ['Muziek'],
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
    categories: ['Muziek', 'Film'],
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
    categories: ['Literatuur'],
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
    categories: ['Film'],
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
    categories: ['Theater', 'Literatuur'],
  },
];

type VenueId = 'occii' | 'paradiso' | 'perdu' | 'eye' | 'frascati';
type Category = 'Muziek' | 'Theater' | 'Literatuur' | 'Film';

type SeededVenue = {
  id: VenueId;
  slug: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  imageUrl: string;
  description: string;
  categories: Category[];
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
  featured?: boolean;
};

/**
 * Hulpfuncties voor relatieve datums — seed-tijd "nu" + N dagen op
 * een specifiek uur. Re-seeden geeft altijd events "binnenkort".
 */
function dayAt(daysFromNow: number, hour: number, minute = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function plusHours(d: Date, hours: number): Date {
  const next = new Date(d);
  next.setHours(next.getHours() + hours);
  return next;
}

// Datums zijn relatief tov seed-tijd zodat de Avond-curatie (komende
// 3 dagen) en de Agenda altijd "binnenkort" content tonen na een
// re-seed. Voorvoegsel: dayAt(0) = vandaag-middernacht, +1 = morgen.
const EVT_LEWSBERG_START = dayAt(0, 21, 30);
const EVT_DE_WAKE_START = dayAt(0, 22);
const EVT_EISENSTEINS_START = dayAt(1, 14);
const EVT_SUSSIE_START = dayAt(1, 21, 30);
const EVT_FUTURE_ISLANDS_START = dayAt(2, 20, 30);
const EVT_POEZIE_MIDDENMOOT_START = dayAt(2, 20);
const EVT_DE_MEEUW_START = dayAt(2, 15);
const EVT_LATE_LEZING_START = dayAt(4, 22);
const EVT_MOSQUITO_START = dayAt(5, 22);
const EVT_MOEDERS_START = dayAt(7, 21);
const EVT_FASSBINDER_START = dayAt(9, 22, 30);

const EVENTS: SeededEvent[] = [
  {
    id: 'evt-lewsberg',
    venueId: 'occii',
    title: 'Lewsberg + Personal Trainer',
    description:
      'Dubbelconcert in de kelder. Lewsberg brengt een korte set uit het nieuwe album, Personal Trainer sluit af.',
    startsAt: EVT_LEWSBERG_START,
    endsAt: plusHours(EVT_LEWSBERG_START, 4),
    priceCents: 1200,
    ticketUrl: 'https://occii.org/event/lewsberg',
    imageUrl:
      'https://images.unsplash.com/photo-1501612780327-45045538702b?w=800&q=70&auto=format&fit=crop',
    category: 'Muziek',
    featured: true,
  },
  {
    id: 'evt-future-islands',
    venueId: 'paradiso',
    title: 'Future Islands — extra show',
    description: 'Tweede avond toegevoegd na uitverkochte eerste.',
    startsAt: EVT_FUTURE_ISLANDS_START,
    endsAt: plusHours(EVT_FUTURE_ISLANDS_START, 2.5),
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
    startsAt: EVT_POEZIE_MIDDENMOOT_START,
    endsAt: plusHours(EVT_POEZIE_MIDDENMOOT_START, 2.5),
    priceCents: 800,
    ticketUrl: null,
    imageUrl:
      'https://images.unsplash.com/photo-1506157786151-b8491531f063?w=800&q=70&auto=format&fit=crop',
    category: 'Literatuur',
    featured: true,
  },
  {
    id: 'evt-late-lezing-doorwaakt',
    venueId: 'perdu',
    title: 'Late Lezing: Doorwaakt',
    description: 'Late lezing over slaap en wakker zijn in de moderne stad.',
    startsAt: EVT_LATE_LEZING_START,
    endsAt: plusHours(EVT_LATE_LEZING_START, 2),
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
    startsAt: EVT_EISENSTEINS_START,
    endsAt: plusHours(EVT_EISENSTEINS_START, 2.5),
    priceCents: 1100,
    ticketUrl: 'https://eyefilm.nl/event/eisensteins-stakes',
    imageUrl:
      'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=800&q=70&auto=format&fit=crop',
    category: 'Film',
    featured: true,
  },
  {
    id: 'evt-mosquito',
    venueId: 'eye',
    title: 'Mosquito Screening',
    description: 'Première van Mosquito met de regisseur in zaal.',
    startsAt: EVT_MOSQUITO_START,
    endsAt: plusHours(EVT_MOSQUITO_START, 2.5),
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
    startsAt: EVT_DE_WAKE_START,
    endsAt: plusHours(EVT_DE_WAKE_START, 2),
    priceCents: 1450,
    ticketUrl: 'https://frascati.nl/event/de-wake',
    imageUrl:
      'https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=800&q=70&auto=format&fit=crop',
    category: 'Theater',
    featured: true,
  },
  {
    id: 'evt-moeders-oorlogspad',
    venueId: 'frascati',
    title: 'Moeders op Oorlogspad',
    description: 'Première van het nieuwe stuk van Wouter Snip in Frascati 5.',
    startsAt: EVT_MOEDERS_START,
    endsAt: plusHours(EVT_MOEDERS_START, 2),
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
    startsAt: EVT_SUSSIE_START,
    endsAt: plusHours(EVT_SUSSIE_START, 2.5),
    priceCents: 2100,
    ticketUrl: 'https://paradiso.nl/event/sussie-solo',
    imageUrl:
      'https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?w=800&q=70&auto=format&fit=crop',
    category: 'Muziek',
  },
  {
    id: 'evt-de-meeuw',
    venueId: 'frascati',
    title: 'Matinee: De Meeuw',
    description:
      'Tsjechov in de kleine zaal. Geen pauze, dan koffie en stilte. Geregisseerd door Eline van Houten.',
    startsAt: EVT_DE_MEEUW_START,
    endsAt: plusHours(EVT_DE_MEEUW_START, 2.5),
    priceCents: 1650,
    ticketUrl: 'https://frascati.nl/event/de-meeuw',
    imageUrl:
      'https://images.unsplash.com/photo-1503095396549-807759245b35?w=800&q=70&auto=format&fit=crop',
    category: 'Theater',
    featured: true,
  },
  {
    id: 'evt-fassbinder',
    venueId: 'eye',
    title: 'Fassbinder dubbelprogramma',
    description: 'Twee Fassbinders op één avond — Angst essen Seele auf + In a Year of 13 Moons.',
    startsAt: EVT_FASSBINDER_START,
    endsAt: plusHours(EVT_FASSBINDER_START, 4),
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
// Seed events + één occurrence per event (de seed-data is single-show
// per event). Echte multi-occurrence content komt via admin of ingest.
await db.insert(schema.events).values(
  EVENTS.map((e) => ({
    id: e.id,
    venueId: e.venueId,
    title: e.title,
    description: e.description,
    kind: 'show' as const,
    imageUrl: e.imageUrl,
    category: e.category,
    featured: e.featured ?? false,
  }))
);
await db.insert(schema.occurrences).values(
  EVENTS.map((e) => ({
    id: `occ-${e.id}`,
    eventId: e.id,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    priceCents: e.priceCents,
    ticketUrl: e.ticketUrl,
    status: 'scheduled' as const,
  }))
);

console.log(`Seeded ${VENUES.length} venues and ${EVENTS.length} events.`);
