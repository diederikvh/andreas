import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { z } from 'zod';

// ─── Schema ──────────────────────────────────────────────────────────────
// Eén Pick = 1 slide met hero-foto, titel, venue, datum, tijd.
// Zelfde shape als CarouselPick in api/social/render.ts zodat we de
// bestaande generator-output 1-op-1 kunnen voeden zonder transform.

const pickSchema = z.object({
  imageUrl: z.string().url(),
  title: z.string(),
  venueName: z.string(),
  dateLabel: z.string(), // "do 12 sep"
  timeLabel: z.string(), // "21:00"
});

const hookUnitSchema = z.object({
  role: z.enum(['eyebrow', 'countLead', 'count', 'headline', 'meta']),
  text: z.string(),
});

export const dailyFilms5Schema = z.object({
  themeKicker: z.string(), // "Film" — kleine pill onder elke slide
  themeTitle: z.string(), // legacy, optional
  hook: z.string().optional(), // legacy platte string — fallback voor preview
  hookUnits: z.array(hookUnitSchema).optional(),
  overviewTitle: z.string().optional(), // titel boven Overview-slide
  audio: z.string().optional(), // bv. "audio/daily.mp3"
  picks: z.array(pickSchema).length(6),
});

export type Pick = z.infer<typeof pickSchema>;
export type HookUnit = z.infer<typeof hookUnitSchema>;
export type DailyFilms5Props = z.infer<typeof dailyFilms5Schema>;

// ─── Tokens ──────────────────────────────────────────────────────────────

const NOIR = '#0a0a0b';
const INK = '#f2f2ef';
const INK_MUTED = '#9a9a94';
const ACID = '#d4ff3a';

const FONT_BODY =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';

// ─── Slide-segmenten ─────────────────────────────────────────────────────
// Elke slide krijgt 90 frames (3s @30fps): 12f intro (slide-in van rechts
// + fade), 66f hold, 12f outro (fade + scale-out naar links). De volgende
// slide overlapt 6f met de outro voor een vloeiende handoff zonder zwart
// frame ertussen.

const SLIDE_FRAMES = 90;
const SLIDE_IN_FRAMES = 12;
const SLIDE_OUT_FRAMES = 12;
const SLIDE_OVERLAP = 6;
const INTRO_FRAMES = 60; // 2s intro met hero + hook
export const OUTRO_FRAMES = 180; // 6s overzicht aan einde

// ─── Helpers ─────────────────────────────────────────────────────────────

