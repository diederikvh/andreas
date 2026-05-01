import type { Config } from 'tailwindcss';
import { palette, radii } from './theme/tokens';

const config: Config = {
  content: [
    './app/**/*.{js,jsx,ts,tsx}',
    './components/**/*.{js,jsx,ts,tsx}',
  ],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        noir: palette.noir,
        'noir-2': palette.noir2,
        'noir-3': palette.noir3,
        ink: palette.ink,
        'ink-muted': palette.inkMuted,
        paper: palette.paper,
        'paper-2': palette.paper2,
        'paper-3': palette.paper3,
        soil: palette.soil,
        'soil-muted': palette.soilMuted,
        acid: palette.acid,
        flare: palette.flare,
        plum: palette.plum,
        azure: palette.azure,
        red: palette.red,
        forest: palette.forest,
        cobalt: palette.cobalt,
        saffron: palette.saffron,
      },
      fontFamily: {
        display: ['Archivo_900Black'],
        'display-bold': ['Archivo_800ExtraBold'],
        bold: ['Archivo_700Bold'],
        medium: ['Archivo_500Medium'],
        body: ['Archivo_400Regular'],
        mono: ['JetBrainsMono_400Regular'],
        'mono-medium': ['JetBrainsMono_500Medium'],
      },
      borderRadius: {
        xs: `${radii.xs}px`,
        s: `${radii.s}px`,
        m: `${radii.m}px`,
        l: `${radii.l}px`,
        pill: `${radii.pill}px`,
        phone: `${radii.phone}px`,
      },
    },
  },
  plugins: [],
};

export default config;
