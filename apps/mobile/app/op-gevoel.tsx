import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import type { ApiEvent } from '@/lib/api';
import {
  CATEGORY_TICK,
  VENUE_TYPE_TICK,
  dowMixed,
  eventImageUrl,
  isDaytimeOccurrence,
  isLongRunning,
  monthShort,
  rowTimeLabel,
  translateCategory,
} from '@/lib/eventDisplay';
import { EventListRow } from '@/components/EventListRow';
import { useLocale, useT, type Locale } from '@/lib/i18n';
import {
  useEvents,
  useMyDismisses,
  useMySaves,
  useToggleDismiss,
  useToggleSave,
} from '@/lib/queries';
import { useContentMode } from '@/store/contentMode';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

/** "Op gevoel" — Tinder-stijl swipe-stack om snel door komend aanbod
 *  te scrollen. Right-swipe = save (heart), left-swipe = skip (niet
 *  vandaag, mag morgen weer terugkomen). Stack van ~12 random
 *  events. Na de laatste een rustige recap met de ja's. */

const STACK_SIZE = 12;

type StackEvent = {
  event: ApiEvent;
  occurrenceId: string;
  startsAt: string;
  endsAt: string | null;
};

type SwipeCardHandle = {
  swipeLeft: () => void;
  swipeRight: () => void;
  openDetail: () => void;
};