function easeOut(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

// ─── Subcomponents ───────────────────────────────────────────────────────

// Intro — image-led cover met gecentreerde, getypeerde hook. Elke
// HookUnit (eyebrow/count/headline/meta) krijgt zijn eigen styling
// zodat de belofte structureel zichtbaar is: categorie → getal →
// onderwerp → plek/tijd. Count wordt door fetchDailyFilms5Props al
// gelijkgesteld aan picks.length zodat de belofte klopt. Op het
// einde fadet 'ie naar de eerste slide.
const Intro: React.FC<{
  hookUnits: HookUnit[];
  themeKicker: string;
  picks: Pick[];
}> = ({ hookUnits, themeKicker, picks }) => {
  const frame = useCurrentFrame();

  // Tekst slidet weg naar links. Image niet — die crossfadet onder
  // slide 1 vandaan (slide 1 is al isFirst=vol-opacity, dus zodra de
  // intro-image fade-out start zie je slide 1 doorkomen).
  const outStart = INTRO_FRAMES - SLIDE_OUT_FRAMES;
  const outProgress =
    frame < outStart ? 0 : Math.min((frame - outStart) / SLIDE_OUT_FRAMES, 1);
  const outEase = easeOut(outProgress);
  // 160px = identiek aan de title-slide-out tussen de gewone slides, zo
  // voelt de overgang dezelfde snelheid en easing-curve.
  const slideX = -outEase * 160;
  // Image-fade start iets eerder dan de tekst-slide om een rustigere
  // overgang te geven (16f → ~530ms).
  const imageFadeStart = INTRO_FRAMES - 16;
  const imageFadeProgress =
    frame < imageFadeStart ? 0 : Math.min((frame - imageFadeStart) / 16, 1);
  const imageOpacity = 1 - easeOut(imageFadeProgress);

  // Subtiele zoom-in zodat 'ie levend voelt.
  const imgScale = interpolate(frame, [0, INTRO_FRAMES], [1.08, 1.18]);

  // Andere image dan slide 1, anders is de handoff een 'gekke' cross-fade
  // van dezelfde foto. We pakken liefst de laatste pick — middendomeinen
  // tonen in de intro vermijdt herhaling met slide 1.
  const bgImage =
    picks[picks.length - 1]?.imageUrl ?? picks[0]?.imageUrl;

  return (
    <AbsoluteFill style={{ backgroundColor: NOIR }}>
      {bgImage && (
        <AbsoluteFill style={{ opacity: imageOpacity }}>
          <Img
            src={bgImage}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              transform: `scale(${imgScale})`,
              transformOrigin: 'center',
            }}
          />
        </AbsoluteFill>
      )}
      {/* Sterke dim — hook moet altijd leesbaar zijn ongeacht hero.
          Fadet mee met de image zodat slide 1's eigen dim niet wordt
          gestapeld. */}
      <AbsoluteFill
        style={{
          backgroundColor: 'rgba(10,10,11,0.55)',
          opacity: imageOpacity,
        }}
      />
      <AbsoluteFill
        style={{
          background:
            'linear-gradient(to bottom, rgba(10,10,11,0.4) 0%, rgba(10,10,11,0.1) 50%, rgba(10,10,11,0.6) 100%)',
          opacity: imageOpacity,
        }}
      />

      {/* Centraal blok — getypeerde hook-units. Per rol een eigen
          visuele weight zodat de belofte (categorie → getal → onderwerp
          → plek/tijd) gestructureerd leest. Slidet weg én fadet uit,
          parallel met de image-cross-fade naar slide 1. */}
      <AbsoluteFill
        style={{
          justifyContent: 'center',
          alignItems: 'center',
          padding: '0 100px',
          transform: `translateX(${slideX}px)`,
          opacity: 1 - outEase,
        }}
      >
        {renderHookStack(hookUnits)}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// Render de hook-stack. Detecteert eyebrow → countLead-paren en
// rendert die als één twee-kleuren-blok (noir-pill + wit-pill tegen
// elkaar aan, gedeelde border-radius). Andere units gaan via HookUnitView.
function renderHookStack(units: HookUnit[]): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const next = units[i + 1];
    if (u.role === 'eyebrow' && next?.role === 'countLead') {
      // Visuele volgorde: acid-cel (categorie) links, noir-cel (TOP/getal)
      // rechts — eyebrow krijgt dus de left-slot, countLead de right.
      // Bv. [FILM (acid bg, noir text)][TOP (noir bg, acid text)].
      nodes.push(
        <LabelPair key={`pg-${i}`} left={u.text} right={next.text} />,
      );
      i++; // skip de countLead want al gerenderd
      continue;
    }
    nodes.push(<HookUnitView key={`${u.role}-${i}`} unit={u} />);
  }
  return nodes;
}

// Twee-kleuren-blok: linker cel NOIR/INK, rechter cel ACID/NOIR, gedeelde
// 4px border-radius via overflow-hidden container, één gedeelde shadow.
// Voelt als één label dat uit twee kleuren bestaat. Hergebruikt door
// intro (eyebrow + TOP) én slides (themeKicker + slide-nummer).
const LabelPair: React.FC<{
  left: string;
  right: string;
  fontSize?: number;
  marginBottom?: number;
}> = ({ left, right, fontSize = 36, marginBottom = 36 }) => {
  const padY = Math.round(fontSize / 3);
  const padX = Math.round(fontSize * 0.72);
  // Extra padding aan de afgeronde buitenkant compenseert visuele
  // ruimte die de rounding "afsnoept".
  const extraRound = Math.round(fontSize / 4);
  const cellBase: React.CSSProperties = {
    fontFamily: FONT_BODY,
    fontSize,
    letterSpacing: 1,
    textTransform: 'uppercase',
  };
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        borderRadius: 999,
        overflow: 'hidden',
        marginBottom,
      }}
    >
      <div
        style={{
          ...cellBase,
          padding: `${padY}px ${padX}px ${padY}px ${padX + extraRound}px`,
          backgroundColor: ACID,
          color: NOIR,
          fontWeight: 700,
        }}
      >
        {left}
      </div>
      <div
        style={{
          ...cellBase,
          padding: `${padY}px ${padX + extraRound}px ${padY}px ${padX}px`,
          backgroundColor: NOIR,
          color: ACID,
          fontWeight: 700,
        }}
      >
        {right}
      </div>
    </div>
  );
};

