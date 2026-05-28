/**
 * Track de natuurlijke aspect-ratio van een Image. Default = 1 (square).
 * Wanneer 't image PORTRAIT is (height > width) of LANDSCAPE (width >
 * height) gebruiken we de natuurlijke ratio, gecapt op `min`/`max`
 * zodat extreme afmetingen niet de hele scroll-flow overnemen.
 *
 * - min 0.6 (5:8 portrait) → smalste poster
 * - max 1.78 (16:9 landscape) → breedste landscape
 */
import { useCallback, useState } from 'react';
import type { ImageLoadEventData } from 'expo-image';

export function useImageAspect(min = 0.6, max = 1.78) {
  const [aspect, setAspect] = useState(1);
  const onLoad = useCallback(
    (e: ImageLoadEventData) => {
      const w = e?.source?.width;
      const h = e?.source?.height;
      if (typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0) {
        const r = w / h;
        setAspect(Math.min(max, Math.max(min, r)));
      }
    },
    [min, max]
  );
  return { aspect, onLoad };
}
