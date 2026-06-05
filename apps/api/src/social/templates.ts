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
 * Slide-formaat: 1080×1350 (4:5 — maximum feed-portrait voor IG feed
 * carousels). Eerder hadden we 9:16 (1080×1920) maar dat is Reels/
 * Stories-formaat: IG drukt zulke posts in een 4:5-frame in de feed
 * waardoor de slides ingesnoerd renderen. 4:5 is wat 'normale' tall
 * feed-portraits (zoals somewhere.media) gebruiken en wat edge-to-edge
 * vult in de feed. Nacht-modus. Hero-images zijn `objectFit: cover`
 * dus adapteren naar de langere frame (croppen waar nodig).
 */

/** Twee carousel-formaten:
 *  - 'ig'     → 1080×1350 (4:5) Instagram-feed-carousel maximum
 *  - 'tiktok' → 1080×1920 (9:16) TikTok photo-carousel beeldvullend
 *  Templates renderen per format zodat tekst-positionering en hero-crops
 *  per platform optimaal blijven (geen letterboxing op TikTok, geen
 *  centrale-crop op IG). */
export type SlideFormat = 'ig' | 'tiktok';

export const FORMATS: Record<SlideFormat, { width: number; height: number }> = {
  ig: { width: 1080, height: 1350 },
  tiktok: { width: 1080, height: 1920 },
};

/** Default-export voor backcompat — IG-formaat. Nieuwe code gebruikt
 *  `FORMATS[format]`. */
export const SLIDE_WIDTH = FORMATS.ig.width;
export const SLIDE_HEIGHT = FORMATS.ig.height;

function dims(format: SlideFormat | undefined): {
  W: number;
  H: number;
} {
  const f = FORMATS[format ?? 'ig'];
  return { W: f.width, H: f.height };
}

/**
 * Safe-area paddings per format. TikTok's UI-overlay neemt boven ~180px
 * (logo + tijdsbalk) en onder ~320-380px (caption + actie-knoppen +
 * nav-bar) van het scherm. Hero-images mogen vol-bleed blijven (visueel
 * decoratief), maar TEKST en KAART-elementen moeten binnen de safe-area
 * blijven om leesbaar te zijn. IG-feed-carousel heeft die overlay niet.
 *
 * Output is element-specifieke padding (event-slide top-kicker en
 * bottom-panel hebben verschillende offsets dan overview-grid).
 */
function pad(format: SlideFormat | undefined): {
  /** Y-offset top-kicker (themeLabel) op event-slide. */
  eventTop: number;
  /** X-offset event-slide content (kicker + bottom-panel). */
  eventSide: number;
  /** Y-offset bottom-panel (datum/titel/venue) op event-slide. */
  eventBottom: number;
  /** Symmetrische padding voor intro-slide (hook is gecentreerd in box). */
  introPadY: number;
  introPadX: number;
  /** Outer-padding (top/side/bottom) voor overview-grid. */
  overviewTop: number;
  overviewSide: number;
  overviewBottom: number;
} {
  if (format === 'tiktok') {
    return {
      eventTop: 180,
      eventSide: 120,
      eventBottom: 380,
      introPadY: 220,
      introPadX: 140,
      overviewTop: 180,
      overviewSide: 120,
      overviewBottom: 360,
    };
  }
  return {
    eventTop: 60,
    eventSide: 60,
    eventBottom: 56,
    introPadY: 80,
    introPadX: 80,
    overviewTop: 80,
    overviewSide: 80,
    overviewBottom: 40,
  };
}

const NOIR = '#0a0a0b';
const NOIR2 = '#17171a';
const INK = '#f2f2ef';
const INK_MUTED = '#9a9a94';
const ACID = '#d4ff3a';

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

/** Hele-dag-event detecteren — scrapers vullen vaak 00:00 → 23:59
    (of 00:00 / 23:00) in voor doorlopende exposities. Die letterlijk
    op de slide tonen klopt niet. */
function isFullDay(startsAt: Date, endsAt: Date | null): boolean {
  if (!endsAt) return false;
  if (formatTimeNl(startsAt) !== '00:00') return false;
  const end = formatTimeNl(endsAt);
  return end === '23:59' || end === '23:00' || end === '00:00';
}

