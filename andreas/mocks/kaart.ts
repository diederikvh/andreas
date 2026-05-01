import type { BadgeTone } from '@/mocks/feed';
import type { Friend } from '@/mocks/gered';
import type { Mode } from '@/theme/tokens';

/**
 * Kaart mock — venues + friends with real Amsterdam lat/lng so the map
 * actually orients you. The mock-app uses % positions on a fake map;
 * here we use real coords and let react-native-maps do the rest.
 */

export type KaartVenue = {
  id: string;
  title: string;
  venue: string;
  time: string;
  /** Walking minutes from the user's centre (mock value). */
  minutes: number;
  category: string;
  /** Single-letter dot label (M, T, L, F). */
  dot: string;
  tone: BadgeTone;
  lat: number;
  lng: number;
  /** Cover image for the drawer card. */
  thumb: string;
  /** Short intro shown in the drawer card. */
  intro: string;
  friends?: Friend[];
};

export type KaartFriend = {
  id: string;
  name: string;
  avatar: string;
  lat: number;
  lng: number;
};

export type KaartData = {
  /** "You" — the user's current location (centre of the map). */
  centre: { lat: number; lng: number };
  friends: KaartFriend[];
  venues: KaartVenue[];
};

const UN = 'https://images.unsplash.com';

// Centre on Amsterdam — Westermarkt-ish for nacht (city centre venues),
// Museumplein for dag (museums + matinees nearby).
export const KAART: Record<Mode, KaartData> = {
  nacht: {
    centre: { lat: 52.3702, lng: 4.8855 },
    friends: [
      {
        id: 'roos',
        name: 'Roos',
        avatar: 'https://i.pravatar.cc/48?img=47',
        lat: 52.3676,
        lng: 4.8794,
      },
      {
        id: 'milan',
        name: 'Milan',
        avatar: 'https://i.pravatar.cc/48?img=33',
        lat: 52.3598,
        lng: 4.8920,
      },
      {
        id: 'lotte',
        name: 'Lotte',
        avatar: 'https://i.pravatar.cc/48?img=12',
        lat: 52.3782,
        lng: 4.8945,
      },
    ],
    venues: [
      {
        id: 'k-n-1',
        title: 'Lewsberg + Personal Trainer',
        venue: 'OCCII',
        time: '23:30',
        minutes: 12,
        category: 'Muziek',
        dot: 'M',
        tone: 'acid',
        lat: 52.3461,
        lng: 4.8602,
        thumb: `${UN}/photo-1470229722913-7c0e2dbbafd3?w=400&q=60&auto=format&fit=crop`,
        intro:
          'Dubbelconcert in de kelder van OCCII. Korte set uit het nieuwe album, daarna een set die volgens hen zelf "absurd" wordt.',
        friends: [
          { name: 'Roos', avatar: 'https://i.pravatar.cc/40?img=47' },
          { name: 'Milan', avatar: 'https://i.pravatar.cc/40?img=33' },
        ],
      },
      {
        id: 'k-n-2',
        title: 'Jazz Late Session',
        venue: 'Paradiso Noir',
        time: '23:00',
        minutes: 7,
        category: 'Muziek',
        dot: 'M',
        tone: 'acid',
        lat: 52.3623,
        lng: 4.8845,
        thumb: `${UN}/photo-1415201364774-f6f0bb35f28f?w=400&q=60&auto=format&fit=crop`,
        intro:
          'Vier jonge spelers, één set uit het hoofd. Late deuren, korte avond.',
      },
      {
        id: 'k-n-3',
        title: 'DJ Nachtwacht',
        venue: 'De Nieuwe Anita',
        time: '00:00',
        minutes: 9,
        category: 'Muziek',
        dot: 'M',
        tone: 'acid',
        lat: 52.3782,
        lng: 4.8810,
        thumb: `${UN}/photo-1459749411175-04bf5292ceea?w=400&q=60&auto=format&fit=crop`,
        intro:
          'Doorlopende set, geen line-up, geen klok. Wel de oude vloer.',
        friends: [
          { name: 'Lotte', avatar: 'https://i.pravatar.cc/40?img=12' },
        ],
      },
      {
        id: 'k-n-4',
        title: 'Open Mic Nacht',
        venue: 'Perdu',
        time: '22:30',
        minutes: 14,
        category: 'Literatuur',
        dot: 'L',
        tone: 'plum',
        lat: 52.3669,
        lng: 4.8860,
        thumb: `${UN}/photo-1485579149621-3123dd979885?w=400&q=60&auto=format&fit=crop`,
        intro:
          'Iedereen mag drie minuten. Daarna is er bier en blijft het lang stil.',
      },
      {
        id: 'k-n-5',
        title: 'Vertel-avond',
        venue: 'Mezrab',
        time: '22:00',
        minutes: 18,
        category: 'Literatuur',
        dot: 'L',
        tone: 'plum',
        lat: 52.3712,
        lng: 4.9133,
        thumb: `${UN}/photo-1519682577862-22b62b24e493?w=400&q=60&auto=format&fit=crop`,
        intro:
          'Verhalen rondom een vuur, alleen geen vuur. Stoere tegelvloer.',
      },
      {
        id: 'k-n-6',
        title: 'Midnight Movie',
        venue: 'Kriterion',
        time: '23:45',
        minutes: 11,
        category: 'Film',
        dot: 'F',
        tone: 'azure',
        lat: 52.3593,
        lng: 4.9078,
        thumb: `${UN}/photo-1489599849927-2ee91cede3ba?w=400&q=60&auto=format&fit=crop`,
        intro:
          'Een 35mm-print van iets dat je nooit zou kiezen, maar wel mooi vindt.',
        friends: [
          { name: 'Iris', avatar: 'https://i.pravatar.cc/40?img=20' },
          { name: 'Sam', avatar: 'https://i.pravatar.cc/40?img=59' },
        ],
      },
      {
        id: 'k-n-7',
        title: 'Late Night Cabaret',
        venue: 'Frascati',
        time: '22:15',
        minutes: 6,
        category: 'Theater',
        dot: 'T',
        tone: 'flare',
        lat: 52.3711,
        lng: 4.8923,
        thumb: `${UN}/photo-1503095396549-807759245b35?w=400&q=60&auto=format&fit=crop`,
        intro:
          'Drie acts, één pianist en een houten vloer die nog kraakt.',
      },
      {
        id: 'k-n-8',
        title: 'Laat arthouse',
        venue: 'Rialto',
        time: '22:00',
        minutes: 15,
        category: 'Film',
        dot: 'F',
        tone: 'azure',
        lat: 52.3582,
        lng: 4.8923,
        thumb: `${UN}/photo-1478720568477-152d9b164e26?w=400&q=60&auto=format&fit=crop`,
        intro:
          'Stille film, ondertitels in twee talen, café open tot na de aftiteling.',
      },
    ],
  },
  dag: {
    centre: { lat: 52.3580, lng: 4.8810 },
    friends: [
      {
        id: 'jonas',
        name: 'Jonas',
        avatar: 'https://i.pravatar.cc/48?img=24',
        lat: 52.3635,
        lng: 4.8870,
      },
      {
        id: 'anouk',
        name: 'Anouk',
        avatar: 'https://i.pravatar.cc/48?img=5',
        lat: 52.3540,
        lng: 4.8840,
      },
    ],
    venues: [
      {
        id: 'k-d-1',
        title: 'Jordaan boekenwandeling',
        venue: 'Noordermarkt',
        time: '10:00',
        minutes: 5,
        category: 'Literatuur',
        dot: 'L',
        tone: 'plum',
        lat: 52.3779,
        lng: 4.8853,
        thumb: `${UN}/photo-1517457373958-b7bdd4587205?w=400&q=60&auto=format&fit=crop`,
        intro:
          'Drie boekhandels, één gids, en koffie tussen de stops door.',
        friends: [
          { name: 'Roos', avatar: 'https://i.pravatar.cc/40?img=47' },
        ],
      },
      {
        id: 'k-d-2',
        title: 'Klassieke matinee',
        venue: 'Café de Jaren',
        time: '11:30',
        minutes: 8,
        category: 'Muziek',
        dot: 'M',
        tone: 'acid',
        lat: 52.3678,
        lng: 4.8967,
        thumb: `${UN}/photo-1507838153414-b4b713384a76?w=400&q=60&auto=format&fit=crop`,
        intro:
          'Een strijktrio op de eerste verdieping. Brunch valt erbij weg.',
      },
      {
        id: 'k-d-3',
        title: 'Fotografie · Deep Storage',
        venue: 'Foam',
        time: '10:30',
        minutes: 9,
        category: 'Literatuur',
        dot: 'L',
        tone: 'plum',
        lat: 52.3625,
        lng: 4.8918,
        thumb: `${UN}/photo-1472289065668-ce650ac443d2?w=400&q=60&auto=format&fit=crop`,
        intro:
          'Archiefwerk uit drie continenten, deels nooit eerder getoond.',
      },
      {
        id: 'k-d-4',
        title: 'Zondagsbrunch live',
        venue: 'Noorderkerk',
        time: '11:00',
        minutes: 11,
        category: 'Muziek',
        dot: 'M',
        tone: 'acid',
        lat: 52.3786,
        lng: 4.8847,
        thumb: `${UN}/photo-1506157786151-b8491531f063?w=400&q=60&auto=format&fit=crop`,
        intro:
          'Vier muzikanten, een organist en koffie in plastic bekers.',
        friends: [
          { name: 'Lotte', avatar: 'https://i.pravatar.cc/40?img=12' },
          { name: 'Iris', avatar: 'https://i.pravatar.cc/40?img=20' },
        ],
      },
      {
        id: 'k-d-5',
        title: 'Boeklancering',
        venue: 'Perdu',
        time: '15:00',
        minutes: 12,
        category: 'Literatuur',
        dot: 'L',
        tone: 'plum',
        lat: 52.3669,
        lng: 4.8860,
        thumb: `${UN}/photo-1519682577862-22b62b24e493?w=400&q=60&auto=format&fit=crop`,
        intro:
          'Eerste presentatie, kort gesprek, signeerrij die rond Perdu draait.',
      },
      {
        id: 'k-d-6',
        title: 'Zondagmatinee',
        venue: 'Kriterion',
        time: '14:30',
        minutes: 14,
        category: 'Film',
        dot: 'F',
        tone: 'azure',
        lat: 52.3593,
        lng: 4.9078,
        thumb: `${UN}/photo-1489599849927-2ee91cede3ba?w=400&q=60&auto=format&fit=crop`,
        intro:
          'Twee korte films, één Q&A, en daarna café in de zon.',
        friends: [
          { name: 'Sam', avatar: 'https://i.pravatar.cc/40?img=59' },
        ],
      },
      {
        id: 'k-d-7',
        title: 'Documentaire-programma',
        venue: 'Oosterpark',
        time: '13:00',
        minutes: 20,
        category: 'Film',
        dot: 'F',
        tone: 'azure',
        lat: 52.3578,
        lng: 4.9233,
        thumb: `${UN}/photo-1478720568477-152d9b164e26?w=400&q=60&auto=format&fit=crop`,
        intro:
          'Openluchtprojectie, drie korte films, deken meenemen.',
      },
      {
        id: 'k-d-8',
        title: 'Expo-rondleiding',
        venue: 'Stedelijk',
        time: '13:30',
        minutes: 17,
        category: 'Theater',
        dot: 'T',
        tone: 'flare',
        lat: 52.3582,
        lng: 4.8807,
        thumb: `${UN}/photo-1503095396549-807759245b35?w=400&q=60&auto=format&fit=crop`,
        intro:
          'Conservator loopt mee, vier zalen, één dwarsverband.',
      },
      {
        id: 'k-d-9',
        title: 'Matinee · De Meeuw',
        venue: 'Frascati',
        time: '15:00',
        minutes: 6,
        category: 'Theater',
        dot: 'T',
        tone: 'flare',
        lat: 52.3711,
        lng: 4.8923,
        thumb: `${UN}/photo-1533174072545-7a4b6ad7a6c3?w=400&q=60&auto=format&fit=crop`,
        intro:
          'Tsjechov in de kleine zaal. Geen pauze, dan koffie en stilte.',
      },
    ],
  },
};