export default function OpGevoel() {
  const insets = useSafeAreaInsets();
  const t = useT();
  const locale = useLocale();
  const roles = useRoles();
  const mode = useMode();
  const isNacht = mode === 'nacht';
  const { width: windowWidth } = useWindowDimensions();

  const cmode = useContentMode();
  const { data: events } = useEvents({
    from: new Date(new Date().setHours(0, 0, 0, 0)).toISOString(),
  });
  const { data: saves } = useMySaves();
  const { data: dismissedIds } = useMyDismisses();
  const toggleSave = useToggleSave();
  const toggleDismiss = useToggleDismiss();
  // Sessie-geheugen: alle events die de gebruiker dit bezoek al heeft
  // gezien (ja én nee). Een ref zodat het bijwerken geen re-render
  // veroorzaakt — alleen op "Verder swipen" lezen we de set in de
  // stack-memo via stackRefreshKey-bump.
  const seenIdsRef = useRef<Set<string>>(new Set());
  const [stackRefreshKey, setStackRefreshKey] = useState(0);
  // Imperative handle naar de top-card zodat de legenda-knoppen
  // dezelfde fly-out animatie kunnen triggeren als een swipe.
  const topCardRef = useRef<SwipeCardHandle>(null);

  // Bouw één keer een random stack van 12 events. Filtert:
  //  - long-running (>7d) — die zijn doorlopend, niet vandaag-vibey
  //  - exhibitions — idem
  //  - events zonder upcoming occurrence
  //  - al-gesavede occurrences — niet opnieuw aanbieden
  //  - buiten 1-maand horizon — daarna niet meer actionable voor
  //    "op gevoel"; planning op die termijn doe je in Agenda
  //  - cmode-mismatch: dag-mode pakt alleen daytime-occurrences, nacht
  //    alleen niet-daytime
  //
  // Synthetische memo-key: hangt af van "hebben we events" + cmode +
  // refresh-key, NIET van de events-reference. Anders rebuilt React
  // Query's refetch (die telkens een nieuwe array-ref teruggeeft, ook
  // bij identieke content) de stack met een verse Fisher-Yates shuffle
  // → cards remount in andere volgorde → zichtbare flits bij openen.
  const stackKey = events
    ? `have-${cmode}-${stackRefreshKey}`
    : 'none';
  const stack = useMemo<StackEvent[]>(() => {
    if (!events) return [];
    const savedOccIds = new Set((saves ?? []).map((s) => s.occurrenceId));
    const dismissedOccIds = new Set(dismissedIds ?? []);
    const horizonMs = Date.now() + 31 * 24 * 60 * 60 * 1000;
    // Bouw eerst de complete pool (alleen permanente filters), daarna
    // pas filteren op seen — anders kunnen we niet detecteren of de
    // pool uitgeput is.
    const pool: StackEvent[] = [];
    for (const e of events) {
      if (e.kind === 'exhibition') continue;
      if (isLongRunning(e.startsAt, e.endsAt)) continue;
      const occ = e.occurrencesInRange?.[0];
      if (!occ) continue;
      if (savedOccIds.has(occ.id)) continue;
      if (dismissedOccIds.has(occ.id)) continue;
      const startMs = new Date(occ.startsAt).getTime();
      if (startMs > horizonMs) continue;
      const isDay = isDaytimeOccurrence(occ.startsAt, occ.endsAt);
      if (cmode === 'expo' && !isDay) continue;
      if (cmode === 'uit' && isDay) continue;
      pool.push({
        event: e,
        occurrenceId: occ.id,
        startsAt: occ.startsAt,
        endsAt: occ.endsAt,
      });
    }
    // Filter op session-seen. Als alles al gezien is binnen de
    // horizon: reset de seen-set en gebruik de hele pool opnieuw —
    // anders blijf je in een leeg eind-state hangen terwijl er nog
    // events te zien zijn.
    let candidates = pool.filter((c) => !seenIdsRef.current.has(c.event.id));
    if (candidates.length === 0 && pool.length > 0) {
      seenIdsRef.current = new Set();
      candidates = pool;
    }
    // Fisher-Yates shuffle
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    return candidates.slice(0, STACK_SIZE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stackKey]);

  const [index, setIndex] = useState(0);
  const [likes, setLikes] = useState<StackEvent[]>([]);
  const done = stack.length > 0 && index >= stack.length;

  const onSwipeCommit = (dir: 'left' | 'right', item: StackEvent) => {
    // Onthou dat we 'm hebben gezien — voor de volgende "Verder
    // swipen"-batch. Geldt voor zowel ja als nee.
    seenIdsRef.current.add(item.event.id);
    if (dir === 'right') {
      setLikes((prev) => [...prev, item]);
      toggleSave.mutate({
        occurrenceId: item.occurrenceId,
        source: 'op-gevoel',
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
        () => {}
      );
    } else {
      // Left-swipe = persistente dismiss. Komt niet terug in latere
      // sessies en voedt het smaak-profiel ("welke patronen wijs ik af").
      toggleDismiss.mutate(item.occurrenceId);
      Haptics.selectionAsync().catch(() => {});
    }
    setIndex((i) => i + 1);
  };

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <View
        style={[
          styles.body,
          {
            paddingTop: insets.top + HEADER_HEIGHT + 8,
            paddingBottom: insets.bottom + 24,
          },
        ]}
      >
        {!events && (
          <View style={styles.centerWrap}>
            <Text style={[styles.dim, { color: roles.fgMuted }]}>
              {t('Laden…', 'Loading…')}
            </Text>
          </View>
        )}
        {events && stack.length === 0 && (
          <View style={styles.centerWrap}>
            <Text style={[styles.dim, { color: roles.fgMuted }]}>
              {t(
                'Geen events om door te swipen.',
                'Nothing to swipe through.'
              )}
            </Text>
          </View>
        )}
        {!done && stack.length > 0 && (
          <>
            <SwipeStack
              stack={stack}
              currentIndex={index}
              onCommit={onSwipeCommit}
              windowWidth={windowWidth}
              locale={locale}
              topCardRef={topCardRef}
            />
            <SwipeLegend
              onSkip={() => topCardRef.current?.swipeLeft()}
              onMoreInfo={() => topCardRef.current?.openDetail()}
              onLike={() => topCardRef.current?.swipeRight()}
            />
          </>
        )}
        {done && (
          <Recap
            total={stack.length}
            likes={likes}
            locale={locale}
            onContinue={() => {
              // Reset index + likes; bump refresh-key zodat stack-memo
              // opnieuw draait met de bijgewerkte seen-set en je niet
              // dezelfde 12 events terugkrijgt.
              setIndex(0);
              setLikes([]);
              setStackRefreshKey((k) => k + 1);
            }}
          />
        )}
      </View>

      <AppHeader
        title={t('Vibes', 'Vibes')}
        hideAvatar
        rightSlot={
          <Pressable
            onPress={() => router.back()}
            hitSlop={8}
            style={[
              styles.closeBtn,
              { backgroundColor: isNacht ? palette.noir2 : palette.paper2 },
            ]}
          >
            <Ionicons name="close" size={20} color={roles.fg} />
          </Pressable>
        }
      />
    </View>
  );
}

function SwipeStack({
  stack,
  currentIndex,
  onCommit,
  windowWidth,
  locale,
  topCardRef,
}: {
  stack: StackEvent[];
  currentIndex: number;
  onCommit: (dir: 'left' | 'right', item: StackEvent) => void;
  windowWidth: number;
  locale: Locale;
  topCardRef: React.RefObject<SwipeCardHandle | null>;
}) {
  // Render de huidige kaart + de twee daaronder voor diepte. Sleutel
  // per index zodat React de juiste mount/unmount-volgorde houdt.
  const visible = stack.slice(currentIndex, currentIndex + 3);
  return (
    <View style={styles.stackArea} pointerEvents="box-none">
      {visible
        .slice()
        .reverse()
        .map((item, reversedI) => {
          const depth = visible.length - 1 - reversedI; // 0 = top
          const isTop = depth === 0;
          return (
            <SwipeCard
              key={`${item.event.id}-${item.occurrenceId}-${currentIndex + depth}`}
              ref={isTop ? topCardRef : undefined}
              item={item}
              depth={depth}
              isTop={isTop}
              onCommit={isTop ? onCommit : undefined}
              windowWidth={windowWidth}
              locale={locale}
            />
          );
        })}
    </View>
  );
}

const SwipeCard = forwardRef<
  SwipeCardHandle,
  {
    item: StackEvent;
    depth: number;
    isTop: boolean;
    onCommit?: (dir: 'left' | 'right', item: StackEvent) => void;
    windowWidth: number;
    locale: Locale;
  }
>(function SwipeCard(
  { item, depth, isTop, onCommit, windowWidth, locale },
  ref
) {
  const roles = useRoles();
  const mode = useMode();
  const isNacht = mode === 'nacht';
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const threshold = windowWidth * 0.32;
  // Guard tegen dubbele commits — wanneer de fly-out animatie loopt
  // mag een tweede tap of swipe niet nogmaals onCommit triggeren
  // (zou de index dubbel laten doorlopen → kaart overgeslagen).
  const isFlyingRef = useRef(false);
  // Animated depth — laat de scale + offset soepel transitioneren
  // wanneer de top-card wegvliegt en deze kaart van depth=1 naar
  // depth=0 schuift. Zonder dit ploppen de achterste cards in een
  // tik naar voren.
  const depthSv = useSharedValue(depth);
  useEffect(() => {
    depthSv.value = withSpring(depth, { damping: 20, stiffness: 160 });
  }, [depth, depthSv]);

  // Brand-kleuren per mode. Nacht krijgt punchy felle accents (acid +
  // flare), dag de getemperde paper-/karmijn-tonen — past bij de
  // bredere stijl van de twee modes.
  const yesBg = isNacht ? palette.acid : palette.red;
  const yesFg = isNacht ? palette.noir : palette.paper3;
  const noBg = isNacht ? palette.flare : palette.paper;
  const noFg = isNacht ? palette.ink : palette.soil;

  const verticalThreshold = 120;
  const openDetail = () => {
    router.push(
      `/event/${item.event.id}?o=${item.occurrenceId}` as never
    );
  };

  // Programmatische fly-out — dezelfde animatie als een swipe over de
  // threshold. Wordt aangeroepen door de legenda-knoppen (skip / like).
  // Iets langzamer dan de gesture-variant (360 vs 220ms) zodat een tap
  // niet als een harde "klik" voelt maar als een rustige weg-glide.
  const flyOut = (dir: 'left' | 'right') => {
    if (isFlyingRef.current) return;
    isFlyingRef.current = true;
    translateX.value = withTiming(
      dir === 'right' ? windowWidth * 1.5 : -windowWidth * 1.5,
      { duration: 360 },
      () => {
        if (onCommit) runOnJS(onCommit)(dir, item);
      }
    );
    translateY.value = withTiming(0, { duration: 360 });
  };

  useImperativeHandle(ref, () => ({
    swipeLeft: () => flyOut('left'),
    swipeRight: () => flyOut('right'),
    openDetail,
  }));

  const pan = Gesture.Pan()
    .enabled(isTop)
    .onUpdate((e) => {
      translateX.value = e.translationX;
      translateY.value = e.translationY * 0.5;
    })
    .onEnd((e) => {
      const verticalDominant =
        Math.abs(e.translationY) > Math.abs(e.translationX);
      // Swipe naar boven → open event-detail. Card veert terug zodat
      // 'ie er nog staat als de gebruiker terug navigeert.
      if (verticalDominant && e.translationY < -verticalThreshold) {
        runOnJS(openDetail)();
        translateX.value = withSpring(0, { damping: 18, stiffness: 180 });
        translateY.value = withSpring(0, { damping: 18, stiffness: 180 });
        return;
      }
      const passed = Math.abs(e.translationX) > threshold;
      if (passed) {
        const dir = e.translationX > 0 ? 'right' : 'left';
        // Vlieg uit beeld, daarna onCommit (advance index).
        translateX.value = withTiming(
          dir === 'right' ? windowWidth * 1.5 : -windowWidth * 1.5,
          { duration: 220 },
          () => {
            if (onCommit) runOnJS(onCommit)(dir, item);
          }
        );
        translateY.value = withTiming(e.translationY, { duration: 220 });
      } else {
        translateX.value = withSpring(0, { damping: 18, stiffness: 180 });
        translateY.value = withSpring(0, { damping: 18, stiffness: 180 });
      }
    });

  const cardStyle = useAnimatedStyle(() => {
    const rotate = interpolate(
      translateX.value,
      [-windowWidth, 0, windowWidth],
      [-12, 0, 12],
      Extrapolation.CLAMP
    );
    // Diepte: kaarten erachter iets kleiner + lager. Top = depth 0.
    // depthSv interpoleert vloeiend tussen depths (spring) bij re-rank.
    const baseScale = 1 - depthSv.value * 0.04;
    const baseTranslateY = depthSv.value * 8;
    return {
      transform: [
        { translateX: translateX.value },
        { translateY: translateY.value + baseTranslateY },
        { rotateZ: `${rotate}deg` },
        { scale: baseScale },
      ],
      opacity: 1 - depthSv.value * 0.15,
      zIndex: 10 - depth,
    };
  });

  const yesOverlayStyle = useAnimatedStyle(() => ({
    opacity: isTop
      ? interpolate(
          translateX.value,
          [0, threshold],
          [0, 0.92],
          Extrapolation.CLAMP
        )
      : 0,
  }));
  const noOverlayStyle = useAnimatedStyle(() => ({
    opacity: isTop
      ? interpolate(
          translateX.value,
          [-threshold, 0],
          [0.92, 0],
          Extrapolation.CLAMP
        )
      : 0,
  }));

  const photo = eventImageUrl(item.event);
  const dateLabel = formatStackDate(item.startsAt, locale);
  const timeLabel = rowTimeLabel(item.startsAt, item.endsAt, locale);

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        style={[
          styles.card,
          { backgroundColor: isNacht ? palette.noir2 : palette.paper2 },
          cardStyle,
        ]}
      >
        {photo ? (
          <Image
            source={{ uri: photo }}
            style={styles.cardPhoto}
            contentFit="cover"
          />
        ) : (
          <View
            style={[
              styles.cardPhoto,
              { backgroundColor: isNacht ? palette.noir3 : palette.paper },
            ]}
          />
        )}
        {/* Genuanceerde bottom-gradient — alleen onderaan tinten zodat
            de tekst leesbaar wordt zonder dat de foto bovenaan z'n
            karakter verliest. */}
        <LinearGradient
          colors={['transparent', 'rgba(10,10,11,0.0)', 'rgba(10,10,11,0.78)']}
          locations={[0, 0.45, 1]}
          style={styles.cardGradient}
          pointerEvents="none"
        />
        <View style={styles.cardOverlay}>
          <View style={styles.cardLabels}>
            <View
              style={[styles.cardTag, { backgroundColor: roles.accent }]}
            >
              <Text
                style={[styles.cardTagText, { color: roles.onAccent }]}
              >
                {translateCategory(item.event.category, locale)}
              </Text>
            </View>
          </View>
          <View style={styles.cardBottom}>
            <Text style={styles.cardWhen}>{`${dateLabel} · ${timeLabel}`}</Text>
            <Text style={styles.cardTitle} numberOfLines={3}>
              {item.event.title}
            </Text>
            <Text style={styles.cardVenue} numberOfLines={1}>
              {item.event.venue.name}
            </Text>
          </View>
        </View>
        <Animated.View
          pointerEvents="none"
          style={[
            styles.choiceOverlay,
            { backgroundColor: yesBg },
            yesOverlayStyle,
          ]}
        >
          <Ionicons name="heart" size={120} color={yesFg} />
        </Animated.View>
        <Animated.View
          pointerEvents="none"
          style={[
            styles.choiceOverlay,
            { backgroundColor: noBg },
            noOverlayStyle,
          ]}
        >
          <Ionicons name="time-outline" size={120} color={noFg} />
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  );
});

