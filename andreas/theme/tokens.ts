/**
 * Andreas — design tokens
 * Source of truth, mirrored from tokens.css. The Tailwind config
 * imports from here so utility classes stay in sync.
 */

export const palette = {
  // Nacht
  noir: '#0a0a0b',
  noir2: '#17171a',
  noir3: '#1f1f23',
  ink: '#f2f2ef',
  inkMuted: '#9a9a94',

  // Dag
  paper: '#d9d1bf',
  paper2: '#ebe6d8',
  paper3: '#f5f1e8',
  soil: '#1a1410',
  soilMuted: '#5a4e3f',

  // Brand accents
  acid: '#d4ff3a', // nacht-only
  flare: '#ff4d2e', // nacht-only
  plum: '#c441ff',
  azure: '#4d7cff',
  red: '#c9453a', // dag primary
  forest: '#2d4a3e',
  cobalt: '#2b4b9c',
  saffron: '#e89b2e',
} as const;

export type PaletteKey = keyof typeof palette;

/**
 * Mode-resolved roles. Components read from these instead of palette
 * keys, so a mode switch only flips one map.
 */
export const roles = {
  nacht: {
    bg: palette.noir,
    bgLift: palette.noir2,
    bgChip: palette.noir3,
    fg: palette.ink,
    fgMuted: palette.inkMuted,
    accent: palette.acid,
    accent2: palette.flare,
    onAccent: palette.noir,
    curtainBg: palette.paper,
    curtainFg: palette.soil,
  },
  dag: {
    bg: palette.paper,
    bgLift: palette.paper2,
    bgChip: palette.paper3,
    fg: palette.soil,
    fgMuted: palette.soilMuted,
    accent: palette.red,
    accent2: palette.forest,
    onAccent: palette.paper3,
    curtainBg: palette.noir,
    curtainFg: palette.acid,
  },
} as const;

export type Mode = keyof typeof roles;
export type RoleKey = keyof (typeof roles)['nacht'];

export const radii = {
  xs: 4,
  s: 8,
  m: 12,
  l: 18,
  pill: 999,
  phone: 46,
} as const;

export const fontSize = {
  xs: 10,
  s: 12,
  m: 14,
  base: 15,
  l: 17,
  xl: 22,
  '2xl': 30,
  hero: 34,
} as const;

export const motion = {
  ease: [0.65, 0, 0.35, 1] as const, // bezier control points
  fast: 220,
  base: 400,
  curtain: 900,
} as const;

export const stroke = {
  icon: 3.6, // Andreas icons: thick, no rounded caps
} as const;

export const fontFamily = {
  display: 'Archivo_900Black',
  displayBold: 'Archivo_800ExtraBold',
  bold: 'Archivo_700Bold',
  medium: 'Archivo_500Medium',
  body: 'Archivo_400Regular',
  serifItalic: 'Archivo_400Regular_Italic',
  mono: 'JetBrainsMono_400Regular',
  monoMedium: 'JetBrainsMono_500Medium',
} as const;