// Per-rol styling voor één hook-unit. Layout: vertical stack, alles
// horizontaal gecentreerd.
//
//  - eyebrow  → pill (achtergrond-card) zodat de categorie als duidelijk
//              label leest, los van de zin eronder.
//  - count    → enorm/wit/dominant — het "wat krijg je"-getal.
//  - headline → groot, leesbaar als zin (700-gewicht, royale line-height).
//  - meta     → kleinere variant van headline (zelfde kleur/gewicht,
//              alleen kleiner) — geen gedempt-grijs meer, blijft mee-
//              spelen met de belofte.
const HookUnitView: React.FC<{ unit: HookUnit }> = ({ unit }) => {
  switch (unit.role) {
    case 'eyebrow':
      return (
        <div
          style={{
            backgroundColor: NOIR,
            color: INK,
            fontFamily: FONT_BODY,
            fontWeight: 700,
            fontSize: 36,
            letterSpacing: 1,
            textTransform: 'uppercase',
            padding: '12px 26px',
            borderRadius: 999,
            marginBottom: 36,
                      }}
        >
          {unit.text}
        </div>
      );
    case 'countLead':
      // Stand-alone fallback — wordt normaal door LabelPair tegen de
      // eyebrow-pill aan getekend. Deze tak wordt alleen geraakt als
      // er een countLead zonder voorafgaande eyebrow staat.
      return (
        <div
          style={{
            backgroundColor: ACID,
            color: NOIR,
            fontFamily: FONT_BODY,
            fontWeight: 700,
            fontSize: 36,
            letterSpacing: 1,
            textTransform: 'uppercase',
            padding: '12px 26px',
            borderRadius: 999,
            marginBottom: 36,
                      }}
        >
          {unit.text}
        </div>
      );
    case 'count':
      return (
        <div
          style={{
            color: INK,
            fontFamily: FONT_BODY,
            fontWeight: 900,
            fontSize: 240,
            lineHeight: 0.88,
            letterSpacing: -10,
            textAlign: 'center',
            marginBottom: 12,
            textShadow: '0 6px 28px rgba(0,0,0,0.85)',
          }}
        >
          {unit.text}
        </div>
      );
    case 'headline':
      return (
        <div
          style={{
            color: INK,
            fontFamily: FONT_BODY,
            fontWeight: 700,
            fontSize: 108,
            lineHeight: 1.04,
            letterSpacing: -2,
            textAlign: 'center',
            marginBottom: 32,
            textShadow: '0 4px 20px rgba(0,0,0,0.8)',
            maxWidth: 900,
          }}
        >
          {unit.text}
        </div>
      );
    case 'meta':
      return (
        <div
          style={{
            color: ACID,
            fontFamily: FONT_BODY,
            fontWeight: 600,
            fontSize: 54,
            lineHeight: 1.15,
            letterSpacing: -0.5,
            textAlign: 'center',
            textShadow: '0 3px 14px rgba(0,0,0,0.75)',
            whiteSpace: 'pre-line',
          }}
        >
          {unit.text}
        </div>
      );
    default:
      return null;
  }
};