function SwipeLegend({
  onSkip,
  onMoreInfo,
  onLike,
}: {
  onSkip: () => void;
  onMoreInfo: () => void;
  onLike: () => void;
}) {
  const roles = useRoles();
  const t = useT();
  // hitSlop maakt de tikzone royaler dan de visuele label-tekst, zonder
  // de strip zelf groter te tekenen.
  const slop = { top: 16, bottom: 16, left: 12, right: 12 };
  return (
    <View style={styles.swipeLegend}>
      <Pressable onPress={onSkip} hitSlop={slop} style={styles.legendItem}>
        <Ionicons name="arrow-back" size={14} color={roles.fgMuted} />
        <Text style={[styles.legendLabel, { color: roles.fgMuted }]}>
          {t('nog niet', 'not yet')}
        </Text>
      </Pressable>
      <Pressable onPress={onMoreInfo} hitSlop={slop} style={styles.legendItem}>
        <Ionicons name="arrow-up" size={14} color={roles.fgMuted} />
        <Text style={[styles.legendLabel, { color: roles.fgMuted }]}>
          {t('meer info', 'more info')}
        </Text>
      </Pressable>
      <Pressable onPress={onLike} hitSlop={slop} style={styles.legendItem}>
        <Text style={[styles.legendLabel, { color: roles.fgMuted }]}>
          {t('leuk', 'like')}
        </Text>
        <Ionicons name="arrow-forward" size={14} color={roles.fgMuted} />
      </Pressable>
    </View>
  );
}

