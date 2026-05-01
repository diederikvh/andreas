import type { Mode } from '@/theme/tokens';

/**
 * Pre-baked detail-screen mock per mode. Mirrors the COPY['nacht']/'dag'
 * d-* fields in app.html. Until fase 4 wires real data, every event tap
 * lands on the same per-mode mock.
 */

export type LineupItem = { name: string; time: string };

export type DetailData = {
  tag: string;
  title: string;
  date: string;
  time: string;
  venue: string;
  description: string;
  photo: string;
  photoStrip: string[];
  lineup: LineupItem[];
  friends: {
    avatars: string[];
    /** Pre-formatted line, names already bolded by the screen. */
    names: string[];
    suffix: string;
  };
  price: string;
  priceNote: string;
};

export const DETAIL: Record<Mode, DetailData> = {
  nacht: {
    tag: 'Muziek · post-punk',
    title: 'Lewsberg\n+ Personal\nTrainer',
    date: 'Vr 25.04',
    time: '23:30',
    venue: 'OCCII',
    description:
      "Dubbelconcert in de kelder van de OCCII. Lewsberg brengt een korte set uit het nieuwe album, Personal Trainer sluit af met een set die volgens hen zelf 'absurd' wordt.",
    photo:
      'https://images.unsplash.com/photo-1501612780327-45045538702b?w=800&q=70&auto=format&fit=crop',
    photoStrip: [
      'https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?w=200&q=60&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=200&q=60&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1429962714451-bb934ecdc4ec?w=200&q=60&auto=format&fit=crop',
    ],
    lineup: [
      { name: 'Personal Trainer', time: '01:00' },
      { name: 'Lewsberg', time: '23:30' },
      { name: 'DJ Nachtwacht', time: '23:00 · open' },
    ],
    friends: {
      avatars: [
        'https://i.pravatar.cc/72?img=47',
        'https://i.pravatar.cc/72?img=33',
        'https://i.pravatar.cc/72?img=23',
      ],
      names: ['Roos', 'Milan', 'Iris'],
      suffix: 'gaan ook',
    },
    price: '€12,00',
    priceNote: 'incl. servicekosten',
  },
  dag: {
    tag: 'Literatuur · open mic',
    title: 'Poëzie van\nde Midden-\nmoot',
    date: 'Wo 22.04',
    time: '20:00',
    venue: 'Perdu',
    description:
      "Een open mic-avond in Perdu waar dichters die 'bijna' maar net niet in de canon zijn staan opgesteld naast debutanten. Maria Barnas presenteert en leest ook nieuw werk voor.",
    photo:
      'https://images.unsplash.com/photo-1519608487953-e999c86e7455?w=800&q=70&auto=format&fit=crop',
    photoStrip: [
      'https://images.unsplash.com/photo-1506157786151-b8491531f063?w=200&q=60&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1518609878373-06d740f60d8b?w=200&q=60&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=200&q=60&auto=format&fit=crop',
    ],
    lineup: [
      { name: 'Maria Barnas', time: '22:00' },
      { name: 'Open mic', time: '21:00' },
      { name: 'Deuren', time: '19:30' },
    ],
    friends: {
      avatars: [
        'https://i.pravatar.cc/72?img=12',
        'https://i.pravatar.cc/72?img=29',
        'https://i.pravatar.cc/72?img=68',
      ],
      names: ['Sanne', 'Joost', 'Eva'],
      suffix: 'gaan ook',
    },
    price: '€8,00',
    priceNote: 'incl. servicekosten',
  },
};