const Slide: React.FC<{
  pick: Pick;
  index: number;
  total: number;
  isLast: boolean;
  themeKicker: string;
}> = ({ pick, index, total, isLast, themeKicker }) => {
  const frame = useCurrentFrame();
  // Iedere slide — ook de eerste — fadet in. De intro fadet onder de
  // eerste slide uit; zonder eigen fade-in zou de cut te hard zijn.
  const inProgress = Math.min(frame / SLIDE_IN_FRAMES, 1);
  const outStart = SLIDE_FRAMES - SLIDE_OUT_FRAMES;
  const outProgress = isLast
    ? 0
    : frame < outStart
      ? 0
      : Math.min((frame - outStart) / SLIDE_OUT_FRAMES, 1);

  const inEase = easeOut(inProgress);
  const outEase = easeOut(outProgress);

  // Image: cross-fade + heel subtiele scale (Ken Burns).
  const imgScale = interpolate(frame, [0, SLIDE_FRAMES], [1.04, 1.12]);
  const imgOpacity = interpolate(inEase, [0, 1], [0, 1]) * (1 - outEase);

  // Title slide-in van rechts, slide-out naar links.
  const titleX = (1 - inEase) * 160 - outEase * 160;
  const titleOpacity = inEase * (1 - outEase);

  return (
    <AbsoluteFill style={{ backgroundColor: NOIR }}>
      {/* Hero-image — fullbleed */}
      <AbsoluteFill style={{ opacity: imgOpacity }}>
        <Img
          src={pick.imageUrl}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            transform: `scale(${imgScale})`,
            transformOrigin: 'center',
          }}
        />
      </AbsoluteFill>

      {/* Geleidelijke fade van halverwege → onder, drie-stop voor een
          natuurlijke curve i.p.v. een harde overgang. Niet meer een
          zwart vlak, wel duidelijk zichtbaar leesbaarheidsverloop. */}
      <AbsoluteFill
        style={{
          background:
            'linear-gradient(to bottom, transparent 30%, rgba(10,10,11,0.5) 60%, rgba(10,10,11,0.95) 100%)',
        }}
      />

      {/* Body — binnen IG Reels' bottom safe-area (~340px). Twee-kleuren-
          label (themeKicker + slide-nummer) zodat de slide visueel in de
          serie zit, gevolgd door datum/tijd + titel + venue als één blok. */}
      <div
        style={{
          position: 'absolute',
          left: 100,
          right: 100,
          bottom: 340,
          opacity: titleOpacity,
          transform: `translateX(${titleX}px)`,
          textShadow: '0 2px 16px rgba(0,0,0,0.6)',
        }}
      >
        {/* Twee-kleuren-label: noir-cel themeKicker, acid-cel slide-nummer.
            Zelfde stijl als intro maar iets kleiner zodat 't niet
            concurreert met de titel eronder. textShadow weg — pill heeft
            eigen background. */}
        <div
          style={{
            display: 'flex',
            marginBottom: 28,
            textShadow: 'none',
          }}
        >
          <LabelPair
            left={themeKicker.toUpperCase()}
            right={String(total - index)}
            fontSize={30}
            marginBottom={0}
          />
        </div>
        {/* Volgorde: title → venue → datum. Venue en datum dezelfde
            maat/gewicht; alleen kleur verschilt (venue wit, datum acid). */}
        <div
          style={{
            color: INK,
            fontFamily: FONT_BODY,
            fontWeight: 800,
            fontSize: 82,
            lineHeight: 1.05,
            letterSpacing: -1.5,
            marginBottom: 18,
          }}
        >
          {pick.title}
        </div>
        <div
          style={{
            color: INK,
            fontFamily: FONT_BODY,
            fontWeight: 700,
            fontSize: 44,
            letterSpacing: -0.5,
            marginBottom: 8,
          }}
        >
          {pick.venueName}
        </div>
        <div
          style={{
            color: ACID,
            fontFamily: FONT_BODY,
            fontWeight: 700,
            fontSize: 44,
            letterSpacing: -0.5,
          }}
        >
          {pick.dateLabel}
        </div>
      </div>
    </AbsoluteFill>
  );
};

