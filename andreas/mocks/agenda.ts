import type { BadgeTone } from '@/mocks/feed';
import type { Friend } from '@/mocks/gered';
import type { Mode } from '@/theme/tokens';

/**
 * Pre-baked agenda data per mode. Mirrors the AGENDA object in app.html.
 * Each day has its own header (num/dow/month/count) plus a list of
 * agenda items. Until fase 4 wires real data, this is the source.
 */

export type AgendaItem = {
  id: string;
  time: string;
  duration: string;
  title: string;
  venue: string;
  /** Tag label shown next to the title, with its colour tone. */
  badge: string;
  badgeTone: BadgeTone;
  /** Side accent stripe colour. */
  tick: BadgeTone;
  thumb: string;
  /** Optional secondary tag like "Uitverkocht" / "nog 3". */
  status?: string;
  /** Friends already saved to this event. */
  friends?: Friend[];
};

export type AgendaDay = {
  id: string;
  num: string; // "24"
  dow: string; // "Do"
  month: string; // "APR"
  count: number;
  items: AgendaItem[];
};

export const AGENDA_HEAD: Record<Mode, { sub: string; total: number; title: string; titleEm: string }> = {
  nacht: {
    sub: 'April · week 17',
    total: 18,
    title: 'Nachten\n',
    titleEm: 'vooruit.',
  },
  dag: {
    sub: 'Mei · week 18',
    total: 17,
    title: 'Op\n',
    titleEm: 'uit.',
  },
};

