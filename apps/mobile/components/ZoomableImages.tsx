import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { palette } from '@/theme/tokens';

export type ViewerPage = {
  uri: string;
  width: number | null;
  height: number | null;
};

const MAX_ZOOM = 5;

/**
 * Volledig-scherm beeldweergave met zoom, en scrollen bij meerdere
 * pagina's. Gebruikt voor de gedeelde afbeelding/PDF op `/import` en voor
 * je bewaarde ticket.
 *
 * **Twee implementaties, met opzet.** Op iOS doet de ScrollView het zelf
 * (`maximumZoomScale`) — dat is de native pinch die Foto's ook gebruikt,
 * en daar hoeven we niets aan toe te voegen. Op Android doen die props
 * niets, dus daar zit een eigen pinch + pan op gesture-handler. Niet
 * omdat twee paden mooi zijn, maar omdat inzoomen op een barcode geen
 * luxe is: kan de scanner het niet lezen, dan sta je bij de deur met een
 * ticket dat je niet kan tonen.
 *
 * Zolang je op Android ingezoomd bent staat het verticaal scrollen uit —
 * anders vechten de pan en de scroll om hetzelfde gebaar. Dubbeltik zoomt
 * in en weer uit.
 *
 * Sluiten gaat via de kruisknop en niet via een tik op de achtergrond: bij
 * ingezoomd beeld is elke tik ook het begin van een sleep.
 */
export function ZoomableImages({
  pages,
  onClose,
}: {
  pages: ViewerPage[];
  onClose?: () => void;
}) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const isIos = Platform.OS === 'ios';

  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);
  const [zoomed, setZoomed] = useState(false);

  const reset = () => {
    'worklet';
    scale.value = withTiming(1);
    tx.value = withTiming(0);
    ty.value = withTiming(0);
    savedScale.value = 1;
    savedTx.value = 0;
    savedTy.value = 0;
  };

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      const next = savedScale.value * e.scale;
      scale.value = Math.min(MAX_ZOOM, Math.max(1, next));
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      if (scale.value <= 1.02) reset();
      runOnJS(setZoomed)(scale.value > 1.02);
    });

  const pan = Gesture.Pan()
    .onUpdate((e) => {
      if (savedScale.value <= 1) return;
      tx.value = savedTx.value + e.translationX;
      ty.value = savedTy.value + e.translationY;
    })
    .onEnd(() => {
      savedTx.value = tx.value;
      savedTy.value = ty.value;
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      if (scale.value > 1.02) {
        reset();
        runOnJS(setZoomed)(false);
        return;
      }
      scale.value = withTiming(2.5);
      savedScale.value = 2.5;
      runOnJS(setZoomed)(true);
    });

  const gesture = Gesture.Simultaneous(
    pinch,
    Gesture.Exclusive(doubleTap, pan)
  );

  const zoomStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: tx.value },
      { translateY: ty.value },
      { scale: scale.value },
    ],
  }));

  const images = pages.map((page) => (
    <Image
      key={page.uri}
      source={{ uri: page.uri }}
      style={{
        width,
        // Zonder bekende verhouding een staand vlak: beter te hoog dan een
        // platgedrukt ticket.
        height:
          page.width && page.height
            ? (width * page.height) / page.width
            : width * 1.4,
      }}
      contentFit="contain"
    />
  ));

  return (
    <View style={styles.root}>
      <ScrollView
        scrollEnabled={isIos || !zoomed}
        maximumZoomScale={isIos ? MAX_ZOOM : 1}
        minimumZoomScale={1}
        centerContent
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 16 },
        ]}
      >
        {isIos ? (
          images
        ) : (
          <GestureDetector gesture={gesture}>
            <Animated.View style={[styles.content, zoomStyle]}>
              {images}
            </Animated.View>
          </GestureDetector>
        )}
      </ScrollView>

      {onClose ? (
        <Pressable
          onPress={onClose}
          hitSlop={10}
          style={[styles.close, { top: insets.top + 8 }]}
        >
          <Ionicons name="close" size={22} color={palette.paper3} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000000' },
  content: { flexGrow: 1, justifyContent: 'center', gap: 10 },
  close: {
    position: 'absolute',
    right: 14,
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    // Donker en dekkend: een ticket of poster is meestal wit, en een
    // lichte knop met lichte rand verdween daar volledig in.
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
});