const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const fadeIn = spring({ frame, fps, config: { damping: 18 } });
  const ctaY = spring({ frame: frame - 10, fps, config: { damping: 20 } });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: NOIR,
        justifyContent: 'center',
        alignItems: 'center',
        gap: 60,
      }}
    >
      <Cross size={220} style={{ opacity: fadeIn }} />
      <div
        style={{
          color: ACID,
          fontFamily: FONT_BODY,
          fontWeight: 700,
          fontSize: 36,
          letterSpacing: 4,
          textTransform: 'uppercase',
          opacity: ctaY,
          transform: `translateY(${(1 - ctaY) * 24}px)`,
        }}
      >
        Open Andreas
      </div>
      <div
        style={{
          color: INK_MUTED,
          fontFamily: FONT_BODY,
          fontSize: 28,
          letterSpacing: 1,
          opacity: ctaY,
        }}
      >
        andreas.amsterdam
      </div>
    </AbsoluteFill>
  );
};

// View-based Andreas-kruis — twee gedraaide rechthoeken in acid.
const Cross: React.FC<{ size: number; style?: React.CSSProperties }> = ({
  size,
  style,
}) => {
  const bar = {
    position: 'absolute' as const,
    width: size * 0.18,
    height: size,
    backgroundColor: ACID,
    borderRadius: size * 0.04,
    top: 0,
    left: size / 2 - (size * 0.18) / 2,
  };
  return (
    <div
      style={{
        position: 'relative',
        width: size,
        height: size,
        ...style,
      }}
    >
      <div style={{ ...bar, transform: 'rotate(45deg)' }} />
      <div style={{ ...bar, transform: 'rotate(-45deg)' }} />
    </div>
  );
};

// ─── Overview (laatste slide met alle 6 thumbnails) ─────────────────────
// Smooth fade-in, geen stroboscope. Stijl matched de gewone slides:
// rustige spring + lichte stagger zonder bounce. Header is
// "Andreas X <ThemeKicker>" zonder spaties rond de X.

