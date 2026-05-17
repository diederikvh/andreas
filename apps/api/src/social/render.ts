import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';

import { satoriFonts } from './fonts.js';
import {
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  coverSlide,
  eventSlide,
  outroSlide,
  type EventSlideInput,
} from './templates.js';

/**
 * Render-pipeline: virtual-DOM tree → SVG (Satori) → PNG (resvg).
 *
 * Eén carousel renderen is sequentieel — Satori is single-threaded en
 * concurrent runs leveren weinig op voor 5 slides. Image-fetches binnen
 * Satori (hero-foto's via URL) gebeuren wél in parallel binnen één
 * `satori()`-call.
 */

export interface CarouselPick {
  imageUrl: string;
  title: string;
  venueName: string;
  category: string;
  venueType: string | null;
  startsAt: Date | string;
  endsAt: Date | string | null;
}

async function renderSlide(tree: unknown): Promise<Buffer> {
  const svg = await satori(tree as Parameters<typeof satori>[0], {
    width: SLIDE_WIDTH,
    height: SLIDE_HEIGHT,
    fonts: satoriFonts as unknown as Parameters<typeof satori>[1]['fonts'],
  });
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: SLIDE_WIDTH },
  })
    .render()
    .asPng();
  return png;
}

export async function renderCarousel(
  picks: CarouselPick[],
  options: { date?: Date; slot?: 'morning' | 'evening' } = {}
): Promise<Buffer[]> {
  const date = options.date ?? new Date();
  if (picks.length === 0) {
    throw new Error('renderCarousel: minstens 1 pick vereist');
  }

  const tagline =
    options.slot === 'evening' ? 'Tips voor vanavond' : 'Tips voor vandaag';

  const slides: Buffer[] = [];

  // Cover — hero-foto van de eerste pick zodat slide 1 → slide 2 visueel bindt
  slides.push(
    await renderSlide(
      coverSlide({
        date,
        pickCount: picks.length,
        heroImageUrl: picks[0]?.imageUrl ?? null,
        tagline,
      })
    )
  );

  // Event-slides
  for (let i = 0; i < picks.length; i++) {
    const pick = picks[i];
    const input: EventSlideInput = {
      imageUrl: pick.imageUrl,
      title: pick.title,
      venueName: pick.venueName,
      category: pick.category,
      venueType: pick.venueType,
      startsAt: typeof pick.startsAt === 'string' ? new Date(pick.startsAt) : pick.startsAt,
      endsAt:
        pick.endsAt == null
          ? null
          : typeof pick.endsAt === 'string'
            ? new Date(pick.endsAt)
            : pick.endsAt,
      index: i + 1,
      total: picks.length,
    };
    slides.push(await renderSlide(eventSlide(input)));
  }

  // Outro
  slides.push(await renderSlide(outroSlide()));

  return slides;
}
