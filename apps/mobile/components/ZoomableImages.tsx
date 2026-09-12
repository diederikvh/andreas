import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useRef, useState } from 'react';
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

/** Hoe ver één tik inzoomt. Drie is genoeg om een QR van een A4 het halve
    scherm te laten vullen, en weinig genoeg om te zien wat eromheen zit. */
const TAP_ZOOM = 3;

/**
 * Volledig-scherm beeldweergave met zoom, en scrollen bij meerdere
 * pagina's. Gebruikt voor de gedeelde afbeelding/PDF op `/import` en voor
 * je bewaarde ticket.
 *
 * **Knijpen: twee implementaties, met opzet.** Op iOS doet de ScrollView
 * het zelf (`maximumZoomScale`) — dat is de native pinch die Foto's ook
 * gebruikt. Op Android doen die props niets, dus daar zit een eigen pinch
 * op gesture-handler. Niet omdat twee paden mooi zijn, maar omdat
 * inzoomen op een barcode geen luxe is: kan de scanner het niet lezen,
 * dan sta je bij de deur met een ticket dat je niet kan tonen.
 *
 * De tik-zoom doet het op beide platforms zélf, met een transform. iOS
 * heeft `scrollResponderZoomTo`, maar dat rekent in het coördinaten-
 * stelsel van de scrollview en niet in dat van je vinger. Eén pad dat op
 * allebei hetzelfde doet is hier meer waard dan de native animatie.
 *
 * Zolang je op Android ingezoomd bent staat het verticaal scrollen uit —
 * anders vechten de pan en de scroll om hetzelfde gebaar.
 *
 * **Tikken zoomt in op wat je aanwijst.** Op een ticket staat de echte
 * informatie in één hoek — de code die de scanner moet lezen — en die
 * zoek je niet met twee vingers terwijl er een rij achter je staat. Eén
 * tik erop en hij vult het scherm; nog een tik en je ziet het hele
 * kaartje weer.
 *
 * Sluiten gaat via de kruisknop en niet via een tik op de achtergrond: bij
 * ingezoomd beeld is elke tik ook het begin van een sleep.
 *
 * `background` bepaalt het vlak achter de pagina's. Zwart is de default en
 * blijft dat voor je bewaarde ticket — een gescande code leest beter op een
 * donkere ondergrond. Kijk je alleen naar wat je deelde, dan is er niets te
 * scannen en geef je 'm de kleur van de modus waar je in zit.
 */
export function ZoomableImages({
  pages,
  onClose,
  background = '#000000',
}: {
  pages: ViewerPage[];
  onClose?: () => void;
  background?: string;
}) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const isIos = Platform.OS === 'ios';

  // Het vlak waarin we tikken: nodig om van "waar tikte je" naar een
  // verschuiving te rekenen.
  const [box, setBox] = useState({ w: 0, h: 0 });
  const scrollRef = useRef<ScrollView>(null);
  // Hoe ver de lijst staat, en op iOS hoe ver de scrollview zelf ingezoomd
  // is. Allebei nodig om te weten waar het scherm nú naar kijkt.
  const scrollY = useRef(0);
  const iosZoom = useRef(1);

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

  /**
   * Eén tik: inzoomen op het punt waar je tikte, of terug naar het hele
   * kaartje als je al ingezoomd zat.
   *
   * Bewust een gewone `Pressable` en geen tik-gebaar van gesture-handler:
   * die vuurde binnen deze ScrollView op iOS niet. `locationX/Y` komen
   * binnen in de coördinaten van het beeld zelf — onafhankelijk van hoe
   * ver de lijst staat, en dat is precies wat allebei de platforms nodig
   * hebben.
   *
   * iOS laat de ScrollView het doen: die kan naar een rechthoek zoomen en
   * houdt scrollen en pannen daarna gewoon werkend. Android heeft dat
   * niet, dus daar verschuiven we het beeld zelf. Let op de scrollstand in
   * die berekening: bij een PDF van twee pagina's is het midden van de
   * inhoud iets heel anders dan het midden van je scherm — reken je dat
   * niet mee, dan springt je ticket het beeld uit.
   */
  const zoomTo = (x: number, y: number) => {
    if (box.w === 0) return;
    const top = insets.top + 8;

    if (isIos) {
      const view = scrollRef.current as unknown as {
        scrollResponderZoomTo?: (rect: {
          x: number;
          y: number;
          width: number;
          height: number;
          animated?: boolean;
        }) => void;
      } | null;
      if (!view?.scrollResponderZoomTo) return;
      if (iosZoom.current > 1.02) {
        view.scrollResponderZoomTo({
          x: 0,
          y: top,
          width: box.w,
          height: box.h,
          animated: true,
        });
        return;
      }
      const w = box.w / TAP_ZOOM;
      const h = height / TAP_ZOOM;
      view.scrollResponderZoomTo({
        x: x - w / 2,
        y: y + top - h / 2,
        width: w,
        height: h,
        animated: true,
      });
      return;
    }

    if (scale.value > 1.02) {
      reset();
      setZoomed(false);
      return;
    }
    // Waar het scherm nu naar kijkt, in de coördinaten van het beeld.
    const viewCenter = scrollY.current + height / 2 - top;
    const dx = -(x - box.w / 2) * TAP_ZOOM;
    const dy = viewCenter - box.h / 2 - (y - box.h / 2) * TAP_ZOOM;
    scale.value = withTiming(TAP_ZOOM);
    tx.value = withTiming(dx);
    ty.value = withTiming(dy);
    savedScale.value = TAP_ZOOM;
    savedTx.value = dx;
    savedTy.value = dy;
    setZoomed(true);
  };

  const gesture = Gesture.Simultaneous(pinch, pan);

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
    <View style={[styles.root, { backgroundColor: background }]}>
      <ScrollView
        ref={scrollRef}
        onScroll={(e) => {
          scrollY.current = e.nativeEvent.contentOffset.y;
          if (isIos) iosZoom.current = e.nativeEvent.zoomScale ?? 1;
        }}
        scrollEventThrottle={32}
        // Op Android verschuif je ingezoomd met je vinger het beeld, niet
        // de lijst: anders vechten de pan en de scroll om hetzelfde
        // gebaar. Op iOS doet de scrollview het zelf en mag hij aan
        // blijven — daar scroll je ingezoomd gewoon door je ticket.
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
        <GestureDetector gesture={gesture}>
          <Animated.View
            style={[styles.content, zoomStyle]}
            onLayout={(e) =>
              setBox({
                w: e.nativeEvent.layout.width,
                h: e.nativeEvent.layout.height,
              })
            }
          >
            <Pressable
              onPress={(e) =>
                zoomTo(e.nativeEvent.locationX, e.nativeEvent.locationY)
              }
              style={styles.content}
            >
              {images}
            </Pressable>
          </Animated.View>
        </GestureDetector>
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
  root: { flex: 1 },
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
