/**
 * Satori-templates voor de IG-carousel. Eén carousel = 5 slides:
 *
 *   1. Cover  — "Vanavond in Amsterdam" + datum + Andreas-kruis
 *   2-4. Event-slide — hero-foto + tijd + titel + venue + cat-pill
 *   5. Outro  — "Open Andreas" CTA + groot kruis
 *
 * Output van iedere builder is een Satori-compatibel virtual-DOM object
 * (shape `{ type, props: { style, children } }`). Geen JSX want
 * `hono/jsx` is incompatibel met React's vnode-shape die Satori wil.
 *
 * Slide-formaat: 1080×1350 (4:5 — IG-feed-portrait). Nacht-modus.
 */

export const SLIDE_WIDTH = 1080;
export const SLIDE_HEIGHT = 1350;

const NOIR = '#0a0a0b';
const NOIR2 = '#17171a';
const INK = '#f2f2ef';
const INK_MUTED = '#9a9a94';
const ACID = '#d4ff3a';
const FLARE = '#ff4d2e';

type VNode = {
  type: string;
  props: { [key: string]: unknown; children?: unknown };
};

type Child = VNode | string | number | null | false | undefined;

function el(
  type: string,
  props: { [key: string]: unknown } | null,
  ...children: Child[]
): VNode {
  const flat = children.flat(Infinity).filter((c) => c != null && c !== false);
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

// ─── Andreas-kruis ────────────────────────────────────────────────────────

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

// ─── Helpers ──────────────────────────────────────────────────────────────

/** "Za 16 mei" — Amsterdam-locale Nederlandstalige short-date, capital weekday. */
function formatDateNl(d: Date): string {
  const fmt = new Intl.DateTimeFormat('nl-NL', {
    timeZone: 'Europe/Amsterdam',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(d);
  const clean = fmt.replace(/\./g, '');
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/** "21:00" — Amsterdam-locale tijd. */
function formatTimeNl(d: Date): string {
  return new Intl.DateTimeFormat('nl-NL', {
    timeZone: 'Europe/Amsterdam',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

// ─── Templates ────────────────────────────────────────────────────────────

export interface CoverInput {
  date: Date;
  pickCount: number;
  /** Optionele hero-foto achter de cover — meestal de eerste pick van
      de carousel zodat slide 1 → slide 2 visueel bindt. Donker overlay
      gradient zorgt dat de tekst leesbaar blijft. */
  heroImageUrl?: string | null;
}

export function coverSlide(input: CoverInput): VNode {
  const hasHero = !!input.heroImageUrl;
  return el(
    'div',
    {
      style: {
        width: SLIDE_WIDTH,
        height: SLIDE_HEIGHT,
        backgroundColor: NOIR,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
        alignItems: 'flex-start',
        padding: 80,
        color: INK,
        fontFamily: 'Archivo',
        position: 'relative',
      },
    },
    // Hero image als achtergrond (indien aanwezig)
    hasHero
      ? el('img', {
          src: input.heroImageUrl,
          width: SLIDE_WIDTH,
          height: SLIDE_HEIGHT,
          style: {
            position: 'absolute',
            top: 0,
            left: 0,
            width: SLIDE_WIDTH,
            height: SLIDE_HEIGHT,
            objectFit: 'cover',
          },
        })
      : null,
    // Donkere overlay-gradient bottom-up zodat tekst leesbaar is
    hasHero
      ? el('div', {
          style: {
            position: 'absolute',
            top: 0,
            left: 0,
            width: SLIDE_WIDTH,
            height: SLIDE_HEIGHT,
            backgroundImage:
              'linear-gradient(180deg, rgba(10,10,11,0.30) 0%, rgba(10,10,11,0.10) 25%, rgba(10,10,11,0.55) 55%, rgba(10,10,11,0.96) 88%)',
          },
        })
      : null,
    // Tekst-stack onderaan
    el(
      'div',
      {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 0,
          position: 'relative',
        },
      },
      el(
        'div',
        {
          style: {
            fontSize: 80,
            fontWeight: 700,
            lineHeight: 1.05,
            color: ACID,
            letterSpacing: -2,
          },
        },
        formatDateNl(input.date)
      ),
      el(
        'div',
        {
          style: {
            fontSize: 148,
            fontWeight: 900,
            lineHeight: 0.95,
            color: INK,
            letterSpacing: -8,
            marginTop: 8,
          },
        },
        'Amsterdam'
      ),
      el(
        'div',
        {
          style: {
            fontSize: 56,
            fontWeight: 900,
            color: INK,
            letterSpacing: -1,
            marginTop: 24,
          },
        },
        'Tips voor vanavond'
      )
    )
  );
}

// ─── Event-slide ──────────────────────────────────────────────────────────

export interface EventSlideInput {
  imageUrl: string;
  title: string;
  venueName: string;
  /** Event-category (Muziek/Theater/Film/Kunst/Literatuur) — niet meer
      gebruikt in template, maar blijft in interface voor backcompat. */
  category: string;
  /** Venue-type pill: galerie/museum/podium/club/film/ruimte/boekhandel-cafe.
      Sterker huisstijl-signaal dan event-category want zelfde taxonomie
      als de Venues-tab in de app. Nullable voor oude venues zonder type. */
  venueType: string | null;
  startsAt: Date;
  endsAt: Date | null;
  index: number; // 1..N
  total: number;
}

export function eventSlide(input: EventSlideInput): VNode {
  const time = formatTimeNl(input.startsAt);
  const duration =
    input.endsAt && input.endsAt.getTime() > input.startsAt.getTime()
      ? `– ${formatTimeNl(input.endsAt)}`
      : null;

  return el(
    'div',
    {
      style: {
        width: SLIDE_WIDTH,
        height: SLIDE_HEIGHT,
        backgroundColor: NOIR,
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        fontFamily: 'Archivo',
        color: INK,
      },
    },
    // Hero image (full bleed)
    el('img', {
      src: input.imageUrl,
      width: SLIDE_WIDTH,
      height: SLIDE_HEIGHT,
      style: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: SLIDE_WIDTH,
        height: SLIDE_HEIGHT,
        objectFit: 'cover',
      },
    }),
    // Dark gradient overlay (bottom-heavy)
    el('div', {
      style: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: SLIDE_WIDTH,
        height: SLIDE_HEIGHT,
        backgroundImage:
          'linear-gradient(180deg, rgba(10,10,11,0.55) 0%, rgba(10,10,11,0.20) 30%, rgba(10,10,11,0.55) 60%, rgba(10,10,11,0.96) 88%)',
      },
    }),
    // Top-left: twee aparte pills — venue-type (acid) + category (flare)
    (() => {
      const pills: VNode[] = [];
      const pillStyle = (bg: string, fg: string) => ({
        backgroundColor: bg,
        color: fg,
        fontSize: 36,
        fontWeight: 900,
        letterSpacing: -1,
        padding: '14px 28px',
        borderRadius: 999,
      });
      const venueType = input.venueType?.toLowerCase();
      const cat = input.category?.toLowerCase();
      if (venueType) {
        pills.push(el('div', { style: pillStyle(ACID, NOIR) }, venueType));
      }
      if (cat && cat !== venueType) {
        pills.push(el('div', { style: pillStyle(FLARE, INK) }, cat));
      }
      if (pills.length === 0) return null;
      return el(
        'div',
        {
          style: {
            position: 'absolute',
            top: 60,
            left: 60,
            display: 'flex',
            flexDirection: 'row',
            gap: 12,
          },
        },
        ...pills
      );
    })(),
    // Bottom panel
    el(
      'div',
      {
        style: {
          position: 'absolute',
          left: 60,
          right: 60,
          bottom: 80,
          display: 'flex',
          flexDirection: 'column',
          gap: 24,
        },
      },
      // Time row
      el(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'row',
            gap: 18,
            alignItems: 'baseline',
          },
        },
        el(
          'div',
          {
            style: {
              fontSize: 64,
              fontWeight: 900,
              color: ACID,
              letterSpacing: -2,
            },
          },
          time
        ),
        duration
          ? el(
              'div',
              {
                style: {
                  fontSize: 44,
                  fontWeight: 500,
                  color: INK,
                },
              },
              duration
            )
          : null
      ),
      // Title
      el(
        'div',
        {
          style: {
            fontSize: 96,
            fontWeight: 900,
            lineHeight: 1.02,
            color: INK,
            letterSpacing: -3,
            display: 'flex',
            maxHeight: 96 * 3 * 1.02,
            overflow: 'hidden',
          },
        },
        input.title
      ),
      // Venue — bigger and bolder than before
      el(
        'div',
        {
          style: {
            fontSize: 56,
            fontWeight: 700,
            color: INK,
            letterSpacing: -1,
            marginTop: 4,
          },
        },
        input.venueName
      )
    )
  );
}

// ─── Outro-slide ──────────────────────────────────────────────────────────

export function outroSlide(): VNode {
  return el(
    'div',
    {
      style: {
        width: SLIDE_WIDTH,
        height: SLIDE_HEIGHT,
        backgroundColor: NOIR,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 80,
        fontFamily: 'Archivo',
        color: INK,
      },
    },
    el(
      'div',
      {
        style: {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 56,
        },
      },
      cross(360, 90, ACID),
      el(
        'div',
        {
          style: {
            fontSize: 96,
            fontWeight: 900,
            letterSpacing: 2,
            textTransform: 'uppercase',
            color: INK,
          },
        },
        'Andreas'
      ),
      el(
        'div',
        {
          style: {
            fontSize: 48,
            fontWeight: 500,
            color: INK,
            lineHeight: 1.2,
            textAlign: 'center',
            maxWidth: 820,
            display: 'flex',
          },
        },
        'Check dé app voor meer tips.'
      ),
      el(
        'div',
        {
          style: {
            fontSize: 36,
            fontWeight: 500,
            color: INK_MUTED,
            letterSpacing: 2,
            marginTop: 8,
          },
        },
        'Andreas Amsterdam'
      )
    )
  );
}
