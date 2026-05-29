/**
 * OG-image renderers voor share-redirect-pagina's. Composite-style:
 * hoofdimage (avatar of event-still) in een rounded-corner square +
 * Andreas-app-icoon rechtsonder als badge met box-shadow. 1200×630
 * (OG-spec), nacht-modus.
 *
 * Output: PNG Buffer. Cache-Control wordt door de route gezet — composeren
 * is duur (satori + resvg), maar per (token,locale) is de output stabiel.
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

/**
 * Gedeelde renderer voor beide invite- en event-share OG-images. Layout:
 * links 420×420 rounded square met `imageUrl`, rechts de tekst-stack
 * (title + subtitle — geen kicker, "Andreas" zit al in de title-copy).
 * Rechtsonder de avatar zit het Andreas-app-icoon als badge.
 */
async function renderShareOg(opts: {
  imageUrl: string | null;
  fallbackLetter?: string;
  title: string;
  subTitle: string;
}): Promise<Buffer> {
  const { imageUrl, fallbackLetter, title, subTitle } = opts;

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
    // Image-block links — rounded square + app-icoon-badge rechtsonder.
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
        imageUrl
          ? el('img', {
              src: imageUrl,
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
              (fallbackLetter ?? '?').toUpperCase()
            )
      ),
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
    // Tekst-blok rechts — alleen title + subtitle, geen kicker.
    el(
      'div',
      {
        style: {
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
        },
      },
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
        title
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
        subTitle
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

// ─── Invite (share-token) ────────────────────────────────────────────

export async function renderInviteOg(opts: {
  avatarUrl: string | null;
  inviterName: string;
  locale?: 'nl' | 'en';
}): Promise<Buffer> {
  const { avatarUrl, inviterName, locale = 'nl' } = opts;
  const copy =
    locale === 'en'
      ? {
          title: `${inviterName} is inviting you to ANDREAS`,
          subTitle: 'Download the app, sign in and you’re connected.',
        }
      : {
          title: `${inviterName} nodigt je uit op ANDREAS`,
          subTitle: 'Download de app, log in en jullie zijn vrienden.',
        };
  return renderShareOg({
    imageUrl: avatarUrl,
    fallbackLetter: inviterName.trim()[0] ?? '?',
    title: copy.title,
    subTitle: copy.subTitle,
  });
}

// ─── Event-share ─────────────────────────────────────────────────────

export async function renderEventOg(opts: {
  eventImageUrl: string | null;
  eventTitle: string;
  venueName: string | null;
  locale?: 'nl' | 'en';
}): Promise<Buffer> {
  const { eventImageUrl, eventTitle, venueName, locale = 'nl' } = opts;
  const copy =
    locale === 'en'
      ? {
          subTitle: venueName
            ? `${venueName} — open in the ANDREAS app for tickets and lineup.`
            : 'Open in the ANDREAS app for tickets and lineup.',
        }
      : {
          subTitle: venueName
            ? `${venueName} — open in de ANDREAS-app voor tickets en lineup.`
            : 'Open in de ANDREAS-app voor tickets en lineup.',
        };
  return renderShareOg({
    imageUrl: eventImageUrl,
    fallbackLetter: eventTitle.trim()[0] ?? 'A',
    title: eventTitle,
    subTitle: copy.subTitle,
  });
}