// ─── Templates ────────────────────────────────────────────────────────────

export interface CoverInput {
  date: Date;
  pickCount: number;
  /** Optionele hero-foto achter de cover — meestal de eerste pick van
      de carousel zodat slide 1 → slide 2 visueel bindt. Donker overlay
      gradient zorgt dat de tekst leesbaar blijft. */
  heroImageUrl?: string | null;
  /** "Tips voor vandaag" (ochtend) of "Tips voor vanavond" (avond) —
      wordt onder de datum getoond. Caller bepaalt op basis van slot. */
  tagline?: string;
  format?: SlideFormat;
}

export function coverSlide(input: CoverInput): VNode {
  const hasHero = !!input.heroImageUrl;
  const { W, H } = dims(input.format);
  return el(
    'div',
    {
      style: {
        width: W,
        height: H,
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
          width: W,
          height: H,
          style: {
            position: 'absolute',
            top: 0,
            left: 0,
            width: W,
            height: H,
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
            width: W,
            height: H,
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
        input.tagline ?? 'Tips voor vandaag'
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
  /** Dag-thema label (bv. "Theater" of "Live muziek") — rendert als
      acid-kicker top-left. Optioneel; bij ontbreken geen kicker. */
  themeLabel?: string;
  /** Subtekst onder themeLabel: tijdseenheid ("Komende 7 dagen"). */
  windowLabel?: string;
  format?: SlideFormat;
}

export function eventSlide(input: EventSlideInput): VNode {
  // Geen eind-tijd op de carousel-slides: te druk en geeft een verkeerd
  // signaal (alsof de show maar tot dat moment is). Start-tijd is
  // voldoende; bezoekers checken eind-tijd in de app/site.
  const fullDay = isFullDay(input.startsAt, input.endsAt);
  const time = fullDay ? 'Hele dag' : formatTimeNl(input.startsAt);
  const { W, H } = dims(input.format);
  const p = pad(input.format);

  return el(
    'div',
    {
      style: {
        width: W,
        height: H,
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
      width: W,
      height: H,
      style: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: W,
        height: H,
        objectFit: 'cover',
      },
    }),
    // Dark gradient overlay (bottom-heavy)
    el('div', {
      style: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: W,
        height: H,
        backgroundImage:
          'linear-gradient(180deg, rgba(10,10,11,0.55) 0%, rgba(10,10,11,0.20) 30%, rgba(10,10,11,0.55) 60%, rgba(10,10,11,0.96) 88%)',
      },
    }),
    // Top-left: dag-thema kicker (themeLabel + windowLabel). Vervangt
    // de oude cat/venue-pills omdat de category nu impliciet is via
    // het thema (ma=theater, di=muziek, …). Twee tekstregels: groot
    // acid label + kleinere muted-subtekst voor tijdseenheid.
    input.themeLabel
      ? el(
          'div',
          {
            style: {
              position: 'absolute',
              top: p.eventTop,
              left: p.eventSide,
              right: p.eventSide,
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            },
          },
          el(
            'div',
            {
              style: {
                fontSize: 44,
                fontWeight: 900,
                color: ACID,
                letterSpacing: -1,
                textTransform: 'uppercase',
              },
            },
            input.themeLabel
          ),
          input.windowLabel
            ? el(
                'div',
                {
                  style: {
                    fontSize: 26,
                    fontWeight: 700,
                    color: INK,
                    letterSpacing: 0,
                    textTransform: 'uppercase',
                    opacity: 0.85,
                  },
                },
                input.windowLabel
              )
            : null
        )
      : null,
    // Bottom panel
    el(
      'div',
      {
        style: {
          position: 'absolute',
          left: p.eventSide,
          right: p.eventSide,
          bottom: p.eventBottom,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        },
      },
      // Datum links, tijd rechts op één regel. Datum vertelt de lezer
      // welke dag, tijd staat als sterke acid-marker rechts.
      el(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            width: '100%',
          },
        },
        // Datum + tijd op één regel: "VR 25 MEI · 20:00". Minder
        // verticale ruimte, meer compact.
        el(
          'div',
          {
            style: {
              fontSize: 46,
              fontWeight: 900,
              color: ACID,
              letterSpacing: -1,
              textTransform: 'uppercase',
            },
          },
          `${formatDateNl(input.startsAt)} · ${time}`
        )
      ),
      // Title
      el(
        'div',
        {
          style: {
            fontSize: 78,
            fontWeight: 900,
            lineHeight: 1.02,
            color: INK,
            letterSpacing: -3,
            display: 'flex',
            maxHeight: 78 * 3 * 1.02,
            overflow: 'hidden',
          },
        },
        input.title
      ),
      // Venue
      el(
        'div',
        {
          style: {
            fontSize: 42,
            fontWeight: 700,
            color: INK,
            letterSpacing: -1,
          },
        },
        input.venueName
      )
    )
  );
}

