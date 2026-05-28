/**
 * Track de natuurlijke aspect-ratio van een Image. Default = 1 (square).
 * Wanneer 't image PORTRAIT is (height > width) of LANDSCAPE (width >
 * height) gebruiken we de natuurlijke ratio, gecapt op `min`/`max`
 * zodat extreme afmetingen niet de hele scroll-flow overnemen.
 *
 * - min 0.6 (5:8 portrait) → smalste poster
 * - max 1.78 (16:9 landscape) → breedste landscape
 *
 * Belangrijk: de ratio wordt gecacht per URI in een module-level Map
 * zodat een card die door SectionList/FlatList wordt gerecycled bij
 * scroll-up direct met de juiste hoogte rendert (geen schokje van
 * aspect=1 naar de echte ratio). Zonder cache krijgt elke remount een
 * layout-pass van vierkant → werkelijke ratio, wat de feed laat
 * stotteren bij snel terugscrollen.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ImageLoadEventData } from 'expo-image';

const aspectCache = new Map<string, number>();

export function useImageAspect(
  uri: string | null | undefined,
  min = 0.6,
  max = 1.78
) {
  const cached = uri ? aspectCache.get(uri) : undefined;
  const [aspect, setAspect] = useState<number>(cached ?? 1);

  // Wisselt de URI tussen renders (bv. nieuw event ingevuld in een
  // gerecyclede row), dan pakken we direct de gecachte ratio op zodat
  // we niet eerst even via 1 gaan.
  useEffect(() => {
    if (!uri) return;
    const v = aspectCache.get(uri);
    if (typeof v === 'number') setAspect(v);
  }, [uri]);

  const onLoad = useCallback(
    (e: ImageLoadEventData) => {
      const w = e?.source?.width;
      const h = e?.source?.height;
      if (typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0) {
        const r = Math.min(max, Math.max(min, w / h));
        if (uri) aspectCache.set(uri, r);
        setAspect(r);
      }
    },
    [min, max, uri]
  );
  return { aspect, onLoad };
}
