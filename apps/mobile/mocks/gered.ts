import type { BadgeTone } from '@/mocks/feed';
import type { Mode } from '@/theme/tokens';

/**
 * Pre-baked "Gered" mock per mode. Mirrors the GERED object in
 * app.html. Each mode has two views:
 *   - up:   plans the user has saved that are still ahead
 *   - past: plans they already attended
 */

export type Friend = {
  name: string;
  avatar: string | null;
};

export type GeredItem = {
  id: string;
  /** Day of week ("Vr") */
  dow: string;
  num: string; // "25"
  month: string; // "APR"
  time: string;
  /** Short subline under the time, e.g. "concert" / "lezing". */
  duration: string;
  title: string;
  venue: string;
  category: string;
  tick: BadgeTone;
  friends: Friend[];
};

export type GeredView = 'up' | 'past';

export type GeredData = Record<GeredView, GeredItem[]>;

export const GERED_HEAD: Record<Mode, { sub: string; count: number; suffix: string; title: string }> = {
  nacht: {
    sub: 'Donderdag · 22 apr',
    count: 7,
    suffix: 'avonden vooruit',
    title: 'Op uit.',
  },
  dag: {
    sub: 'Zaterdag · 25 apr',
    count: 7,
    suffix: 'dagen vooruit',
    title: 'Op uit.',
  },
};