// ─── Outro-slide ──────────────────────────────────────────────────────────

// ─── Intro + Overview (matched aan video-templates) ─────────────────────

export interface IntroSlideInput {
  /** Achtergrondafbeelding — gebruik bv. de laatste pick zodat de
      intro niet dezelfde foto heeft als slide 1. */
  heroImageUrl: string;
  /** Pakkende hook-zin gecentreerd in beeld. */
  hook: string;
  format?: SlideFormat;
}

/**
 * Intro slide voor de carousel — image-led achtergrond met sterke dim
 * + grote gecentreerde hook + Andreas-pill onderaan. Matched de stijl
 * van de Remotion-video introscherm.
 */
export function introSlide(input: IntroSlideInput): VNode {
  const { W, H } = dims(input.format);
  const p = pad(input.format);
  return el(
    'div',
    {
      style: {
        width: W,
        height: H,
        backgroundColor: NOIR,
        display: 'flex',
        position: 'relative',
        fontFamily: 'Archivo',
      },
    },
    // Achtergrondafbeelding
    el('img', {
      src: input.heroImageUrl,
      width: W,
      height: H,
      style: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: W,
        height: H,
        objectFit: 'cover',
      },
    }),
    // Sterke noir-dim zodat de hook altijd leesbaar is
    el('div', {
      style: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: W,
        height: H,
        backgroundColor: 'rgba(10,10,11,0.65)',
      },
    }),
    // Centrale tekst-blok — padding schaalt met safe-area zodat de
    // hook op TikTok niet onder de caption/action-buttons valt.
    el(
      'div',
      {
        style: {
          position: 'absolute',
          top: 0,
          left: 0,
          width: W,
          height: H,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          padding: `${p.introPadY}px ${p.introPadX}px`,
        },
      },
      // Grote hook-zin
      el(
        'div',
        {
          style: {
            color: INK,
            fontSize: 96,
            fontWeight: 800,
            lineHeight: 1.0,
            letterSpacing: -2.5,
            textAlign: 'center',
            marginBottom: 36,
          },
        },
        input.hook,
      ),
      // Acid-pill "ANDREAS"
      el(
        'div',
        {
          style: {
            display: 'flex',
            backgroundColor: ACID,
            color: NOIR,
            padding: '12px 24px',
            borderRadius: 6,
            fontSize: 32,
            fontWeight: 700,
            letterSpacing: 5,
            textTransform: 'uppercase',
          },
        },
        'Andreas',
      ),
    ),
  );
}

export interface OverviewSlideInput {
  /** Tekst tussen Andreas en X, bv. "Film", "Theater", "Live". */
  themeKicker: string;
  /** 6 picks die in 2x3 grid worden getoond. */
  picks: Array<{
    imageUrl: string;
    title: string;
    startsAt: Date;
    endsAt: Date | null;
  }>;
  format?: SlideFormat;
}

/**
 * Overview slide — 2x3 grid van alle picks met datum + titel als
 * overlay-tekst linksonder in elke card. Matched de stijl van de
 * Remotion-video overview slide.
 */
