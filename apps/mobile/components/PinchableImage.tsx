/**
 * Pinch-to-zoom wrapper rond een Image, Instagram-stijl. Twee vingers
 * pinchen → een top-copy van het image verschijnt OVER alles heen
 * (via ZoomLayer), schaalt mee, springt terug bij loslaten.
 *
 * Het origineel blijft staan op z'n plek — alleen de copy in
 * ZoomLayer beweegt zodat overlays binnen de banner-View (gradient,
 * friends-pill, genre-chips) er gewoon bovenop blijven liggen wanneer
 * je NIET pincht. Daarom accepteert PinchableImage `children`: de
 * overlays (chips, BannerTitleOverlay, FriendsOnImage) zitten als
 * kinderen IN deze component, niet als siblings van een nested image.
 *
 * `onPress` wordt aangeroepen bij een gewone single-finger tik
 * waar dan ook op de banner — inclusief op de chip-overlays die
 * geen eigen responder hebben. Pinch en Tap zijn gecomponeerd via
 * `Gesture.Exclusive(pinch, tap)`, zodat pinch-release NOOIT als
 * tap doorlekt. Zonder dat zou de parent Pressable bij het loslaten
 * van een pinch alsnog navigeren naar de detail-page.
 */
import { Image, type ImageLoadEventData } from 'expo-image';
import { useCallback, useRef, type ReactNode } from 'react';
import {
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS, withTiming } from 'react-native-reanimated';

import { useZoomLayer } from '@/components/ZoomLayer';

export function PinchableImage({
  uri,
  onLoad,
  onPress,
  style,
  children,
}: {
  uri: string;
  onLoad?: (e: ImageLoadEventData) => void;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
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

  const fireTap = useCallback(() => {
    onPress?.();
  }, [onPress]);

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

  // Tap activeert pas bij touch-end binnen 250ms; bij pinch (2 vingers)
  // wint pinch via Exclusive en wordt tap automatisch ge-cancelled.
  const tap = Gesture.Tap()
    .maxDuration(250)
    .onEnd((_e, success) => {
      if (success) runOnJS(fireTap)();
    });

  const composed = Gesture.Exclusive(pinch, tap);

  return (
    <GestureDetector gesture={composed}>
      <View ref={ref} style={style} collapsable={false}>
        <Image
          source={{ uri }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          onLoad={onLoad}
        />
        {children}
      </View>
    </GestureDetector>
  );
}
