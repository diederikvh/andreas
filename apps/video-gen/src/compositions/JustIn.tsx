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
// JustIn = nieuws-vibe. Stroboscopisch, hard, urgent. Geen "X dagen
// geleden" pills, geen aftiteling, geen big-number-counter. Pure flash
// van wat-er-vers-is-in-Amsterdam.

const pickSchema = z.object({
  imageUrl: z.string().url(),
  title: z.string(),
  venueName: z.string(),
  category: z.string(),
  /** Wanneer het event is — "za 22 aug" of "22 aug" zoals
      we elders gebruiken. */
  dateLabel: z.string(),
  daysAgo: z.number().int().min(0),
});

export const justInSchema = z.object({
  totalNewCount: z.number().int().min(1),
  hook: z.string().optional(),
  /** Optioneel pad (vanaf `public/`) naar een mp3 die als achtergrond-
      muziek meeloopt. Bv. "audio/justin.mp3". Leeg = geen audio. */
  audio: z.string().optional(),
  picks: z.array(pickSchema).length(6),
});

export type JustInPick = z.infer<typeof pickSchema>;
export type JustInProps = z.infer<typeof justInSchema>;

// ─── Tokens ──────────────────────────────────────────────────────────────

const NOIR = '#0a0a0b';
const INK = '#f2f2ef';
const ACID = '#d4ff3a';
const FONT_BODY =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';

// ─── Frame-budget ────────────────────────────────────────────────────────
// ~16s totaal @ 30fps:
//   Intro:    45f (1.5s) stroboscopische headline
//   6 × Slide: 54f elk (1.8s) — stroboscoop-cuts
//   Overview: 120f (4s) — alle 6 tegelijk + "Bewaar voor later"

export const JUSTIN_INTRO_FRAMES = 45;
export const JUSTIN_SLIDE_FRAMES = 54;
export const JUSTIN_OUTRO_FRAMES = 240;

// Witte flash van 3 frames tussen segmenten. Korter dan een knip-
// per-knipoog → voelt als een lichtflits, niet als zwart kader.
const FLASH_FRAMES = 3;

// ─── Helpers ─────────────────────────────────────────────────────────────