export const GERED: Record<Mode, GeredData> = {
  nacht: {
    up: [
      {
        id: 'g-n-1',
        dow: 'Vr',
        num: '25',
        month: 'APR',
        time: '23:30',
        duration: 'dubbelbill',
        title: 'Lewsberg + Personal Trainer',
        venue: 'OCCII',
        category: 'Muziek',
        tick: 'acid',
        friends: [
          { name: 'Roos', avatar: 'https://i.pravatar.cc/40?img=47' },
          { name: 'Milan', avatar: 'https://i.pravatar.cc/40?img=33' },
        ],
      },
      {
        id: 'g-n-2',
        dow: 'Vr',
        num: '25',
        month: 'APR',
        time: '23:15',
        duration: 'concert',
        title: 'Splendor Strings — Hidden Track',
        venue: 'Splendor',
        category: 'Muziek',
        tick: 'acid',
        friends: [],
      },
      {
        id: 'g-n-3',
        dow: 'Za',
        num: '26',
        month: 'APR',
        time: '21:30',
        duration: 'concert',
        title: 'Sussie — solo',
        venue: 'Paradiso kleine zaal',
        category: 'Muziek',
        tick: 'acid',
        friends: [{ name: 'Lotte', avatar: 'https://i.pravatar.cc/40?img=12' }],
      },
      {
        id: 'g-n-4',
        dow: 'Za',
        num: '26',
        month: 'APR',
        time: '23:00',
        duration: 'voorstelling',
        title: 'Nachtstuk: Ochtend van later',
        venue: 'Frascati 3',
        category: 'Theater',
        tick: 'flare',
        friends: [],
      },
      {
        id: 'g-n-5',
        dow: 'Zo',
        num: '27',
        month: 'APR',
        time: '22:30',
        duration: 'screening',
        title: 'Zondagse korte films',
        venue: 'EYE',
        category: 'Film',
        tick: 'azure',
        friends: [
          { name: 'Roos', avatar: 'https://i.pravatar.cc/40?img=47' },
          { name: 'Sam', avatar: 'https://i.pravatar.cc/40?img=59' },
          { name: 'Milan', avatar: 'https://i.pravatar.cc/40?img=33' },
        ],
      },
      {
        id: 'g-n-6',
        dow: 'Wo',
        num: '30',
        month: 'APR',
        time: '22:00',
        duration: 'lezing',
        title: 'Late Lezing: Doorwaakt',
        venue: 'Perdu',
        category: 'Literatuur',
        tick: 'plum',
        friends: [],
      },
      {
        id: 'g-n-7',
        dow: 'Vr',
        num: '02',
        month: 'MEI',
        time: '22:30',
        duration: 'dubbelfilm',
        title: 'Fassbinder dubbelprogramma',
        venue: 'Kriterion',
        category: 'Film',
        tick: 'azure',
        friends: [{ name: 'Iris', avatar: 'https://i.pravatar.cc/40?img=20' }],
      },
    ],
    past: [
      {
        id: 'g-n-p1',
        dow: 'Vr',
        num: '11',
        month: 'APR',
        time: '23:00',
        duration: 'concert',
        title: 'Future Islands — extra show',
        venue: 'Paradiso',
        category: 'Muziek',
        tick: 'acid',
        friends: [{ name: 'Roos', avatar: 'https://i.pravatar.cc/40?img=47' }],
      },
      {
        id: 'g-n-p2',
        dow: 'Do',
        num: '03',
        month: 'APR',
        time: '20:30',
        duration: 'lezing',
        title: 'Nacht van de Poëzie',
        venue: 'Perdu',
        category: 'Literatuur',
        tick: 'plum',
        friends: [],
      },
      {
        id: 'g-n-p3',
        dow: 'Zo',
        num: '23',
        month: 'MRT',
        time: '22:00',
        duration: 'screening',
        title: 'Nachtspoor: Sofia Coppola',
        venue: 'De Nieuwe Anita',
        category: 'Film',
        tick: 'azure',
        friends: [{ name: 'Milan', avatar: 'https://i.pravatar.cc/40?img=33' }],
      },
    ],
  },
  dag: {
    up: [
      {
        id: 'g-d-1',
        dow: 'Wo',
        num: '22',
        month: 'APR',
        time: '20:00',
        duration: 'lezing',
        title: 'Poëzie van de Middenmoot',
        venue: 'Perdu',
        category: 'Literatuur',
        tick: 'plum',
        friends: [{ name: 'Iris', avatar: 'https://i.pravatar.cc/40?img=20' }],
      },
      {
        id: 'g-d-2',
        dow: 'Vr',
        num: '24',
        month: 'APR',
        time: '14:00',
        duration: 'matinee',
        title: 'Matinee: Eisensteins Stakes',
        venue: 'EYE',
        category: 'Film',
        tick: 'azure',
        friends: [],
      },
      {
        id: 'g-d-3',
        dow: 'Za',
        num: '25',
        month: 'APR',
        time: '15:30',
        duration: 'kamerconcert',
        title: 'Splendor Strings: Kamerconcert',
        venue: 'Splendor',
        category: 'Muziek',
        tick: 'acid',
        friends: [
          { name: 'Roos', avatar: 'https://i.pravatar.cc/40?img=47' },
          { name: 'Milan', avatar: 'https://i.pravatar.cc/40?img=33' },
        ],
      },
      {
        id: 'g-d-4',
        dow: 'Za',
        num: '25',
        month: 'APR',
        time: '19:00',
        duration: 'voorstelling',
        title: 'Moeders op Oorlogspad',
        venue: 'Frascati 5',
        category: 'Theater',
        tick: 'flare',
        friends: [],
      },
      {
        id: 'g-d-5',
        dow: 'Zo',
        num: '26',
        month: 'APR',
        time: '16:00',
        duration: 'presentatie',
        title: 'Boekpresentatie: Rondje Noord',
        venue: 'Athenaeum',
        category: 'Literatuur',
        tick: 'plum',
        friends: [{ name: 'Sam', avatar: 'https://i.pravatar.cc/40?img=59' }],
      },
      {
        id: 'g-d-6',
        dow: 'Di',
        num: '28',
        month: 'APR',
        time: '11:00',
        duration: 'wandeling',
        title: 'Ochtendwandeling: Amsterdam Noord',
        venue: 'NDSM',
        category: 'Literatuur',
        tick: 'plum',
        friends: [],
      },
      {
        id: 'g-d-7',
        dow: 'Do',
        num: '01',
        month: 'MEI',
        time: '14:30',
        duration: 'retrospectief',
        title: 'Joris Ivens retrospective',
        venue: 'EYE',
        category: 'Film',
        tick: 'azure',
        friends: [
          { name: 'Lotte', avatar: 'https://i.pravatar.cc/40?img=12' },
          { name: 'Iris', avatar: 'https://i.pravatar.cc/40?img=20' },
        ],
      },
    ],
    past: [
      {
        id: 'g-d-p1',
        dow: 'Za',
        num: '11',
        month: 'APR',
        time: '15:00',
        duration: 'expo',
        title: 'Rijksmuseum — Vermeer late',
        venue: 'Rijksmuseum',
        category: 'Literatuur',
        tick: 'plum',
        friends: [{ name: 'Roos', avatar: 'https://i.pravatar.cc/40?img=47' }],
      },
      {
        id: 'g-d-p2',
        dow: 'Zo',
        num: '05',
        month: 'APR',
        time: '14:00',
        duration: 'matinee',
        title: 'Frascati — matinee',
        venue: 'Frascati',
        category: 'Theater',
        tick: 'flare',
        friends: [],
      },
    ],
  },
};
