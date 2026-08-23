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

  // Dag — wit met rood. Was een cream/beige-schaal (#f5f1e8 canvas,
  // warm-bruine tekst); dat las als papier maar ook als oud. Nu een
  // neutrale wit-grijs-schaal zodat het rood het enige warme in beeld
  // is en er ook echt uitspringt.
  //
  // Namen blijven `paper*` — ze zitten op ~170 call-sites en de rol is
  // niet veranderd: paper3 = canvas, paper2 = tegel bóven het canvas,
  // paper = rand/chip. Alleen de waarden zijn nu wit in plaats van geel.
  paper: '#e4e4e9',
  paper2: '#f1f1f4',
  paper3: '#ffffff',
  soil: '#141417',
  soilMuted: '#6e6e78',

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
/**
 * Foreground hierarchy (brightest → dimmest):
 *   fg          — title / display, full contrast
 *   fgRead      — body paragraphs people actually read
 *   fgMuted     — labels, kickers, footer micro-caps
 *   fgPlaceholder — input placeholders, "ghost" text
 */
export const roles = {
  nacht: {
    bg: palette.noir,
    bgLift: palette.noir2,
    bgChip: palette.noir3,
    /** Softere chip-bg, gebruikt voor neutrale labels (subtype, series,
        wijk-pills) zodat ze niet zwaarder ogen dan tone-tinted hoofd-
        labels. In nacht: net lichter dan canvas, niet zo prominent als
        bgChip. */
    bgTag: palette.noir2,
    fg: palette.ink,
    fgRead: '#c8c8c2',
    fgMuted: palette.inkMuted,
    fgPlaceholder: '#4a4a46',
    accent: palette.acid,
    accent2: palette.flare,
    /** Emphasis colour for em-words inside titles. Always the warm pop. */
    emphasis: palette.flare,
    onAccent: palette.noir,
    curtainBg: palette.paper3,
    curtainFg: palette.soil,
  },
  dag: {
    // Canvas is paper3 (wit); de donkerdere papers zijn tegels die
    // erbóven liggen. Op puur wit is het verschil tussen canvas en
    // tegel klein, dus bgChip (paper) doet ook dienst als randkleur —
    // vandaar dat die iets zwaarder is dan je voor een vlak zou kiezen.
    bg: palette.paper3,
    bgLift: palette.paper2,
    bgChip: palette.paper,
    /** Softere chip-bg voor neutrale labels — paper2 is lichter dan
        bgChip (paper), past zachter op de cream canvas zonder te
        verdwijnen. */
    bgTag: palette.paper2,
    fg: palette.soil,
    fgRead: '#38383f',
    fgMuted: palette.soilMuted,
    fgPlaceholder: '#adadb6',
    accent: palette.red,
    accent2: palette.forest,
    /** Same warm-pop role as nacht; in dag the warm pop IS the primary red. */
    emphasis: palette.red,
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
  mono: 'JetBrainsMono_400Regular',
  monoMedium: 'JetBrainsMono_500Medium',
} as const;