export const AGENDA: Record<Mode, AgendaDay[]> = {
  nacht: [
    {
      id: 'n-24-04',
      num: '24',
      dow: 'Do',
      month: 'APR',
      count: 3,
      items: [
        {
          id: 'n1',
          time: '20:30',
          duration: '2u',
          title: 'Mosquito Screening',
          venue: 'De Nieuwe Anita',
          badge: 'Film',
          badgeTone: 'azure',
          tick: 'azure',
          thumb:
            'https://images.unsplash.com/photo-1478720568477-152d9b164e26?w=200&q=60&auto=format&fit=crop',
        },
        {
          id: 'n2',
          time: '22:00',
          duration: 'tot 01:00',
          title: 'Nachttheater: De Wake',
          venue: 'Frascati 4',
          badge: 'Theater',
          badgeTone: 'flare',
          tick: 'flare',
          thumb:
            'https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=200&q=60&auto=format&fit=crop',
          status: 'Uitverkocht',
        },
        {
          id: 'n3',
          time: '23:00',
          duration: 'deuren',
          title: 'Late Lezing: Doorwaakt',
          venue: 'Perdu',
          badge: 'Literatuur',
          badgeTone: 'plum',
          tick: 'plum',
          thumb:
            'https://images.unsplash.com/photo-1485579149621-3123dd979885?w=200&q=60&auto=format&fit=crop',
        },
      ],
    },
    {
      id: 'n-25-04',
      num: '25',
      dow: 'Vr',
      month: 'APR',
      count: 4,
      items: [
        {
          id: 'n4',
          time: '21:30',
          duration: 'dubbelbill',
          title: 'Lewsberg + Personal Trainer',
          venue: 'OCCII',
          badge: 'Muziek',
          badgeTone: 'acid',
          tick: 'acid',
          thumb:
            'https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?w=200&q=60&auto=format&fit=crop',
          status: 'nog 3',
          friends: [
            { name: 'Roos', avatar: 'https://i.pravatar.cc/40?img=47' },
            { name: 'Milan', avatar: 'https://i.pravatar.cc/40?img=33' },
          ],
        },
        {
          id: 'n5',
          time: '22:00',
          duration: '90 min',
          title: 'Fassbinder dubbelprogramma',
          venue: 'Kriterion',
          badge: 'Film',
          badgeTone: 'azure',
          tick: 'azure',
          thumb:
            'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=200&q=60&auto=format&fit=crop',
        },
        {
          id: 'n6',
          time: '23:15',
          duration: 'speciaal',
          title: 'Splendor Strings — Hidden Track',
          venue: 'Splendor',
          badge: 'Muziek',
          badgeTone: 'acid',
          tick: 'acid',
          thumb:
            'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=200&q=60&auto=format&fit=crop',
          friends: [
            { name: 'Iris', avatar: 'https://i.pravatar.cc/40?img=20' },
          ],
        },
        {
          id: 'n7',
          time: '00:00',
          duration: 'doorlopend',
          title: 'Nachtcafé · open floor',
          venue: 'De Nieuwe Anita',
          badge: 'Theater',
          badgeTone: 'flare',
          tick: 'flare',
          thumb:
            'https://images.unsplash.com/photo-1598387993441-a364f854c3e1?w=200&q=60&auto=format&fit=crop',
        },
      ],
    },
    {
      id: 'n-26-04',
      num: '26',
      dow: 'Za',
      month: 'APR',
      count: 3,
      items: [
        {
          id: 'n8',
          time: '21:30',
          duration: '90 min',
          title: 'Sussie — solo',
          venue: 'Paradiso kleine zaal',
          badge: 'Muziek',
          badgeTone: 'acid',
          tick: 'acid',
          thumb:
            'https://images.unsplash.com/photo-1501612780327-45045538702b?w=200&q=60&auto=format&fit=crop',
        },
        {
          id: 'n9',
          time: '23:00',
          duration: 'première',
          title: 'Nachtstuk: Ocht. van later',
          venue: 'Frascati 3',
          badge: 'Theater',
          badgeTone: 'flare',
          tick: 'flare',
          thumb:
            'https://images.unsplash.com/photo-1503095396549-807759245b35?w=200&q=60&auto=format&fit=crop',
        },
        {
          id: 'n10',
          time: '00:15',
          duration: 'laatste show',
          title: 'Nachtelijk Kabinet',
          venue: 'Frascati 3',
          badge: 'Theater',
          badgeTone: 'flare',
          tick: 'flare',
          thumb:
            'https://images.unsplash.com/photo-1533174072545-7a4b6ad7a6c3?w=200&q=60&auto=format&fit=crop',
        },
      ],
    },
    {
      id: 'n-27-04',
      num: '27',
      dow: 'Zo',
      month: 'APR',
      count: 2,
      items: [
        {
          id: 'n11',
          time: '21:00',
          duration: 'avondlezing',
          title: 'Open tafel: nachtdichters',
          venue: 'Perdu',
          badge: 'Literatuur',
          badgeTone: 'plum',
          tick: 'plum',
          thumb:
            'https://images.unsplash.com/photo-1519682577862-22b62b24e493?w=200&q=60&auto=format&fit=crop',
        },
        {
          id: 'n12',
          time: '22:30',
          duration: '60 min',
          title: 'Zondagse korte films',
          venue: 'EYE',
          badge: 'Film',
          badgeTone: 'azure',
          tick: 'azure',
          thumb:
            'https://images.unsplash.com/photo-1478720568477-152d9b164e26?w=200&q=60&auto=format&fit=crop',
          friends: [
            { name: 'Roos', avatar: 'https://i.pravatar.cc/40?img=47' },
            { name: 'Sam', avatar: 'https://i.pravatar.cc/40?img=59' },
            { name: 'Milan', avatar: 'https://i.pravatar.cc/40?img=33' },
          ],
        },
      ],
    },
    {
      id: 'n-30-04',
      num: '30',
      dow: 'Wo',
      month: 'APR',
      count: 2,
      items: [
        {
          id: 'n13',
          time: '21:00',
          duration: '2u',
          title: 'Koningsnacht op de kade',
          venue: 'Noorderkade',
          badge: 'Muziek',
          badgeTone: 'acid',
          tick: 'acid',
          thumb:
            'https://images.unsplash.com/photo-1506157786151-b8491531f063?w=200&q=60&auto=format&fit=crop',
        },
        {
          id: 'n14',
          time: '23:30',
          duration: 'afterparty',
          title: 'After · Paradiso',
          venue: 'Paradiso',
          badge: 'Muziek',
          badgeTone: 'acid',
          tick: 'acid',
          thumb:
            'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=200&q=60&auto=format&fit=crop',
        },
      ],
    },
    {
      id: 'n-02-05',
      num: '02',
      dow: 'Vr',
      month: 'MEI',
      count: 2,
      items: [
        {
          id: 'n15',
          time: '22:00',
          duration: 'pre-première',
          title: 'Film: De Stille Straat',
          venue: 'Kriterion',
          badge: 'Film',
          badgeTone: 'azure',
          tick: 'azure',
          thumb:
            'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=200&q=60&auto=format&fit=crop',
        },
        {
          id: 'n16',
          time: '23:30',
          duration: 'late',
          title: 'Jazzclub: Melodics',
          venue: 'Bimhuis',
          badge: 'Muziek',
          badgeTone: 'acid',
          tick: 'acid',
          thumb:
            'https://images.unsplash.com/photo-1415201364774-f6f0bb35f28f?w=200&q=60&auto=format&fit=crop',
        },
      ],
    },
    {
      id: 'n-03-05',
      num: '03',
      dow: 'Za',
      month: 'MEI',
      count: 2,
      items: [
        {
          id: 'n17',
          time: '21:00',
          duration: 'dansavond',
          title: 'Patta × NDSM',
          venue: 'NDSM-werf',
          badge: 'Muziek',
          badgeTone: 'acid',
          tick: 'acid',
          thumb:
            'https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?w=200&q=60&auto=format&fit=crop',
        },
        {
          id: 'n18',
          time: '23:00',
          duration: '75 min',
          title: 'Nacht-reprise: Mosquito',
          venue: 'De Nieuwe Anita',
          badge: 'Film',
          badgeTone: 'azure',
          tick: 'azure',
          thumb:
            'https://images.unsplash.com/photo-1478720568477-152d9b164e26?w=200&q=60&auto=format&fit=crop',
        },
      ],
    },
    {
      id: 'n-08-05',
      num: '08',
      dow: 'Do',
      month: 'MEI',
      count: 2,
      items: [
        {
          id: 'n19',
          time: '20:30',
          duration: '2u',
          title: 'Avondtheater: Twee Stoelen',
          venue: 'Frascati 2',
          badge: 'Theater',
          badgeTone: 'flare',
          tick: 'flare',
          thumb:
            'https://images.unsplash.com/photo-1503095396549-807759245b35?w=200&q=60&auto=format&fit=crop',
        },
        {
          id: 'n20',
          time: '22:30',
          duration: 'lezing',
          title: 'Avondlezing: Vergeten Stemmen',
          venue: 'Perdu',
          badge: 'Literatuur',
          badgeTone: 'plum',
          tick: 'plum',
          thumb:
            'https://images.unsplash.com/photo-1485579149621-3123dd979885?w=200&q=60&auto=format&fit=crop',
        },
      ],
    },
    {
      id: 'n-09-05',
      num: '09',
      dow: 'Vr',
      month: 'MEI',
      count: 3,
      items: [
        {
          id: 'n21',
          time: '21:00',
          duration: 'concert',
          title: 'Eefje de Visser',
          venue: 'Paradiso',
          badge: 'Muziek',
          badgeTone: 'acid',
          tick: 'acid',
          thumb:
            'https://images.unsplash.com/photo-1501612780327-45045538702b?w=200&q=60&auto=format&fit=crop',
          status: 'Uitverkocht',
        },
        {
          id: 'n22',
          time: '22:30',
          duration: '105 min',
          title: 'Late Cinema: Stalker',
          venue: 'EYE',
          badge: 'Film',
          badgeTone: 'azure',
          tick: 'azure',
          thumb:
            'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=200&q=60&auto=format&fit=crop',
        },
        {
          id: 'n23',
          time: '23:45',
          duration: 'doorlopend',
          title: 'NDSM Nacht — open floor',
          venue: 'NDSM-werf',
          badge: 'Muziek',
          badgeTone: 'acid',
          tick: 'acid',
          thumb:
            'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=200&q=60&auto=format&fit=crop',
        },
      ],
    },
  ],
  dag: [
    {
      id: 'd-25-04',
      num: '25',
      dow: 'Vr',
      month: 'APR',
      count: 2,
      items: [
        {
          id: 'd1',
          time: '10:30',
          duration: '45 min',
          title: 'Ochtendlezing: Stadsdichters',
          venue: 'OBA Oosterdok',
          badge: 'Literatuur',
          badgeTone: 'plum',
          tick: 'plum',
          thumb:
            'https://images.unsplash.com/photo-1517457373958-b7bdd4587205?w=200&q=60&auto=format&fit=crop',
        },
        {
          id: 'd2',
          time: '14:00',
          duration: '2u',
          title: 'Matinee: Eisensteins Stakes',
          venue: 'EYE',
          badge: 'Film',
          badgeTone: 'plum',
          tick: 'plum',
          thumb:
            'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=200&q=60&auto=format&fit=crop',
        },
      ],
    },
    {
      id: 'd-26-04',
      num: '26',
      dow: 'Za',
      month: 'APR',
      count: 4,
      items: [
        {
          id: 'd3',
          time: '11:00',
          duration: 'rondleiding',
          title: 'Rietveld – open ateliers',
          venue: 'Rietveld Academie',
          badge: 'Literatuur',
          badgeTone: 'plum',
          tick: 'plum',
          thumb:
            'https://images.unsplash.com/photo-1472289065668-ce650ac443d2?w=200&q=60&auto=format&fit=crop',
        },
        {
          id: 'd4',
          time: '15:30',
          duration: 'kamerconcert',
          title: 'Splendor Strings · kamerconcert',
          venue: 'Splendor',
          badge: 'Muziek',
          badgeTone: 'acid',
          tick: 'acid',
          thumb:
            'https://images.unsplash.com/photo-1507838153414-b4b713384a76?w=200&q=60&auto=format&fit=crop',
        },
        {
          id: 'd5',
          time: '16:00',
          duration: 'gratis',
          title: 'Boekpresentatie: Rondje Noord',
          venue: 'Athenaeum',
          badge: 'Literatuur',
          badgeTone: 'azure',
          tick: 'azure',
          thumb:
            'https://images.unsplash.com/photo-1519682577862-22b62b24e493?w=200&q=60&auto=format&fit=crop',
        },
        {
          id: 'd6',
          time: '20:00',
          duration: '90 min',
          title: 'Poëzie van de Middenmoot',
          venue: 'Perdu',
          badge: 'Literatuur',
          badgeTone: 'acid',
          tick: 'acid',
          thumb:
            'https://images.unsplash.com/photo-1506157786151-b8491531f063?w=200&q=60&auto=format&fit=crop',
          friends: [
            { name: 'Iris', avatar: 'https://i.pravatar.cc/40?img=20' },
          ],
        },
      ],
    },
    {
      id: 'd-27-04',
      num: '27',
      dow: 'Zo',
      month: 'APR',
      count: 3,
      items: [
        {
          id: 'd7',
          time: '11:30',
          duration: 'brunch-set',
          title: 'Sunday Strings',
          venue: 'Splendor',
          badge: 'Muziek',
          badgeTone: 'acid',
          tick: 'acid',
          thumb:
            'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=200&q=60&auto=format&fit=crop',
        },
        {
          id: 'd8',
          time: '14:00',
          duration: '2u',
          title: 'Theater voor kinderen: Grote Vis',
          venue: 'Frascati 2',
          badge: 'Theater',
          badgeTone: 'flare',
          tick: 'flare',
          thumb:
            'https://images.unsplash.com/photo-1503095396549-807759245b35?w=200&q=60&auto=format&fit=crop',
        },
        {
          id: 'd9',
          time: '15:00',
          duration: '3u',
          title: 'Tentoonstelling: Stakes',
          venue: 'Stedelijk',
          badge: 'Film',
          badgeTone: 'plum',
          tick: 'plum',
          thumb:
            'https://images.unsplash.com/photo-1472289065668-ce650ac443d2?w=200&q=60&auto=format&fit=crop',
        },
      ],
    },
    {
      id: 'd-28-04',
      num: '28',
      dow: 'Ma',
      month: 'APR',
      count: 2,
      items: [
        {
          id: 'd10',
          time: '12:30',
          duration: 'lunchconcert',
          title: 'Boekmanstichting · lunchconcert',
          venue: 'Boekmanzaal',
          badge: 'Muziek',
          badgeTone: 'acid',
          tick: 'acid',
          thumb:
            'https://images.unsplash.com/photo-1415201364774-f6f0bb35f28f?w=200&q=60&auto=format&fit=crop',
        },
        {
          id: 'd11',
          time: '17:00',
          duration: '45 min',
          title: 'Lezing: Stad als partituur',
          venue: 'Felix Meritis',
          badge: 'Literatuur',
          badgeTone: 'plum',
          tick: 'plum',
          thumb:
            'https://images.unsplash.com/photo-1517457373958-b7bdd4587205?w=200&q=60&auto=format&fit=crop',
        },
      ],
    },
    {
      id: 'd-30-04',
      num: '30',
      dow: 'Wo',
      month: 'APR',
      count: 2,
      items: [
        {
          id: 'd12',
          time: '10:00',
          duration: 'hele dag',
          title: 'Koningsdag op het IJ',
          venue: 'IJ-oevers',
          badge: 'Muziek',
          badgeTone: 'acid',
          tick: 'acid',
          thumb:
            'https://images.unsplash.com/photo-1506157786151-b8491531f063?w=200&q=60&auto=format&fit=crop',
        },
        {
          id: 'd13',
          time: '13:00',
          duration: 'open atelier',
          title: 'Dag-routine: Atelier Rutte',
          venue: 'Noord',
          badge: 'Literatuur',
          badgeTone: 'plum',
          tick: 'plum',
          thumb:
            'https://images.unsplash.com/photo-1472289065668-ce650ac443d2?w=200&q=60&auto=format&fit=crop',
        },
      ],
    },
    {
      id: 'd-02-05',
      num: '02',
      dow: 'Vr',
      month: 'MEI',
      count: 2,
      items: [
        {
          id: 'd14',
          time: '14:00',
          duration: '2u',
          title: 'Matinee: De Dodenherdenking',
          venue: 'Tuschinski',
          badge: 'Film',
          badgeTone: 'azure',
          tick: 'azure',
          thumb:
            'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=200&q=60&auto=format&fit=crop',
        },
        {
          id: 'd15',
          time: '16:30',
          duration: '75 min',
          title: 'Dichters voor Vrijheid',
          venue: 'Perdu',
          badge: 'Literatuur',
          badgeTone: 'plum',
          tick: 'plum',
          thumb:
            'https://images.unsplash.com/photo-1519682577862-22b62b24e493?w=200&q=60&auto=format&fit=crop',
        },
      ],
    },
    {
      id: 'd-04-05',
      num: '04',
      dow: 'Zo',
      month: 'MEI',
      count: 2,
      items: [
        {
          id: 'd16',
          time: '11:00',
          duration: 'stille wandeling',
          title: 'Stilte-wandeling langs de Amstel',
          venue: 'Amstel',
          badge: 'Literatuur',
          badgeTone: 'plum',
          tick: 'plum',
          thumb:
            'https://images.unsplash.com/photo-1503095396549-807759245b35?w=200&q=60&auto=format&fit=crop',
        },
        {
          id: 'd17',
          time: '15:00',
          duration: '90 min',
          title: 'Matinee: Eisenstein restored',
          venue: 'EYE',
          badge: 'Film',
          badgeTone: 'plum',
          tick: 'plum',
          thumb:
            'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=200&q=60&auto=format&fit=crop',
        },
      ],
    },
    {
      id: 'd-08-05',
      num: '08',
      dow: 'Do',
      month: 'MEI',
      count: 2,
      items: [
        {
          id: 'd18',
          time: '11:30',
          duration: 'lezing',
          title: 'Donderdaglezing: Stadse Tuinen',
          venue: 'Hortus',
          badge: 'Literatuur',
          badgeTone: 'plum',
          tick: 'plum',
          thumb:
            'https://images.unsplash.com/photo-1517457373958-b7bdd4587205?w=200&q=60&auto=format&fit=crop',
        },
        {
          id: 'd19',
          time: '15:30',
          duration: '60 min',
          title: 'Stedelijk · curatorrondleiding',
          venue: 'Stedelijk',
          badge: 'Film',
          badgeTone: 'azure',
          tick: 'azure',
          thumb:
            'https://images.unsplash.com/photo-1472289065668-ce650ac443d2?w=200&q=60&auto=format&fit=crop',
        },
      ],
    },
  ],
};
