/**
 * OG-image renderer voor de share-invite-pagina (/i/:token). Composite
 * van avatar (rounded square) + Andreas-app-icoon rechtsonder met
 * subtiele schaduw. 1200×630 (OG-spec), nacht-modus.
 *
 * Output: PNG Buffer. Bedoeld voor caching via Cache-Control op de
 * route — composeren is duur, en de waarden zijn stabiel per token.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';

import { satoriFonts } from './fonts.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(HERE, '..', '..', 'static');
const APP_ICON_BUFFER = readFileSync(join(STATIC_DIR, 'icon-1024.png'));
const APP_ICON_DATA_URI = `data:image/png;base64,${APP_ICON_BUFFER.toString('base64')}`;

const WIDTH = 1200;
const HEIGHT = 630;

const NOIR = '#0a0a0b';
const NOIR2 = '#17171a';
const INK = '#f2f2ef';
const INK_MUTED = '#9a9a94';
const ACID = '#d4ff3a';

type VNode = {
  type: string;
  props: { [key: string]: unknown; children?: unknown };
};

// Cross-glyph als twee gedraaide blokjes — fonts hebben geen glyph voor
// U+2715, dus een lettersymbool valt om als ▢. Matcht de Cross.tsx
// brand-mark uit de mobile-app.
function cross(size: number, thickness: number, color: string): VNode {
  return el(
    'div',
    {
      style: {
        position: 'relative',
        width: size,
        height: size,
        display: 'flex',
      },
    },
    el('div', {
      style: {
        position: 'absolute',
        top: size / 2 - thickness / 2,
        left: 0,
        width: size,
        height: thickness,
        backgroundColor: color,
        transform: 'rotate(45deg)',
      },
    }),
    el('div', {
      style: {
        position: 'absolute',
        top: size / 2 - thickness / 2,
        left: 0,
        width: size,
        height: thickness,
        backgroundColor: color,
        transform: 'rotate(-45deg)',
      },
    })
  );
}

function el(
  type: string,
  props: { [key: string]: unknown } | null,
  ...children: (VNode | string | number | null | false | undefined)[]
): VNode {
  const flat = children
    .flat(Infinity as 1)
    .filter((c) => c != null && c !== false);
  return {
    type,
    props: {
      ...(props ?? {}),
      children:
        flat.length === 0
          ? undefined
          : flat.length === 1
            ? flat[0]
            : flat,
    },
  };
}

export async function renderInviteOg(opts: {
  avatarUrl: string | null;
  inviterName: string;
  locale?: 'nl' | 'en';
}): Promise<Buffer> {
  const { avatarUrl, inviterName, locale = 'nl' } = opts;
  const copy =
    locale === 'en'
      ? {
          kickerLeft: 'Andreas',
          kickerRight: 'Friends',
          title: `${inviterName} is inviting you to ANDREAS`,
          subTitle: 'Download the app, sign in and you’re connected.',
        }
      : {
          kickerLeft: 'Andreas',
          kickerRight: 'Vrienden',
          title: `${inviterName} nodigt je uit op ANDREAS`,
          subTitle: 'Download de app, log in en jullie zijn vrienden.',
        };

  const tree = el(
    'div',
    {
      style: {
        width: WIDTH,
        height: HEIGHT,
        backgroundColor: NOIR,
        display: 'flex',
        alignItems: 'center',
        padding: '60px 72px',
        gap: 56,
      },
    },
    // Avatar-block links — rounded square + app-icoon rechtsonder.
    el(
      'div',
      {
        style: {
          width: 420,
          height: 420,
          position: 'relative',
          display: 'flex',
        },
      },
      // Buiten-vlak met paper-tint border-glow voor 'n premium-touch.
      el(
        'div',
        {
          style: {
            position: 'absolute',
            top: 0,
            left: 0,
            width: 420,
            height: 420,
            borderRadius: 36,
            backgroundColor: NOIR2,
            display: 'flex',
            overflow: 'hidden',
          },
        },
        avatarUrl
          ? el('img', {
              src: avatarUrl,
              width: 420,
              height: 420,
              style: { width: 420, height: 420, objectFit: 'cover' },
            })
          : el(
              'div',
              {
                style: {
                  width: 420,
                  height: 420,
                  backgroundColor: NOIR2,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: ACID,
                  fontSize: 180,
                  fontFamily: 'Archivo',
                  fontWeight: 900,
                },
              },
              (inviterName.trim()[0] || '?').toUpperCase()
            )
      ),
      // App-icoon rechtsonder, met 'n donkere zone-ring eronder als
      // shadow-substituut (Satori's box-shadow is beperkt; een dichte
      // ring achter het icoon levert dezelfde "drop"-vibe). Iets
      // overstekend buiten de avatar-grens voor 't badge-effect.
      el(
        'div',
        {
          style: {
            position: 'absolute',
            right: -22,
            bottom: -22,
            width: 168,
            height: 168,
            borderRadius: 40,
            backgroundColor: NOIR,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            // Donkere 'glow' achter het icoon — een tweede laag pseudo-
            // shadow via een box-shadow op de containing div.
            boxShadow: '0 12px 36px rgba(0,0,0,0.55)',
          },
        },
        el(
          'div',
          {
            style: {
              width: 140,
              height: 140,
              borderRadius: 30,
              overflow: 'hidden',
              display: 'flex',
            },
          },
          el('img', {
            src: APP_ICON_DATA_URI,
            width: 140,
            height: 140,
            style: { width: 140, height: 140 },
          })
        )
      )
    ),
    // Tekst-blok rechts.
    el(
      'div',
      {
        style: {
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        },
      },
      // ANDREAS ✕-kicker — kruis als twee blokjes (font heeft geen
      // glyph voor U+2715). Black + uppercase eromheen voor de
      // brand-mark-vibe.
      el(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 14,
          },
        },
        el(
          'div',
          {
            style: {
              fontFamily: 'Archivo',
              fontWeight: 900,
              fontSize: 24,
              letterSpacing: 1.5,
              color: ACID,
              textTransform: 'uppercase',
              display: 'flex',
            },
          },
          copy.kickerLeft
        ),
        cross(22, 5, ACID),
        el(
          'div',
          {
            style: {
              fontFamily: 'Archivo',
              fontWeight: 900,
              fontSize: 24,
              letterSpacing: 1.5,
              color: ACID,
              textTransform: 'uppercase',
              display: 'flex',
            },
          },
          copy.kickerRight
        )
      ),
      el(
        'div',
        {
          style: {
            fontFamily: 'Archivo',
            fontWeight: 900,
            fontSize: 64,
            lineHeight: 1.05,
            letterSpacing: -1.5,
            color: INK,
            display: 'flex',
            flexWrap: 'wrap',
          },
        },
        copy.title
      ),
      el(
        'div',
        {
          style: {
            fontFamily: 'Archivo',
            fontWeight: 700,
            fontSize: 28,
            lineHeight: 1.3,
            color: INK_MUTED,
            display: 'flex',
            flexWrap: 'wrap',
          },
        },
        copy.subTitle
      )
    )
  );

  const svg = await satori(tree as Parameters<typeof satori>[0], {
    width: WIDTH,
    height: HEIGHT,
    fonts: satoriFonts as unknown as Parameters<typeof satori>[1]['fonts'],
  });
  return new Resvg(svg, {
    fitTo: { mode: 'width', value: WIDTH },
  })
    .render()
    .asPng();
}