const Overview: React.FC<{
  picks: Pick[];
  themeKicker: string;
  title?: string;
}> = ({ picks, themeKicker, title }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const headerOpacity = Math.min(frame / 10, 1);
  // Per-cell smooth spring met lichte stagger (3f delay), geen bounce.
  const cellSpring = (i: number) =>
    spring({
      frame: frame - i * 3,
      fps,
      config: { damping: 18, mass: 0.6, stiffness: 140 },
    });

  // Header: vrije titel (bv. "Top 6 films deze week") als gegeven,
  // anders fallback op "Andreas X <ThemeKicker>".
  const headerText = title ?? null;

  return (
    <AbsoluteFill style={{ backgroundColor: NOIR }}>
      <div
        style={{
          position: 'absolute',
          top: 220,
          left: 80,
          right: 80,
          textAlign: 'center',
          fontFamily: FONT_BODY,
          opacity: headerOpacity,
        }}
      >
        {headerText ? (
          <div
            style={{
              color: INK,
              fontWeight: 800,
              fontSize: 54,
              lineHeight: 1.1,
              letterSpacing: -1,
            }}
          >
            {headerText}
          </div>
        ) : (
          <div
            style={{
              fontWeight: 900,
              fontSize: 34,
              letterSpacing: 4,
              textTransform: 'uppercase',
            }}
          >
            <span style={{ color: INK }}>Andreas</span>
            <span style={{ color: ACID }}>X</span>
            <span style={{ color: INK }}>{themeKicker}</span>
          </div>
        )}
      </div>

      {/* Grid 2×3 — cells vierkant + side-pad 120 zodat 't binnen
          IG Reels' safe-area past (geen overlap met UI overlays). */}
      <div
        style={{
          position: 'absolute',
          top: 300,
          left: 120,
          right: 120,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        {[0, 1, 2].map((row) => (
          <div key={row} style={{ display: 'flex', gap: 16 }}>
            {[0, 1].map((col) => {
              const idx = row * 2 + col;
              const pick = picks[idx];
              if (!pick) return null;
              const s = cellSpring(idx);
              return (
                <div
                  key={col}
                  style={{
                    flex: 1,
                    position: 'relative',
                    aspectRatio: '1 / 1',
                    overflow: 'hidden',
                    borderRadius: 10,
                    backgroundColor: '#1a1a1d',
                    opacity: Math.min(s, 1),
                    transform: `translateY(${(1 - s) * 24}px)`,
                  }}
                >
                  <Img
                    src={pick.imageUrl}
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                    }}
                  />
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      background:
                        'linear-gradient(to bottom, transparent 45%, rgba(10,10,11,0.85) 100%)',
                    }}
                  />
                  <div
                    style={{
                      position: 'absolute',
                      left: 18,
                      right: 18,
                      bottom: 18,
                    }}
                  >
                    {/* Volgorde: titel → venue → datum. Matched de
                        event-slide layout zodat overview en slides
                        één visueel ritme volgen. */}
                    <div
                      style={{
                        color: INK,
                        fontFamily: FONT_BODY,
                        fontWeight: 700,
                        fontSize: 42,
                        lineHeight: 1.06,
                        letterSpacing: -0.8,
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                        textShadow: '0 2px 10px rgba(0,0,0,0.8)',
                        marginBottom: 6,
                      }}
                    >
                      {pick.title}
                    </div>
                    <div
                      style={{
                        color: INK,
                        fontFamily: FONT_BODY,
                        fontWeight: 700,
                        fontSize: 26,
                        letterSpacing: -0.2,
                        textShadow: '0 2px 8px rgba(0,0,0,0.7)',
                        display: '-webkit-box',
                        WebkitLineClamp: 1,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                        marginBottom: 4,
                      }}
                    >
                      {pick.venueName}
                    </div>
                    <div
                      style={{
                        color: ACID,
                        fontFamily: FONT_BODY,
                        fontWeight: 700,
                        fontSize: 26,
                        letterSpacing: -0.2,
                        textShadow: '0 2px 8px rgba(0,0,0,0.7)',
                      }}
                    >
                      {pick.dateLabel}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

// ─── Composition ─────────────────────────────────────────────────────────

export const DailyFilms5: React.FC<DailyFilms5Props> = ({
  themeKicker,
  hook,
  hookUnits,
  overviewTitle,
  picks,
  audio,
}) => {
  // Resolved hook-units: directe input > legacy string > minimale
  // fallback uit themeKicker + count. De count-unit krijgt altijd de
  // werkelijke pick-count zodat de belofte klopt met wat volgt.
  const resolvedHookUnits: HookUnit[] = (
    hookUnits && hookUnits.length > 0
      ? hookUnits
      : ([
          { role: 'eyebrow', text: themeKicker },
          { role: 'count', text: String(picks.length) },
          { role: 'headline', text: hook ?? 'highlights' },
          { role: 'meta', text: 'Amsterdam' },
        ] as HookUnit[])
  ).map((u) =>
    u.role === 'count' ? { ...u, text: String(picks.length) } : u,
  );
  // Intro overlapt 6 frames met slide 1 zodat 'ie organisch overgaat
  // in de eerste film i.p.v. een harde cut.
  const slidesStart = INTRO_FRAMES - SLIDE_OVERLAP;
  return (
    <AbsoluteFill style={{ backgroundColor: NOIR }}>
      {audio && (() => {
        const A = Audio as unknown as React.FC<{ src: string; volume?: number }>;
        return <A src={staticFile(audio)} volume={0.6} />;
      })()}
      <Sequence from={0} durationInFrames={INTRO_FRAMES} name="Intro">
        <Intro
          hookUnits={resolvedHookUnits}
          themeKicker={themeKicker}
          picks={picks}
        />
      </Sequence>
      {picks.map((pick, i) => {
        const startAt = slidesStart + i * (SLIDE_FRAMES - SLIDE_OVERLAP);
        return (
          <Sequence
            key={i}
            from={startAt}
            durationInFrames={SLIDE_FRAMES}
            name={`Slide ${i + 1}: ${pick.title}`}
          >
            {/* Geen slide is "echt last" meer — Overview komt erna en
                neemt de vol-content over. */}
            <Slide
              pick={pick}
              index={i}
              total={picks.length}
              isLast={false}
              themeKicker={themeKicker}
            />
          </Sequence>
        );
      })}
      <Sequence
        from={slidesStart + picks.length * (SLIDE_FRAMES - SLIDE_OVERLAP)}
        durationInFrames={OUTRO_FRAMES}
        name="Overview"
      >
        <Overview
          picks={picks}
          themeKicker={themeKicker}
          title={overviewTitle}
        />
      </Sequence>
    </AbsoluteFill>
  );
};
