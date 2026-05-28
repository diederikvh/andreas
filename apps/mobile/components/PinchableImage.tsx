/**
 * Pinch-to-zoom wrapper rond een Image, Instagram-stijl. Twee vingers
 * pinchen → een top-copy van het image verschijnt OVER alles heen
 * (via ZoomLayer), schaalt mee, springt terug bij loslaten.
 *
 * Het origineel blijft staan op z'n plek — alleen de copy in
 * ZoomLayer beweegt zodat overlays binnen de banner-View (gradient,
 * friends-pill, genre-chips) er gewoon bovenop blijven liggen wanneer
 * je NIET pincht.
 */
import { Image, type ImageLoadEventData } from 'expo-image';
import { useCallback, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS, withTiming } from 'react-native-reanimated';

import { useZoomLayer } from '@/components/ZoomLayer';

export function PinchableImage({
  uri,
  onLoad,
}: {
  uri: string;
  onLoad?: (e: ImageLoadEventData) => void;
}) {
  const ref = useRef<View>(null);
  const { scale, start, end } = useZoomLayer();

  // Beide helpers MOETEN op de JS-thread runnen: ref.current is een
  // React-ref (alleen geldig op JS), en setState in ZoomLayer ook.
  // Gesture callbacks runnen als worklets op de UI-thread; daarom
  // wrappen we de aanroep in runOnJS.
  const measureAndStart = useCallback(() => {
    ref.current?.measureInWindow((x, y, w, h) => {
      start({ uri, x, y, width: w, height: h });
    });
  }, [start, uri]);

  const onPinchFinish = useCallback(() => {
    end();
  }, [end]);

  const pinch = Gesture.Pinch()
    .onStart(() => {
      runOnJS(measureAndStart)();
    })
    .onUpdate((e) => {
      scale.value = Math.min(3, Math.max(1, e.scale));
    })
    .onEnd(() => {
      scale.value = withTiming(1, { duration: 220 }, () => {
        runOnJS(onPinchFinish)();
      });
    });

  return (
    <GestureDetector gesture={pinch}>
      <View ref={ref} style={StyleSheet.absoluteFill} collapsable={false}>
        <Image
          source={{ uri }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          onLoad={onLoad}
        />
      </View>
    </GestureDetector>
  );
}
