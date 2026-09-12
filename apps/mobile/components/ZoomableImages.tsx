import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useRef, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
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

import { fontFamily, palette } from '@/theme/tokens';

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
 * Volledig-scherm beeldweergave voor de gedeelde afbeelding/PDF op
 * `/import` en voor je bewaarde ticket.
 *
 * **Eén pagina per scherm, naast elkaar.** Ze stonden eerst onder elkaar
 * in één lange scroll, en dat vocht met alles: verticaal slepen was zowel
 * "volgende pagina" als "verschuif het beeld", en na inzoomen wist niemand
 * meer waar hij was. Nu veeg je opzij voor de volgende pagina en is
 * verticaal vrij voor de pagina zelf. Bij meer dan één pagina staan de
 * nummers onderaan; daarmee spring je direct naar het tweede kaartje.
 *
 * **Tikken zoomt in op wat je aanwijst.** Op een kaartje staat de echte
 * informatie in één hoek — de code die de scanner moet lezen — en die
 * zoek je niet met twee vingers terwijl er een rij achter je staat. Eén
 * tik erop en hij vult het scherm, nog een tik en je ziet het hele
 * kaartje weer.
 *
 * **Knijpen: twee implementaties, met opzet.** Op iOS zoomt de ScrollView
 * van die ene pagina zelf (`maximumZoomScale`) — dat is de native pinch
 * die Foto's ook gebruikt, en die kan bovendien naar een rechthoek
 * springen. Op Android doen die props niets, dus daar zit een eigen pinch
 * + pan + tik op gesture-handler. Niet omdat twee paden mooi zijn, maar
 * omdat inzoomen op een barcode geen luxe is: kan de scanner het niet
 * lezen, dan sta je bij de deur met een ticket dat je niet kan tonen.
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
  const pager = useRef<ScrollView>(null);
  const [current, setCurrent] = useState(0);
  // Ingezoomd staat het bladeren uit: anders is dezelfde veeg zowel
  // "verschuif het beeld" als "volgende pagina".
  const [zoomed, setZoomed] = useState(false);

  return (
    <View style={[styles.root, { backgroundColor: background }]}>
      <ScrollView
        ref={pager}
        horizontal
        pagingEnabled
        scrollEnabled={!zoomed && pages.length > 1}
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(e) =>
          setCurrent(Math.round(e.nativeEvent.contentOffset.x / width))
        }
      >
        {pages.map((page) => (
          <ZoomablePage
            key={page.uri}
            page={page}
            width={width}
            height={height}
            onZoom={setZoomed}
          />
        ))}
      </ScrollView>

      {pages.length > 1 ? (
        <View style={[styles.pages, { bottom: insets.bottom + 16 }]}>
          {pages.map((page, index) => (
            <Pressable
              key={page.uri}
              onPress={() => {
                pager.current?.scrollTo({ x: index * width, animated: true });
                setCurrent(index);
              }}
              style={[styles.page, index === current ? styles.pageOn : null]}
            >
              <Text
                style={[
                  styles.pageNum,
                  index === current ? styles.pageNumOn : null,
                ]}
              >
                {index + 1}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

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

/**
 * Eén pagina, met z'n eigen zoom.
 *
 * Dat "eigen" doet het werk: de inhoud is precies één scherm groot, dus
 * het punt waar je tikt en het vlak waarin je zoomt zijn hetzelfde
 * coördinatenstelsel. In de vorige opzet — alle pagina's in één lange
 * scroll — moest de scrollstand erbij en sprong je ticket het beeld uit.
 */
function ZoomablePage({
  page,
  width,
  height,
  onZoom,
}: {
  page: ViewerPage;
  width: number;
  height: number;
  onZoom: (zoomed: boolean) => void;
}) {
  const isIos = Platform.OS === 'ios';
  const view = useRef<ScrollView>(null);
  const zoom = useRef(1);

  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);

  const reset = () => {
    'worklet';
    scale.value = withTiming(1);
    tx.value = withTiming(0);
    ty.value = withTiming(0);
    savedScale.value = 1;
    savedTx.value = 0;
    savedTy.value = 0;
  };

  /**
   * Eén tik: inzoomen op het punt waar je tikte, of terug naar de hele
   * pagina als je al ingezoomd zat.
   *
   * Bewust een gewone `Pressable` en geen tik-gebaar van gesture-handler:
   * die vuurde binnen een ScrollView op iOS niet. `locationX/Y` komen
   * binnen in de coördinaten van de pagina zelf.
   */
  const zoomTo = (x: number, y: number) => {
    if (isIos) {
      const scroller = view.current as unknown as {
        scrollResponderZoomTo?: (rect: {
          x: number;
          y: number;
          width: number;
          height: number;
          animated?: boolean;
        }) => void;
      } | null;
      if (!scroller?.scrollResponderZoomTo) return;
      if (zoom.current > 1.02) {
        scroller.scrollResponderZoomTo({
          x: 0,
          y: 0,
          width,
          height,
          animated: true,
        });
        return;
      }
      scroller.scrollResponderZoomTo({
        x: x - width / TAP_ZOOM / 2,
        y: y - height / TAP_ZOOM / 2,
        width: width / TAP_ZOOM,
        height: height / TAP_ZOOM,
        animated: true,
      });
      return;
    }

    if (scale.value > 1.02) {
      reset();
      onZoom(false);
      return;
    }
    // De verschuiving die het punt onder je vinger naar het midden
    // brengt: de afstand tot het midden, maal de schaal, de andere kant
    // op.
    const dx = -(x - width / 2) * TAP_ZOOM;
    const dy = -(y - height / 2) * TAP_ZOOM;
    scale.value = withTiming(TAP_ZOOM);
    tx.value = withTiming(dx);
    ty.value = withTiming(dy);
    savedScale.value = TAP_ZOOM;
    savedTx.value = dx;
    savedTy.value = dy;
    onZoom(true);
  };

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      const next = savedScale.value * e.scale;
      scale.value = Math.min(MAX_ZOOM, Math.max(1, next));
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      if (scale.value <= 1.02) reset();
      runOnJS(onZoom)(scale.value > 1.02);
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

  const zoomStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: tx.value },
      { translateY: ty.value },
      { scale: scale.value },
    ],
  }));

  const image = (
    <Pressable
      onPress={(e) => zoomTo(e.nativeEvent.locationX, e.nativeEvent.locationY)}
      style={{ width, height }}
    >
      <Image
        source={{ uri: page.uri }}
        style={{ width, height }}
        contentFit="contain"
      />
    </Pressable>
  );

  if (isIos) {
    return (
      <ScrollView
        ref={view}
        style={{ width, height }}
        contentContainerStyle={{ width, height }}
        maximumZoomScale={MAX_ZOOM}
        minimumZoomScale={1}
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        onScroll={(e) => {
          zoom.current = e.nativeEvent.zoomScale ?? 1;
          onZoom(zoom.current > 1.02);
        }}
        scrollEventThrottle={32}
      >
        {image}
      </ScrollView>
    );
  }

  return (
    <GestureDetector gesture={Gesture.Simultaneous(pinch, pan)}>
      <Animated.View style={[{ width, height }, zoomStyle]}>
        {image}
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
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
  // De nummers van je kaartjes. Zelfde donkere vlak als de kruisknop, om
  // dezelfde reden: hieronder ligt wit papier.
  pages: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  page: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  pageOn: { backgroundColor: palette.paper3 },
  pageNum: {
    fontFamily: fontFamily.mono,
    fontSize: 13,
    color: palette.paper3,
  },
  pageNumOn: { color: palette.noir },
});
