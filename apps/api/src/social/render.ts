import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';
import sharp from 'sharp';

import { satoriFonts } from './fonts.js';
import {
  FORMATS,
  eventSlide,
  introSlide,
  overviewSlide,
  type EventSlideInput,
  type HookUnit,
  type SlideFormat,
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

async function renderSlide(
  tree: unknown,
  format: SlideFormat = 'ig',
): Promise<Buffer> {
  const { width, height } = FORMATS[format];
  const svg = await satori(tree as Parameters<typeof satori>[0], {
    width,
    height,
    fonts: satoriFonts as unknown as Parameters<typeof satori>[1]['fonts'],
  });
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
  })
    .render()
    .asPng();
  // PNG → JPEG (quality 90) zodat zowel IG als TikTok ze accepteren.
  // TikTok's photo-carousel weigert PNG; IG accepteert beide. JPEG-
  // output is bovendien fors kleiner.
  return await sharp(png).jpeg({ quality: 90, progressive: true }).toBuffer();
}

/**
 * Pre-fetch + converteer naar JPEG data-URL. Satori ondersteunt PNG/
 * JPEG/GIF maar GEEN WebP — veel Bunny-uploads zijn .webp dus zonder
 * deze conversie missen die slides hun hero-image. We doen 't voor
 * álle URLs (idempotent voor jpeg) zodat we niet hoeven raden naar
 * extensions. Bij netwerk-fail fallt 'ie terug op de originele URL
 * (Satori zal er dan z'n eigen ding mee doen).
 */
async function imageToDataUrl(url: string): Promise<string> {
  try {
    const res = await fetch(url);
    if (!res.ok) return url;
    const buf = Buffer.from(await res.arrayBuffer());
    const jpeg = await sharp(buf).jpeg({ quality: 88 }).toBuffer();
    return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  } catch {
    return url;
  }
}

export async function renderCarousel(
  picks: CarouselPick[],
  options: {
    date?: Date;
    /** Hoofdlabel van het dag-thema, bv. "Theater" of "Live muziek".
        Rendert als kleine acid-kicker top-left op elke event-slide. */
    themeLabel?: string;
    /** Subtekst onder de themeLabel, bv. "Komende 7 dagen". */
    windowLabel?: string;
    /** Hook-zin voor de intro-slide. Default: themeLabel of "Vandaag in Amsterdam".
        Wordt alleen gebruikt als `hookUnits` niet is gegeven. */
    hook?: string;
    /** Gestructureerde hook-units (eyebrow/countLead/count/headline/meta).
        Matched de Remotion-video — labelPair + grote count + zin + tijd. */
    hookUnits?: HookUnit[];
    /** Eén-regelige titel boven de Overview-slide grid, bv. "Top 6 films
        deze week". Als ontbreekt: header valt terug op "Andreas X kicker". */
    overviewTitle?: string;
    /** Optionele callback: per pick een eigen labelPair-paar. Default
        (= ongezet) gebruikt themeLabel + slide-index. Voor JustIn:
        retourneer { left: 'JUST IN', right: '2D GELEDEN' }. */
    perPickLabel?: (
      pick: CarouselPick,
      index: number,
    ) => { left: string; right: string };
    /** Slide-formaat. 'ig' = 1080×1350 (4:5), 'tiktok' = 1080×1920 (9:16).
        Default 'ig' voor backcompat. */
    format?: SlideFormat;
  } = {}
): Promise<Buffer[]> {
  if (picks.length === 0) {
    throw new Error('renderCarousel: minstens 1 pick vereist');
  }

  const format: SlideFormat = options.format ?? 'ig';
  const slides: Buffer[] = [];

  // Normaliseer alle picks met Date-objecten (input mag string of Date zijn).
  const normalized = picks.map((p) => ({
    ...p,
    startsAt:
      typeof p.startsAt === 'string' ? new Date(p.startsAt) : p.startsAt,
    endsAt:
      p.endsAt == null
        ? null
        : typeof p.endsAt === 'string'
          ? new Date(p.endsAt)
          : p.endsAt,
  }));

  // Pre-fetch alle imageUrls + converteer naar JPEG data-URL. Satori
  // ondersteunt geen WebP — zonder deze stap missen Bunny-webp-events
  // hun hero. Idempotent voor jpeg/png sources. Parallel zodat 't niet
  // de render-tijd opblaast.
  const uniqueUrls = Array.from(
    new Set(normalized.map((p) => p.imageUrl).filter(Boolean)),
  );
  const urlMap = new Map<string, string>();
  await Promise.all(
    uniqueUrls.map(async (url) => {
      urlMap.set(url, await imageToDataUrl(url));
    }),
  );
  for (const pick of normalized) {
    if (pick.imageUrl) pick.imageUrl = urlMap.get(pick.imageUrl) ?? pick.imageUrl;
  }

  // Intro-slide: gebruikt de LAATSTE pick als achtergrond zodat 'm
  // niet gelijk is aan slide 2 (= eerste event). Hook valt terug op
  // themeLabel als geen hook is meegegeven.
  const heroForIntro =
    normalized[normalized.length - 1]?.imageUrl ?? normalized[0]?.imageUrl;
  const hookText = options.hook ?? options.themeLabel ?? 'Vandaag in Amsterdam';
  if (heroForIntro) {
    slides.push(
      await renderSlide(
        introSlide({
          heroImageUrl: heroForIntro,
          hook: hookText,
          hookUnits: options.hookUnits,
          format,
        }),
        format,
      ),
    );
  }

  // 1..N event-slides
  for (let i = 0; i < normalized.length; i++) {
    const pick = normalized[i];
    const customLabel = options.perPickLabel?.(pick, i);
    const input: EventSlideInput = {
      imageUrl: pick.imageUrl,
      title: pick.title,
      venueName: pick.venueName,
      category: pick.category,
      venueType: pick.venueType,
      startsAt: pick.startsAt as Date,
      endsAt: pick.endsAt as Date | null,
      index: i + 1,
      total: normalized.length,
      themeLabel: options.themeLabel,
      windowLabel: options.windowLabel,
      labelLeft: customLabel?.left,
      labelRight: customLabel?.right,
      format,
    };
    slides.push(await renderSlide(eventSlide(input), format));
  }

  // Overview-slide: grid van alle picks aan het einde. themeKicker
  // vervangt het laatste woord in "Andreas X …" — meestal hetzelfde
  // als themeLabel (Film, Theater, Live, …).
  slides.push(
    await renderSlide(
      overviewSlide({
        themeKicker: options.themeLabel ?? 'Nieuw',
        overviewTitle: options.overviewTitle,
        picks: normalized.map((p) => ({
          imageUrl: p.imageUrl,
          title: p.title,
          venueName: p.venueName,
          startsAt: p.startsAt as Date,
          endsAt: p.endsAt as Date | null,
        })),
        format,
      }),
      format,
    ),
  );

  return slides;
}
