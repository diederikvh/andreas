import type { Friend } from '@/mocks/gered';
import type { Mode } from '@/theme/tokens';

/**
 * Pre-baked mock data for the Avond/Feed screen. Mirrors the COPY +
 * EVENTS objects in app.html so the static screen reads the same in
 * RN as in the design canvas.
 *
 * Real data lands in fase 4 (Neon + Drizzle); the screen will switch
 * its data-source then, not its layout.
 */

export type BadgeTone = 'acid' | 'flare' | 'plum' | 'azure';

export type EventRow = {
  id: string;
  title: string;
  /** Pre-formatted meta line, dots already inserted. */
  meta: string;
  badge: string;
  badgeTone: BadgeTone;
  thumb: string;
  /** Optional friends already saved to this event. */
  friends?: Friend[];
};

export type PhotoCard = {
  id: string;
  kicker: string;
  title: string;
  photo: string;
};

export type FeedData = {
  hero: {
    kicker: string;
    /** Hero title is split so the middle word renders in the brand serif. */
    titleBefore: string;
    titleEm: string;
    titleAfter: string;
  };
  featured: {
    kicker: string;
    title: string;
    meta: string;
    photo: string;
  };
  smallRooms: {
    sectionTitle: string;
    sectionMeta: string;
    events: EventRow[];
  };
  photoBand: {
    sectionTitle: string;
    sectionMeta: string;
    cards: PhotoCard[];
  };
};