function Recap({
  total,
  likes,
  locale,
  onContinue,
}: {
  total: number;
  likes: StackEvent[];
  locale: Locale;
  onContinue: () => void;
}) {
  const roles = useRoles();
  const mode = useMode();
  const isNacht = mode === 'nacht';
  const t = useT();
  // Groepeer de likes per kalenderdag — net als Agenda toont 'n
  // datum-header boven elke groep zodat de rotated time-cell rechts
  // alleen het kloktijdje hoeft te dragen.
  const grouped = useMemo(() => {
    const groups: {
      key: string;
      dateLabel: string;
      items: StackEvent[];
    }[] = [];
    const sorted = [...likes].sort(
      (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()
    );
    for (const l of sorted) {
      const d = new Date(l.startsAt);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const dateLabel = `${dowMixed(d.getDay(), locale)} ${d.getDate()} ${monthShort(
        d.getMonth(),
        locale
      ).toLowerCase()}`;
      const existing = groups.find((g) => g.key === key);
      if (existing) existing.items.push(l);
      else groups.push({ key, dateLabel, items: [l] });
    }
    return groups;
  }, [likes, locale]);
  return (
    <View style={styles.recapWrap}>
      <Text style={[styles.recapKicker, { color: roles.fgMuted }]}>
        {t(`Dat waren er ${total} voor vandaag`, `That was ${total} for today`)}
      </Text>
      <Text style={[styles.recapHead, { color: roles.fg }]}>
        {likes.length === 0
          ? t('Niks van dat al', 'Nothing this time')
          : likes.length === 1
            ? t('Deze vond je leuk', 'You liked this one')
            : t(
                `Deze ${likes.length} vond je leuk`,
                `You liked these ${likes.length}`
              )}
      </Text>
      {likes.length > 0 && (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.recapList}
          style={styles.recapListWrap}
        >
          {grouped.map((g) => (
            <View key={g.key}>
              <Text style={[styles.recapDate, { color: roles.fg }]}>
                {g.dateLabel}
              </Text>
              {g.items.map((item) => (
                <RecapRow key={item.occurrenceId} item={item} locale={locale} />
              ))}
            </View>
          ))}
        </ScrollView>
      )}
      <View style={styles.recapBtnStack}>
        <Pressable
          onPress={onContinue}
          style={[styles.recapBtn, { backgroundColor: roles.accent }]}
        >
          <Text style={[styles.recapBtnText, { color: roles.onAccent }]}>
            {t('Verder swipen', 'Keep swiping')}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => router.back()}
          style={[
            styles.recapBtn,
            {
              backgroundColor: isNacht ? palette.noir2 : palette.paper2,
              borderColor: isNacht ? '#2a2a2d' : palette.paper,
              borderWidth: 1,
              // 1px border bovenkant + 1px onderkant = 2px extra hoogte;
              // padding 1px omlaag om gelijk te trekken met de
              // border-loze "Verder swipen"-button.
              paddingVertical: 15,
            },
          ]}
        >
          <Text style={[styles.recapBtnText, { color: roles.fg }]}>
            {t('Sluit', 'Close')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function RecapRow({ item, locale }: { item: StackEvent; locale: Locale }) {
  const venueType = item.event.venue.type;
  const venueTone = venueType ? VENUE_TYPE_TICK[venueType] : undefined;
  return (
    <EventListRow
      time={rowTimeLabel(item.startsAt, item.endsAt, locale)}
      thumb={eventImageUrl(item.event) ?? ''}
      title={item.event.title}
      venue={item.event.venue.name}
      venueTone={venueTone}
      tags={[
        {
          label: translateCategory(item.event.category, locale),
          tone: CATEGORY_TICK[item.event.category],
        },
      ]}
      tick={CATEGORY_TICK[item.event.category]}
      onPress={() =>
        router.push(
          `/event/${item.event.id}?o=${item.occurrenceId}` as never
        )
      }
    />
  );
}

function formatStackDate(iso: string, locale: Locale): string {
  const d = new Date(iso);
  return `${dowMixed(d.getDay(), locale)} ${d.getDate()} ${monthShort(
    d.getMonth(),
    locale
  ).toLowerCase()}`;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: {
    flex: 1,
    paddingHorizontal: 22,
  },
  centerWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dim: {
    fontFamily: fontFamily.mono,
    fontSize: 12,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },

  stackArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    position: 'absolute',
    width: '100%',
    aspectRatio: 0.72,
    borderRadius: 22,
    overflow: 'hidden',
  },
  cardPhoto: {
    ...StyleSheet.absoluteFillObject,
  },
  cardOverlay: {
    flex: 1,
    padding: 18,
    justifyContent: 'space-between',
  },
  cardGradient: {
    ...StyleSheet.absoluteFillObject,
  },
  cardLabels: {
    flexDirection: 'row',
    gap: 6,
  },
  cardTag: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  cardTagText: {
    fontFamily: fontFamily.monoMedium,
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  cardBottom: { gap: 8 },

  swipeLegend: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 18,
    paddingHorizontal: 8,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  legendLabel: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  cardWhen: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: 'rgba(245,241,232,0.92)',
  },
  cardTitle: {
    fontFamily: fontFamily.display,
    fontSize: 30,
    lineHeight: 30 * 0.95,
    letterSpacing: -1.0,
    color: palette.paper3,
  },
  cardVenue: {
    fontFamily: fontFamily.monoMedium,
    fontSize: 12,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: 'rgba(245,241,232,0.88)',
  },

  // Vol-formaat kleur-overlay — wordt opaque-er naarmate je swipet.
  // Grote display-letters in 't midden zodat het label duidelijk leest
  // zonder dat 't een postzegel-stempel wordt.
  choiceOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },

  recapWrap: {
    flex: 1,
    paddingTop: 16,
  },
  recapKicker: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: 2,
  },
  recapHead: {
    fontFamily: fontFamily.display,
    fontSize: 28,
    letterSpacing: -0.8,
    marginBottom: 12,
  },
  // Negatieve marginHorizontal heft de body-padding van 22 op zodat
  // EventListRow z'n eigen interne padding kan dragen — anders krijg
  // je 44px aan elke kant en wordt de rij te smal.
  recapListWrap: {
    marginHorizontal: -22,
  },
  recapList: {
    paddingTop: 4,
    paddingBottom: 16,
  },
  recapDate: {
    fontFamily: fontFamily.display,
    fontSize: 18,
    letterSpacing: -0.36,
    paddingHorizontal: 22,
    paddingTop: 16,
    paddingBottom: 4,
  },
  recapBtnStack: {
    marginTop: 'auto',
    gap: 10,
  },
  recapBtn: {
    alignSelf: 'stretch',
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
  },
  recapBtnText: {
    fontFamily: fontFamily.medium,
    fontSize: 14.5,
    letterSpacing: -0.07,
  },
});
