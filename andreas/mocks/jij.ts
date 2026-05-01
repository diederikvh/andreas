import type { Mode } from '@/theme/tokens';

/**
 * Pre-baked "Jij" profile mock. Mirrors JIJ_FRIENDS / JIJ_REQUESTS in
 * app.html. Until fase 4 wires the real account, this is the source.
 */

export type JijProfile = {
  name: string;
  handle: string;
  avatar: string;
  bio: string;
};

export type JijFriend = {
  id: string;
  name: string;
  avatar: string;
  /** Per-mode meta line — "WAS GISTEREN BIJ PARADISO" / "WAS GISTEREN BIJ EYE". */
  meta: Record<Mode, string>;
  /** Highlight in accent colour — gives "warm" friends visual weight. */
  hot?: boolean;
};

export type JijRequest = {
  id: string;
  name: string;
  avatar: string;
  meta: string;
};

export const JIJ_PROFILE: JijProfile = {
  name: 'Tomas de Vries',
  handle: '@tomasdv · sinds ’23',
  avatar: 'https://i.pravatar.cc/128?img=14',
  bio: 'Vooral muziek, soms theater. Amsterdam.',
};

export const JIJ_FRIENDS: JijFriend[] = [
  {
    id: 'roos',
    name: 'Roos van Dam',
    avatar: 'https://i.pravatar.cc/72?img=47',
    meta: {
      dag: '3 gemeenschappelijke plannen',
      nacht: '3 gemeenschappelijke avonden',
    },
    hot: true,
  },
  {
    id: 'milan',
    name: 'Milan Berghuis',
    avatar: 'https://i.pravatar.cc/72?img=33',
    meta: {
      dag: 'Was gisteren bij EYE',
      nacht: 'Was gisteren bij Paradiso',
    },
  },
  {
    id: 'iris',
    name: 'Iris Sengers',
    avatar: 'https://i.pravatar.cc/72?img=20',
    meta: {
      dag: '1 gemeenschappelijk plan',
      nacht: '1 gemeenschappelijke avond',
    },
    hot: true,
  },
  {
    id: 'lotte',
    name: 'Lotte Ouwens',
    avatar: 'https://i.pravatar.cc/72?img=12',
    meta: { dag: 'Vaak naar EYE', nacht: 'Vaak naar OCCII' },
  },
  {
    id: 'sam',
    name: 'Sam Kortram',
    avatar: 'https://i.pravatar.cc/72?img=59',
    meta: { dag: 'Via Roos', nacht: 'Via Roos' },
  },
  {
    id: 'daan',
    name: 'Daan Polak',
    avatar: 'https://i.pravatar.cc/72?img=8',
    meta: { dag: 'Geen overlap', nacht: 'Geen overlap' },
  },
  {
    id: 'ines',
    name: 'Ines Marqués',
    avatar: 'https://i.pravatar.cc/72?img=31',
    meta: {
      dag: 'Nieuw · sinds deze week',
      nacht: 'Nieuw · sinds deze week',
    },
  },
  {
    id: 'sem',
    name: 'Sem Brunings',
    avatar: 'https://i.pravatar.cc/72?img=15',
    meta: { dag: 'Volgt jou terug', nacht: 'Volgt jou terug' },
  },
];

export const JIJ_REQUESTS: JijRequest[] = [
  {
    id: 'jonas',
    name: 'Jonas Velthuis',
    avatar: 'https://i.pravatar.cc/72?img=24',
    meta: '2 gemeenschappelijk · Roos, Milan',
  },
  {
    id: 'anouk',
    name: 'Anouk Strijbos',
    avatar: 'https://i.pravatar.cc/72?img=5',
    meta: 'Via Sam',
  },
];
