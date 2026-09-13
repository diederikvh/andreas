import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
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

import { SpinningCross } from '@/components/SpinningCross';
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
  // Het vlak dat we echt krijgen, niet het hele scherm. Op schermhoogte
  // gemaakte pagina's steken onder de viewer uit: je ticket plakt dan aan
  // de onderkant en de bovenkant valt weg.
  const [box, setBox] = useState({ width: 0, height: 0 });
  const { width, height } = box;
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

  // Ander document, andere uitsnede. Zonder dit houdt een viewer die
  // opnieuw opengaat de zoom van de vorige keer vast en land je op een
  // stukje papier zonder te weten waar je bent.
  const document = pages.map((p) => p.uri).join('|');
  useEffect(() => {
    setFocus(null);
    setReady(0);
  }, [document]);

  // Hoeveel pagina's hebben zichzelf goed gezet. Pas als ze er allemaal
  // zijn, laten we het zien. Anders zie je een halve tel een kaartje dat
  // nog moet inschuiven — of, erger, eentje die scheef blijft staan.
  const [ready, setReady] = useState(0);
  const onPageReady = useCallback(() => setReady((n) => n + 1), []);
  const settled = width > 0 && ready >= pages.length;

  return (
    <View
      style={[styles.root, { backgroundColor: background }]}
      onLayout={(e) => setBox(e.nativeEvent.layout)}
    >
      {/* Niet unmounten maar onzichtbaar: de pagina's moeten juist
          renderen en zichzelf zetten terwijl jij naar de spinner kijkt. */}
      <View style={[StyleSheet.absoluteFill, settled ? null : styles.hidden]}>
      {width > 0 ? (
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
            onReady={onPageReady}
          />
        ))}
      </ScrollView>
      ) : null}
      </View>

      {settled ? null : (
        <View style={styles.waiting} pointerEvents="none">
          <SpinningCross size={24} color={palette.paper3} />
        </View>
      )}

      {settled && pages.length > 1 ? (
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
  onReady,
}: {
  page: ViewerPage;
  width: number;
  height: number;
  /** De zoom van een pagina die er hetzelfde uitziet, of niets. */
  focus: PageFocus;
  onFocus: (focus: PageFocus) => void;
  onZoom: (zoomed: boolean) => void;
  /** Deze pagina staat goed. Tot dat van álle pagina's binnen is toont de
      viewer een spinner: liever een tel wachten dan een kaartje dat
      scheef staat op het moment dat je 'm nodig hebt. */
  onReady: () => void;
}) {
  const isIos = Platform.OS === 'ios';
  const view = useRef<ScrollView>(null);
  const zoom = useRef(1);
  // Wat deze pagina al toont. Bij de mount is dat per definitie de
  // uitsnede die er nú ligt: een pagina die nog geen layout heeft kan je
  // niet naar een rechthoek zoomen — iOS rekent dan met nul en schuift
  // het vel het beeld uit, waarna ook uitzoomen niets meer teruggeeft.
  // De zoom reist dus mee naar pagina's die al openstaan (dat is precies
  // het geval bij vegen), niet naar pagina's die nog geboren worden.
  const applied = useRef<PageFocus>(focus);

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

  const showWhole = (animated = true) => {
    if (isIos) {
      // Zelf bijhouden wat we zetten. `onScroll` vuurt niet betrouwbaar
      // bij een zoom die wij opdragen (zeker niet zonder animatie), en
      // dan denkt de volgende tik dat je nog uitgezoomd bent en zoomt hij
      // nóg een keer in — waarna je je ticket kwijt bent.
      zoom.current = 1;
      scroller()?.scrollResponderZoomTo?.({
        x: 0,
        y: 0,
        width,
        height,
        animated,
      });
      return;
    }
    reset();
    onZoom(false);
  };

  const showPoint = (x: number, y: number, animated = true) => {
    if (isIos) {
      zoom.current = TAP_ZOOM;
      scroller()?.scrollResponderZoomTo?.({
        x: x - width / TAP_ZOOM / 2,
        y: y - height / TAP_ZOOM / 2,
        width: width / TAP_ZOOM,
        height: height / TAP_ZOOM,
        animated,
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

  /**
   * Bij de eerste layout: zet deze pagina expliciet op z'n uitgangspunt.
   *
   * Twee redenen. React Native hergebruikt native views uit een pool, en
   * de zoom die we met `scrollResponderZoomTo` zetten hoort bij de view en
   * niet bij onze props — dus kan een pagina met de zoom van een vórig
   * kaartje uit die pool komen. Je ziet dan niets: het vel staat buiten
   * beeld en ook uitzoomen brengt het niet terug, want daar rekent iOS
   * mee vanaf dezelfde scheve stand. Alleen de app afsluiten hielp.
   *
   * En het moet ná de layout: zoomen naar een rechthoek in een view die
   * nog geen maat heeft rekent met nul en levert precies dezelfde scheve
   * stand op.
   */
  const laidOut = useRef(false);
  const onPageLayout = () => {
    if (laidOut.current) return;
    laidOut.current = true;
    // Een frame wachten. `onLayout` zegt dat de inhoud een maat heeft,
    // maar de scrollview verwerkt z'n contentSize pas in de volgende
    // teken-beurt; zoomen naar een rechthoek dáárvoor pakt soms wel en
    // soms niet. Dat was de "een op de drie".
    requestAnimationFrame(() => {
      if (focus) showPoint(focus.x, focus.y, false);
      else showWhole(false);
      onReady();
    });
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
      onPress={(e) => tapAt(e.nativeEvent.locationX, e.nativeEvent.locationY)}
      onLayout={onPageLayout}
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
    // Knippen op de pagina zelf: een ingezoomd vel is groter dan z'n
    // plek in de pager en lag anders over het volgende kaartje heen —
    // wit papier dwars over de code die je net had aangewezen.
    <View style={{ width, height, overflow: 'hidden' }}>
      <GestureDetector gesture={Gesture.Simultaneous(pinch, pan)}>
        <Animated.View style={[{ width, height }, zoomStyle]}>
          {image}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // Opacity, geen display: de pagina's moeten hun layout krijgen — daar
  // hangt de hele zet-jezelf-goed-stap aan.
  hidden: { opacity: 0 },
  waiting: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
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
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pageOn: { backgroundColor: palette.paper3 },
  pageNum: {
    fontFamily: fontFamily.bold,
    fontSize: 16,
    color: 'rgba(242,242,239,0.9)',
  },
  pageNumOn: { color: palette.noir },
});