export const FEED: Record<Mode, FeedData> = {
  nacht: {
    hero: {
      kicker: 'Donderdagavond · 22 apr',
      titleBefore: '47 dingen\ndie ',
      titleEm: 'nu',
      titleAfter: ' tellen.',
    },
    featured: {
      kicker: '— Avondkeuze',
      title: 'Lewsberg\nlive',
      meta: 'OCCII · 23:30 · €12 · nog 3 kaarten',
      photo:
        'https://images.unsplash.com/photo-1501386761578-eac5c94b800a?w=800&q=70&auto=format&fit=crop',
    },
    smallRooms: {
      sectionTitle: 'Laat open',
      sectionMeta: '5 plekken na 23:00',
      events: [
        {
          id: 'n1',
          title: 'Lewsberg + Personal Trainer',
          meta: 'VR · 23:30 · OCCII · €12',
          badge: 'Muziek',
          badgeTone: 'acid',
          thumb:
            'https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?w=200&q=60&auto=format&fit=crop',
          friends: [
            { name: 'Roos', avatar: 'https://i.pravatar.cc/40?img=47' },
            { name: 'Milan', avatar: 'https://i.pravatar.cc/40?img=33' },
          ],
        },
        {
          id: 'n2',
          title: 'Nachttheater: De Wake',
          meta: 'DO · 22:00 · FRASCATI 4 · €14',
          badge: 'Theater',
          badgeTone: 'flare',
          thumb:
            'https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=200&q=60&auto=format&fit=crop',
        },
        {
          id: 'n3',
          title: 'Late Lezing: Doorwaakt',
          meta: 'VR · 23:00 · PERDU · €7',
          badge: 'Literatuur',
          badgeTone: 'plum',
          thumb:
            'https://images.unsplash.com/photo-1485579149621-3123dd979885?w=200&q=60&auto=format&fit=crop',
        },
        {
          id: 'n4',
          title: 'Mosquito Screening',
          meta: 'DO · 22:00 · DE NIEUWE ANITA · €7',
          badge: 'Film',
          badgeTone: 'azure',
          thumb:
            'https://images.unsplash.com/photo-1478720568477-152d9b164e26?w=200&q=60&auto=format&fit=crop',
          friends: [{ name: 'Iris', avatar: 'https://i.pravatar.cc/40?img=20' }],
        },
        {
          id: 'n5',
          title: 'Splendor Strings — Hidden Track',
          meta: 'ZA · 00:30 · SPLENDOR · €15',
          badge: 'Muziek',
          badgeTone: 'acid',
          thumb:
            'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=200&q=60&auto=format&fit=crop',
        },
      ],
    },
    photoBand: {
      sectionTitle: 'Na middernacht',
      sectionMeta: 'foto dump',
      cards: [
        {
          id: 'pb-n1',
          kicker: 'Poëzie · open mic',
          title: 'Middenmoot\navond',
          photo:
            'https://images.unsplash.com/photo-1506157786151-b8491531f063?w=400&q=60&auto=format&fit=crop',
        },
        {
          id: 'pb-n2',
          kicker: 'Film · Nieuwe Anita',
          title: 'Mosquito\nscreening',
          photo:
            'https://images.unsplash.com/photo-1518609878373-06d740f60d8b?w=400&q=60&auto=format&fit=crop',
        },
      ],
    },
  },
  dag: {
    hero: {
      kicker: 'Zaterdagochtend · 25 apr',
      titleBefore: '47 dingen\nom ',
      titleEm: 'aan',
      titleAfter: ' te denken.',
    },
    featured: {
      kicker: '— Zaterdagkeuze',
      title: 'Poëzie van\nde Middenmoot',
      meta: 'PERDU · 20:00 · €8 · Maria Barnas',
      photo:
        'https://images.unsplash.com/photo-1513475382585-d06e58bcb0e0?w=800&q=70&auto=format&fit=crop',
    },
    smallRooms: {
      sectionTitle: 'Om op te plannen',
      sectionMeta: '8 voor dit weekend',
      events: [
        {
          id: 'd1',
          title: 'Poëzie van de Middenmoot',
          meta: 'WO · 20:00 · PERDU · €8',
          badge: 'Literatuur',
          badgeTone: 'acid',
          thumb:
            'https://images.unsplash.com/photo-1506157786151-b8491531f063?w=200&q=60&auto=format&fit=crop',
        },
        {
          id: 'd2',
          title: 'Moeders op Oorlogspad',
          meta: 'VR · 21:00 · FRASCATI 5 · €18,50',
          badge: 'Theater',
          badgeTone: 'flare',
          thumb:
            'https://images.unsplash.com/photo-1518609878373-06d740f60d8b?w=200&q=60&auto=format&fit=crop',
          friends: [
            { name: 'Sam', avatar: 'https://i.pravatar.cc/40?img=59' },
            { name: 'Roos', avatar: 'https://i.pravatar.cc/40?img=47' },
          ],
        },
        {
          id: 'd3',
          title: 'Matinee: Eisensteins Stakes',
          meta: 'ZA · 14:00 · EYE · €11',
          badge: 'Film',
          badgeTone: 'plum',
          thumb:
            'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=200&q=60&auto=format&fit=crop',
        },
        {
          id: 'd4',
          title: 'Boekpresentatie: Rondje Noord',
          meta: 'ZO · 16:00 · ATHENAEUM · gratis',
          badge: 'Literatuur',
          badgeTone: 'azure',
          thumb:
            'https://images.unsplash.com/photo-1517457373958-b7bdd4587205?w=200&q=60&auto=format&fit=crop',
          friends: [{ name: 'Lotte', avatar: 'https://i.pravatar.cc/40?img=12' }],
        },
        {
          id: 'd5',
          title: 'Splendor Strings: Kamerconcert',
          meta: 'ZA · 15:30 · SPLENDOR · €15',
          badge: 'Muziek',
          badgeTone: 'acid',
          thumb:
            'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=200&q=60&auto=format&fit=crop',
        },
      ],
    },
    photoBand: {
      sectionTitle: 'Zaterdag vooruit',
      sectionMeta: 'foto dump',
      cards: [
        {
          id: 'pb-d1',
          kicker: 'Brunch · jazz',
          title: 'Sunday\nstrings',
          photo:
            'https://images.unsplash.com/photo-1506157786151-b8491531f063?w=400&q=60&auto=format&fit=crop',
        },
        {
          id: 'pb-d2',
          kicker: 'EYE · matinee',
          title: 'Eisensteins\nStakes',
          photo:
            'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=400&q=60&auto=format&fit=crop',
        },
      ],
    },
  },
};