export function overviewSlide(input: OverviewSlideInput): VNode {
  const { W, H } = dims(input.format);
  const p = pad(input.format);
  // Cellbreedte = (slide-W − padding-l/r − gap) / 2. Cellhoogte schaalt
  // dynamisch met slide-H + safe-area-padding zodat 3 rijen netjes
  // passen tussen header en bottom-padding. 14px verticale gap.
  const cellWidth = (W - p.overviewSide * 2 - 14) / 2;
  const HEADER_BLOCK = 36 + 30; // header font + header-margin
  const VERTICAL_OVERHEAD = p.overviewTop + HEADER_BLOCK + p.overviewBottom;
  const cellHeight = Math.floor((H - VERTICAL_OVERHEAD - 14 * 2) / 3);

  const card = (pick: OverviewSlideInput['picks'][number]): VNode =>
    el(
      'div',
      {
        style: {
          width: cellWidth,
          height: cellHeight,
          position: 'relative',
          borderRadius: 10,
          overflow: 'hidden',
          backgroundColor: NOIR2,
          display: 'flex',
        },
      },
      el('img', {
        src: pick.imageUrl,
        width: cellWidth,
        height: cellHeight,
        style: {
          position: 'absolute',
          top: 0,
          left: 0,
          width: cellWidth,
          height: cellHeight,
          objectFit: 'cover',
        },
      }),
      // Onder-gradient voor leesbaarheid
      el('div', {
        style: {
          position: 'absolute',
          top: 0,
          left: 0,
          width: cellWidth,
          height: cellHeight,
          background:
            'linear-gradient(to bottom, transparent 45%, rgba(10,10,11,0.9) 100%)',
        },
      }),
      // Tekst-overlay onderaan
      el(
        'div',
        {
          style: {
            position: 'absolute',
            left: 16,
            right: 16,
            bottom: 16,
            display: 'flex',
            flexDirection: 'column',
          },
        },
        el(
          'div',
          {
            style: {
              color: ACID,
              fontSize: 27,
              fontWeight: 700,
              letterSpacing: 2,
              textTransform: 'uppercase',
              marginBottom: 6,
            },
          },
          formatDateNl(pick.startsAt),
        ),
        el(
          'div',
          {
            style: {
              color: INK,
              fontSize: 40,
              fontWeight: 800,
              lineHeight: 1.04,
              letterSpacing: -0.8,
              display: 'flex',
              textShadow: '0 2px 10px rgba(0,0,0,0.8)',
              // Satori heeft beperkte line-clamp support; we kappen op
              // de data-laag indien titel > 40 chars (kortere strings
              // bij grotere font om wrap netjes te houden).
            },
          },
          pick.title.length > 40 ? pick.title.slice(0, 37) + '…' : pick.title,
        ),
      ),
    );

  const row = (start: number): VNode =>
    el(
      'div',
      { style: { display: 'flex', gap: 14, marginBottom: 14 } },
      card(input.picks[start]),
      input.picks[start + 1] ? card(input.picks[start + 1]) : null,
    );

  return el(
    'div',
    {
      style: {
        width: W,
        height: H,
        backgroundColor: NOIR,
        display: 'flex',
        flexDirection: 'column',
        padding: `${p.overviewTop}px ${p.overviewSide}px ${p.overviewBottom}px`,
        fontFamily: 'Archivo',
      },
    },
    // Header
    el(
      'div',
      {
        style: {
          color: INK,
          fontSize: 36,
          fontWeight: 900,
          letterSpacing: 5,
          textTransform: 'uppercase',
          textAlign: 'center',
          marginBottom: 30,
          display: 'flex',
          justifyContent: 'center',
        },
      },
      el('span', { style: { color: INK } }, 'Andreas'),
      el('span', { style: { color: ACID } }, 'X'),
      el('span', { style: { color: INK } }, input.themeKicker),
    ),
    row(0),
    row(2),
    input.picks[4] ? row(4) : null,
  );
}

export function outroSlide(format?: SlideFormat): VNode {
  const { W, H } = dims(format);
  return el(
    'div',
    {
      style: {
        width: W,
        height: H,
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
        'Meer Amsterdam in de app.'
      ),
      el(
        'div',
        {
          style: {
            fontSize: 36,
            fontWeight: 500,
            color: INK,
            marginTop: 8,
          },
        },
        '@andreas_amsterdam'
      )
    )
  );
}