function easeOut(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

// Strobe: pulserende waarde tussen lo/hi met `period` als duur in
// frames. Bv. flicker(frame, 6, 0.4, 1) → 6f-periode tussen 0.4 en 1.
function flicker(frame: number, period: number, lo: number, hi: number) {
  return frame % period < period / 2 ? hi : lo;
}

// ─── Stroboscope-intro ───────────────────────────────────────────────────

const Intro: React.FC<{ picks: JustInPick[] }> = ({ picks }) => {
  const frame = useCurrentFrame();

  // BG: snel wisselen tussen pick-images om "iets-gebeurt"-gevoel te
  // geven. Elke 8 frames een andere image.
  const bgIdx = Math.floor(frame / 8) % picks.length;
  const bg = picks[bgIdx]?.imageUrl;

  // Image-flicker: elke 3 frames opacity tussen 0.6 en 1.0 → strobe-
  // effect zonder helemaal zwart te flitsen.
  const imgOpacity = flicker(frame, 3, 0.65, 1);

  // Tekst staat vanaf frame 0 op z'n plek, geen slam-in. Knippert wel
  // even tussen frame 8-22 voor stroboscope-vibe.
  const textFlicker =
    frame >= 8 && frame <= 22 ? flicker(frame, 4, 0.3, 1) : 1;

  // Fade naar slide 1 vanaf frame 36 (laatste 9f).
  const outProgress = interpolate(
    frame,
    [JUSTIN_INTRO_FRAMES - 9, JUSTIN_INTRO_FRAMES],
    [0, 1],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );
  const outOpacity = 1 - outProgress;

  // RGB-split shake — twee opvolgende lagen met lichte horizontal offset
  // in acid/flare-tinten. Geeft een nieuws-glitch vibe.
  const shakeX = flicker(frame, 6, -3, 3);

  return (
    <AbsoluteFill style={{ backgroundColor: NOIR, opacity: outOpacity }}>
      {bg && (
        <AbsoluteFill style={{ opacity: imgOpacity }}>
          <Img
            src={bg}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              transform: `translateX(${shakeX}px) scale(1.05)`,
            }}
          />
        </AbsoluteFill>
      )}
      {/* Sterke noir-dim — hook moet altijd leesbaar zijn */}
      <AbsoluteFill style={{ backgroundColor: 'rgba(10,10,11,0.65)' }} />

      {/* Drie-regelig brand-block — alles dezelfde grootte/gewicht:
            Nieuwste aanwinst  (wit)
            X                  (acid, gewone letter)
            Andreas            (wit)
       */}
      <AbsoluteFill
        style={{
          justifyContent: 'center',
          alignItems: 'center',
          padding: '0 80px',
          opacity: textFlicker,
          textShadow: '0 6px 32px rgba(0,0,0,0.85)',
          fontFamily: FONT_BODY,
          fontWeight: 900,
          fontSize: 96,
          lineHeight: 1.0,
          letterSpacing: -2.5,
          textAlign: 'center',
        }}
      >
        <div style={{ color: INK }}>
          Nieuw op
          <br />
          de agenda
          <br />
          van Amsterdam
        </div>
        <div
          style={{
            backgroundColor: ACID,
            color: NOIR,
            fontSize: 32,
            fontWeight: 700,
            letterSpacing: 5,
            textTransform: 'uppercase',
            padding: '10px 22px',
            borderRadius: 6,
            marginTop: 36,
            textShadow: 'none',
          }}
        >
          Andreas
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ─── Stroboscope-slide ───────────────────────────────────────────────────

const Slide: React.FC<{ pick: JustInPick; index: number; isLast: boolean }> = ({
  pick,
  isLast,
}) => {
  const frame = useCurrentFrame();

  // Eerste 3 frames: witte/acid-flash bovenop het beeld als hard "knal"-
  // moment dat de slide aankondigt.
  const flashOpacity =
    frame < FLASH_FRAMES ? 1 - frame / FLASH_FRAMES : 0;

  // Image: meteen vol, subtiele camera-shake gedurende de hele slide.
  const shakeX = flicker(frame, 8, -2, 2);
  const shakeY = flicker(frame + 4, 12, -1.5, 1.5);
  const imgScale = interpolate(frame, [0, JUSTIN_SLIDE_FRAMES], [1.04, 1.10]);

  // Text: harde "stamp"-in zonder fade, met 4f flicker erna.
  const textStampIn = frame < 4 ? 0 : 1;
  const textFlicker =
    frame >= 4 && frame <= 14 ? flicker(frame, 3, 0.5, 1) : 1;

  // Slide-out fade aan eind — alleen als 't niet de laatste is, want
  // de video stopt op de laatste slide.
  const outStart = JUSTIN_SLIDE_FRAMES - 6;
  const outProgress = isLast
    ? 0
    : frame < outStart
      ? 0
      : Math.min((frame - outStart) / 6, 1);
  const outOpacity = 1 - outProgress;

  return (
    <AbsoluteFill style={{ backgroundColor: NOIR, opacity: outOpacity }}>
      <AbsoluteFill>
        <Img
          src={pick.imageUrl}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            transform: `translate(${shakeX}px, ${shakeY}px) scale(${imgScale})`,
          }}
        />
      </AbsoluteFill>
      <AbsoluteFill
        style={{
          background:
            'linear-gradient(to bottom, transparent 30%, rgba(10,10,11,0.5) 60%, rgba(10,10,11,0.95) 100%)',
        }}
      />

      {/* Acid flash bij begin slide */}
      {flashOpacity > 0 && (
        <AbsoluteFill
          style={{
            backgroundColor: ACID,
            opacity: flashOpacity,
            mixBlendMode: 'screen',
          }}
        />
      )}

      {/* Body onderaan, hard ge-stamp'd, met flicker */}
      <div
        style={{
          position: 'absolute',
          left: 100,
          right: 100,
          bottom: 340,
          opacity: textStampIn * textFlicker,
          textShadow: '0 2px 16px rgba(0,0,0,0.6)',
        }}
      >
        <div
          style={{
            color: ACID,
            fontFamily: FONT_BODY,
            fontWeight: 700,
            fontSize: 26,
            letterSpacing: 3,
            textTransform: 'uppercase',
            marginBottom: 14,
          }}
        >
          {pick.category} · {pick.dateLabel}
        </div>
        <div
          style={{
            color: INK,
            fontFamily: FONT_BODY,
            fontWeight: 800,
            fontSize: 76,
            lineHeight: 1.04,
            letterSpacing: -1.5,
            marginBottom: 14,
          }}
        >
          {pick.title}
        </div>
        <div
          style={{
            color: INK,
            fontFamily: FONT_BODY,
            fontWeight: 700,
            fontSize: 38,
            letterSpacing: -0.5,
          }}
        >
          {pick.venueName}
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ─── Overview (laatste slide met alle 6 thumbnails) ─────────────────────

const Overview: React.FC<{ picks: JustInPick[] }> = ({ picks }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Header fadet rustig in.
  const inOpacity = Math.min(frame / 8, 1);

  // Per-cell stagger + bounce. spring() geeft een natuurlijke overshoot
  // → "stuiter"-vibe i.p.v. saaie fade.
  const cellSpring = (i: number) =>
    spring({
      frame: frame - i * 4,
      fps,
      config: { damping: 9, mass: 0.7, stiffness: 110 },
    });

  // Continue 'breathing' — elke cell oscilleert zachtjes in y na de
  // intro. Verschillende fase per cell zodat ze niet synchroon bewegen.
  const breathY = (i: number) => {
    const t = frame / fps;
    return Math.sin(t * 1.6 + i * 0.9) * 3;
  };

  return (
    <AbsoluteFill style={{ backgroundColor: NOIR }}>
      {/* Brand-header: ANDREAS (wit) · X (acid) · NIEUW (wit). Top 240
          zodat 'ie binnen IG Reels' top safe-area valt (geen overlap
          met profile-overlay). */}
      <div
        style={{
          position: 'absolute',
          top: 240,
          left: 0,
          right: 0,
          textAlign: 'center',
          fontFamily: FONT_BODY,
          fontWeight: 900,
          fontSize: 34,
          letterSpacing: 4,
          textTransform: 'uppercase',
          opacity: inOpacity,
        }}
      >
        <span style={{ color: INK }}>Andreas</span>
        <span style={{ color: ACID }}>X</span>
        <span style={{ color: INK }}>Nieuw</span>
      </div>

      {/* Grid 2×3 — cells vierkant + breder gepad (120) zodat 't hele
          grid binnen Reels' bottom safe-area (340px) blijft. */}
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
                    opacity: Math.min(cellSpring(idx), 1),
                    transform: `translateY(${
                      (1 - cellSpring(idx)) * 36 + breathY(idx)
                    }px)`,
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
                  {/* Gradient + tekst-overlay linksonder IN de image,
                      zelfde patroon als de individuele slides maar dan
                      compact. */}
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
                    <div
                      style={{
                        color: ACID,
                        fontFamily: FONT_BODY,
                        fontWeight: 700,
                        fontSize: 24,
                        letterSpacing: 2,
                        textTransform: 'uppercase',
                        marginBottom: 6,
                      }}
                    >
                      {pick.dateLabel}
                    </div>
                    <div
                      style={{
                        color: INK,
                        fontFamily: FONT_BODY,
                        fontWeight: 700,
                        fontSize: 45,
                        lineHeight: 1.08,
                        letterSpacing: -0.8,
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                        textShadow: '0 2px 10px rgba(0,0,0,0.8)',
                      }}
                    >
                      {pick.title}
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

export const JustIn: React.FC<JustInProps> = ({ picks, audio }) => {
  const slidesStart = JUSTIN_INTRO_FRAMES - FLASH_FRAMES; // overlap met flash
  const overviewStart = slidesStart + picks.length * JUSTIN_SLIDE_FRAMES;
  return (
    <AbsoluteFill style={{ backgroundColor: NOIR }}>
      {/* React-versie mismatch tussen Remotion's interne types en de
          app-types geeft een JSX-error op <Audio>; cast als any om
          door de typecheck te komen — de component werkt runtime. */}
      {audio && (() => {
        const A = Audio as unknown as React.FC<{ src: string; volume?: number }>;
        return <A src={staticFile(audio)} volume={0.6} />;
      })()}
      <Sequence from={0} durationInFrames={JUSTIN_INTRO_FRAMES} name="Intro">
        <Intro picks={picks} />
      </Sequence>
      {picks.map((pick, i) => (
        <Sequence
          key={i}
          from={slidesStart + i * JUSTIN_SLIDE_FRAMES}
          durationInFrames={JUSTIN_SLIDE_FRAMES}
          name={`Slide ${i + 1}: ${pick.title}`}
        >
          <Slide pick={pick} index={i} isLast={false} />
        </Sequence>
      ))}
      <Sequence
        from={overviewStart}
        durationInFrames={JUSTIN_OUTRO_FRAMES}
        name="Overview"
      >
        <Overview picks={picks} />
      </Sequence>
    </AbsoluteFill>
  );
};
