import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useEffect, useRef, useState } from 'react';
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

/** Waar iemand op inzoomde, en op wat voor pagina. */
type PageFocus = { x: number; y: number; aspect: number } | null;

/** Lijkt deze pagina genoeg op die waar de zoom vandaan komt? We kunnen
    niet zien wat er staat, dus we vergelijken de vorm. Twee procent speling
    voor een render die net iets anders uitpakt. */
function sameShape(page: ViewerPage, focus: PageFocus): boolean {
  if (!focus || !page.width || !page.height) return false;
  const aspect = page.width / page.height;
  return Math.abs(aspect - focus.aspect) / focus.aspect < 0.02;
}

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
 * **De zoom reist mee naar een kaartje dat er hetzelfde uitziet.** Twee
 * tickets uit dezelfde bestelling hebben hun code op dezelfde plek: zoom
 * je in op de code van het eerste, dan staat die van het tweede na een
 * veeg meteen goed — scannen, vegen, scannen. Bij een pagina van een
 * ander formaat (de voorwaarden achterop, een lidmaatschapsvel) klopt die
 * aanname niet en begint hij weer bij het hele vel. Zelfde verhouding is
 * onze maat voor "hetzelfde kaartje"; wat er stáát kunnen we niet
 * vergelijken zonder de pixels te lezen.
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
  const isIos = Platform.OS === 'ios';
  const pager = useRef<ScrollView>(null);
  const [current, setCurrent] = useState(0);
  // Waar je op inzoomde, in de coördinaten van een pagina, plus de
  // verhouding van de pagina waar het op sloeg.
  const [focus, setFocus] = useState<PageFocus>(null);
  // Op Android staat het bladeren uit zodra je inzoomt: daar is het
  // verschuiven een eigen gebaar en zou dezelfde veeg twee dingen
  // betekenen. Op iOS regelt de scrollview dat zelf — ben je aan de rand
  // van je ingezoomde kaartje, dan neemt de pager het over. Dát is wat je
  // wil bij twee kaartjes: scannen, vegen, scannen.
  const [zoomed, setZoomed] = useState(false);

  return (
    <View style={[styles.root, { backgroundColor: background }]}>
      <ScrollView
        ref={pager}
        horizontal
        pagingEnabled
        scrollEnabled={pages.length > 1 && (isIos || !zoomed)}
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
            focus={sameShape(page, focus) ? focus : null}
            onFocus={setFocus}
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
  focus,
  onFocus,
  onZoom,
}: {
  page: ViewerPage;
  width: number;
  height: number;
  /** De zoom van een pagina die er hetzelfde uitziet, of niets. */
  focus: PageFocus;
  onFocus: (focus: PageFocus) => void;
  onZoom: (zoomed: boolean) => void;
}) {
  const isIos = Platform.OS === 'ios';
  const view = useRef<ScrollView>(null);
  const zoom = useRef(1);
  const applied = useRef<PageFocus>(null);

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

  /** Wat iOS nodig heeft om naar een rechthoek te zoomen. */
  const scroller = () =>
    view.current as unknown as {
      scrollResponderZoomTo?: (rect: {
        x: number;
        y: number;
        width: number;
        height: number;
        animated?: boolean;
      }) => void;
    } | null;

  const showWhole = () => {
    if (isIos) {
      scroller()?.scrollResponderZoomTo?.({
        x: 0,
        y: 0,
        width,
        height,
        animated: true,
      });
      return;
    }
    reset();
    onZoom(false);
  };

  const showPoint = (x: number, y: number) => {
    if (isIos) {
      scroller()?.scrollResponderZoomTo?.({
        x: x - width / TAP_ZOOM / 2,
        y: y - height / TAP_ZOOM / 2,
        width: width / TAP_ZOOM,
        height: height / TAP_ZOOM,
        animated: true,
      });
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

  /**
   * Eén tik: inzoomen op het punt waar je tikte, of terug naar de hele
   * pagina als je al ingezoomd zat. Wat je koos gaat naar boven, zodat een
   * kaartje dat er hetzelfde uitziet dezelfde uitsnede krijgt.
   *
   * Bewust een gewone `Pressable` en geen tik-gebaar van gesture-handler:
   * die vuurde binnen een ScrollView op iOS niet. `locationX/Y` komen
   * binnen in de coördinaten van de pagina zelf.
   */
  const tapAt = (x: number, y: number) => {
    const zoomedIn = isIos ? zoom.current > 1.02 : scale.value > 1.02;
    if (zoomedIn) {
      showWhole();
      applied.current = null;
      onFocus(null);
      return;
    }
    showPoint(x, y);
    const next = {
      x,
      y,
      aspect: page.width && page.height ? page.width / page.height : 1,
    };
    applied.current = next;
    onFocus(next);
  };

  // De uitsnede van een pagina die er hetzelfde uitziet overnemen — of
  // terug naar het hele vel als er niets (meer) gekozen is. `applied`
  // houdt bij wat deze pagina al toont, zodat de pagina waar de tik
  // vandaan kwam niet nog een keer animeert.
  useEffect(() => {
    if (focus === applied.current) return;
    applied.current = focus;
    if (focus) showPoint(focus.x, focus.y);
    else showWhole();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

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
      onPress={(e) => tapAt(e.nativeEvent.locationX, e.nativeEvent.locationY)}
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
  // De nummers van je kaartjes, in één donkere balk. Die balk is geen
  // versiering: hieronder ligt wit papier, en een lichte knop op wit is
  // geen knop. Ingezoomd ligt hij over je ticket heen, dus hij moet ook
  // dán leesbaar zijn.
  pages: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    gap: 2,
    padding: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.82)',
  },
  page: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pageOn: { backgroundColor: palette.paper3 },
  pageNum: {
    fontFamily: fontFamily.mono,
    fontSize: 13,
    color: 'rgba(242,242,239,0.9)',
  },
  pageNumOn: { color: palette.noir },
});
