import { Composition } from 'remotion';
import {
  DailyFilms5,
  type DailyFilms5Props,
  dailyFilms5Schema,
  OUTRO_FRAMES as DAILY_OUTRO_FRAMES,
} from './compositions/DailyFilms5';
import {
  JustIn,
  type JustInProps,
  justInSchema,
  JUSTIN_INTRO_FRAMES,
  JUSTIN_SLIDE_FRAMES,
  JUSTIN_OUTRO_FRAMES,
} from './compositions/JustIn';
import sample from './data/sample.json';
import sampleJustin from './data/sample-justin.json';

// Frame-budget: 2s intro + 6 picks van 3s (overlap 6f) + 6s overview.
const FPS = 30;
const INTRO_FRAMES = 60;
const SLIDE_FRAMES = 90;
const SLIDE_OVERLAP = 6;
const SLIDES = 6;

const DURATION =
  INTRO_FRAMES + SLIDES * SLIDE_FRAMES - SLIDES * SLIDE_OVERLAP + DAILY_OUTRO_FRAMES;

// Intro overlapt 3f met slide 1 voor stroboscoop-cut. JustIn heeft nu
// 6 picks + een overview-slide aan het eind (duurde = JUSTIN_OUTRO_FRAMES).
const JUSTIN_SLIDES = 6;
const JUSTIN_DURATION =
  JUSTIN_INTRO_FRAMES + JUSTIN_SLIDES * JUSTIN_SLIDE_FRAMES - 3 + JUSTIN_OUTRO_FRAMES;

export const Root: React.FC = () => {
  return (
    <>
      <Composition
        id="DailyFilms5"
        component={DailyFilms5}
        durationInFrames={DURATION}
        fps={FPS}
        width={1080}
        height={1920}
        defaultProps={sample as DailyFilms5Props}
        schema={dailyFilms5Schema}
      />
      <Composition
        id="JustIn"
        component={JustIn}
        durationInFrames={JUSTIN_DURATION}
        fps={FPS}
        width={1080}
        height={1920}
        defaultProps={sampleJustin as JustInProps}
        schema={justInSchema}
      />
    </>
  );
};
