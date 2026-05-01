import { Ionicons } from '@expo/vector-icons';
import MaskedView from '@react-native-masked-view/masked-view';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedRef,
  useAnimatedStyle,
  useScrollViewOffset,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ApiEvent } from '@/lib/api';
import {
  CATEGORY_TICK,
  DOW_NL_MIXED,
  MONTHS_NL,
  formatPrice,
  formatTime,
} from '@/lib/eventDisplay';
import { useEvent } from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
import { useIsSaved, useSavedStore, type SavedEvent } from '@/store/saved';
import { fontFamily, palette } from '@/theme/tokens';

const HERO_HEIGHT = 420;

/**
 * Event detail screen — fetches via GET /events/:id. Until lineup,
 * photo strip and friends bestaan in de DB blijven die secties leeg.
 */
export default function EventDetail() {
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const id = rawId ?? '';
  const mode = useMode();
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const isNacht = mode === 'nacht';

  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const scrollY = useScrollViewOffset(scrollRef);
  const stickyStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      scrollY.value,
      [HERO_HEIGHT - 140, HERO_HEIGHT - 60],
      [0, 1],
      Extrapolation.CLAMP
    ),
  }));
  const heroStyle = useAnimatedStyle(() => {
    const offset = Math.min(0, scrollY.value);
    const scale = 1 - offset / HERO_HEIGHT;
    return {
      transform: [
        { translateY: ((scale - 1) * HERO_HEIGHT) / 2 },
        { scale },
      ],
    };
  });

  const { data: event, isLoading, error } = useEvent(id);

  if (isLoading || (!event && !error)) {
    return <DetailFallback>Laden…</DetailFallback>;
  }
  if (error || !event) {
    return (
      <DetailFallback tone="error">Dit event is niet beschikbaar.</DetailFallback>
    );
  }

  const view = toViewModel(event);
  const stickyTitle = view.title;

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      {/* Pinned photo + gradient — stays fixed while content scrolls over it,
          stretches downward when the user pulls past the top. */}
      <Animated.View
        style={[
          styles.heroPinned,
          { backgroundColor: isNacht ? palette.noir : palette.forest },
          heroStyle,
        ]}
      >
        {view.photo && (
          <Image
            source={{ uri: view.photo }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
          />
        )}
        <LinearGradient
          colors={
            isNacht
              ? ['rgba(10,10,11,0.4)', 'rgba(10,10,11,0.2)', 'rgba(10,10,11,0.95)']
              : ['rgba(45,74,62,0.4)', 'rgba(45,74,62,0.3)', 'rgba(45,74,62,0.85)']
          }
          locations={[0, 0.4, 1]}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>

      <Animated.ScrollView
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + 120 }}
      >
        {/* Transparent hero spacer with the tag + title at the bottom.
            Scrolls with content; the body covers it on scroll-up. */}
        <View style={styles.heroSpacer}>
          <View style={styles.heroBottom}>
            <View
              style={[
                styles.tag,
                { backgroundColor: isNacht ? palette.acid : palette.paper3 },
              ]}
            >
              <Text
                style={[
                  styles.tagText,
                  { color: isNacht ? palette.noir : palette.soil },
                ]}
              >
                {view.tag}
              </Text>
            </View>
            <Text style={styles.heroTitle}>{view.title}</Text>
          </View>
        </View>

        <View style={[styles.body, { backgroundColor: roles.bg }]}>
          <View style={styles.metaRow}>
            <MetaCell label="Datum" value={view.date} />
            <MetaCell label="Aanvang" value={view.time} />
            <MetaCell
              label="Venue"
              value={view.venue}
              onPress={() => router.push(`/venue/${event.venue.slug}`)}
            />
          </View>

          {view.description && (
            <Text style={[styles.bodyText, { color: roles.fgRead }]}>
              {view.description}
            </Text>
          )}

          <Pressable
            style={[
              styles.invite,
              { borderColor: isNacht ? '#2a2a2e' : palette.paper },
            ]}
          >
            <Ionicons name="person-add-outline" size={18} color={roles.fg} />
            <Text style={[styles.inviteText, { color: roles.fg }]}>
              Vraag iemand anders mee
            </Text>
            <Text style={[styles.inviteChev, { color: roles.fgPlaceholder }]}>
              ›
            </Text>
          </Pressable>
        </View>
      </Animated.ScrollView>

      {/* Top bar: back + title + actions, all on the same row.
          The blur background and title fade in once the hero title
          scrolls out; the circle buttons stay visible throughout. */}
      <View
        style={[
          styles.topBar,
          { height: insets.top + 50, paddingTop: insets.top + 2 },
        ]}
      >
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, stickyStyle]}
        >
          <MaskedView
            style={StyleSheet.absoluteFill}
            maskElement={
              <LinearGradient
                colors={['#000', '#000', 'transparent']}
                locations={[0, 0.8, 1]}
                style={StyleSheet.absoluteFill}
              />
            }
          >
            <BlurView
              intensity={40}
              tint={isNacht ? 'dark' : 'light'}
              style={StyleSheet.absoluteFill}
            />
          </MaskedView>
        </Animated.View>

        <View style={styles.topBarRow}>
          <CircleButton icon="chevron-back" onPress={() => router.back()} />
          <Animated.View style={[styles.topBarTitleWrap, stickyStyle]}>
            <Text
              numberOfLines={1}
              style={[styles.stickyTitle, { color: roles.fg }]}
            >
              {stickyTitle}
            </Text>
          </Animated.View>
          <View style={styles.heroActions}>
            <HeartButton id={id} event={event} />
            <CircleButton icon="share-outline" />
          </View>
        </View>
      </View>

      <View
        style={[
          styles.ctaDock,
          { paddingBottom: Math.max(insets.bottom, 8), paddingTop: 32 },
        ]}
      >
        <LinearGradient
          colors={[
            isNacht ? 'rgba(10,10,11,0)' : 'rgba(245,241,232,0)',
            isNacht ? palette.noir : palette.paper3,
          ]}
          locations={[0, 0.45]}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.priceWrap}>
          <Text style={[styles.price, { color: roles.fg }]}>{view.price}</Text>
          {view.priceNote && (
            <Text style={[styles.priceNote, { color: roles.fgMuted }]}>
              {view.priceNote}
            </Text>
          )}
        </View>
        <Pressable
          style={[
            styles.cta,
            { backgroundColor: isNacht ? palette.acid : palette.soil },
          ]}
        >
          <Text
            style={[
              styles.ctaText,
              { color: isNacht ? palette.noir : palette.paper3 },
            ]}
          >
            Reserveer
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function CircleButton({
  icon,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  onPress?: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={styles.circleBtn}>
      <Ionicons name={icon} size={20} color={palette.ink} />
    </Pressable>
  );
}

type ViewModel = {
  tag: string;
  title: string;
  date: string;
  time: string;
  venue: string;
  description: string | null;
  photo: string | null;
  price: string;
  priceNote: string | null;
};

function toViewModel(event: ApiEvent): ViewModel {
  const d = new Date(event.startsAt);
  const dow = DOW_NL_MIXED[d.getDay()];
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return {
    tag: event.category,
    title: event.title,
    date: `${dow} ${day}.${month}`,
    time: formatTime(event.startsAt),
    venue: event.venue.name,
    description: event.description,
    photo: event.imageUrl,
    price: formatPrice(event.priceCents),
    priceNote: event.priceCents && event.priceCents > 0 ? 'incl. servicekosten' : null,
  };
}

function buildSnapshot(id: string, event: ApiEvent): SavedEvent {
  const d = new Date(event.startsAt);
  return {
    id,
    dow: DOW_NL_MIXED[d.getDay()],
    num: String(d.getDate()).padStart(2, '0'),
    month: MONTHS_NL[d.getMonth()],
    time: formatTime(event.startsAt),
    duration: event.category.toLowerCase(),
    title: event.title,
    venue: event.venue.name,
    category: event.category,
    tick: CATEGORY_TICK[event.category],
    friends: [],
  };
}

function HeartButton({ id, event }: { id: string; event: ApiEvent }) {
  const mode = useMode();
  const isSaved = useIsSaved(id);
  const toggle = useSavedStore((s) => s.toggle);
  const scale = useSharedValue(1);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const onPress = () => {
    const nowSaved = toggle(buildSnapshot(id, event));
    scale.value = withSequence(
      withTiming(1.3, { duration: 140 }),
      withTiming(1, { duration: 180 })
    );
    if (nowSaved) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } else {
      Haptics.selectionAsync();
    }
  };

  const iconName = isSaved ? 'heart' : 'heart-outline';
  const iconColor = isSaved
    ? mode === 'nacht'
      ? palette.acid
      : palette.red
    : palette.ink;

  return (
    <Animated.View style={animStyle}>
      <Pressable onPress={onPress} style={styles.circleBtn}>
        <Ionicons name={iconName} size={20} color={iconColor} />
      </Pressable>
    </Animated.View>
  );
}

function DetailFallback({
  children,
  tone = 'muted',
}: {
  children: string;
  tone?: 'muted' | 'error';
}) {
  const mode = useMode();
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const isNacht = mode === 'nacht';
  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <View
        style={[
          styles.topBar,
          { height: insets.top + 50, paddingTop: insets.top + 2 },
        ]}
      >
        <View style={styles.topBarRow}>
          <CircleButton icon="chevron-back" onPress={() => router.back()} />
        </View>
      </View>
      <View style={styles.fallbackBody}>
        <Text
          style={[
            styles.fallbackText,
            { color: tone === 'error' ? '#c9453a' : roles.fgMuted },
          ]}
        >
          {children}
        </Text>
        {tone === 'error' && (
          <Pressable
            onPress={() => router.back()}
            style={[
              styles.fallbackAction,
              { borderColor: isNacht ? '#2a2a2e' : palette.paper },
            ]}
          >
            <Text style={[styles.fallbackActionText, { color: roles.fg }]}>
              Terug naar overzicht
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

function MetaCell({
  label,
  value,
  onPress,
}: {
  label: string;
  value: string;
  onPress?: () => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const Wrap = onPress ? Pressable : View;
  const borderColor = onPress
    ? roles.accent
    : isNacht
      ? '#232327'
      : palette.paper;
  return (
    <Wrap
      onPress={onPress}
      style={[
        styles.metaCell,
        {
          backgroundColor: isNacht ? '#101012' : palette.paper2,
          borderColor,
        },
      ]}
    >
      <Text style={[styles.metaLabel, { color: roles.fgMuted }]}>{label}</Text>
      <Text style={[styles.metaValue, { color: roles.fg }]}>{value}</Text>
    </Wrap>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  // Hero
  heroPinned: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: HERO_HEIGHT,
    overflow: 'hidden',
  },
  heroSpacer: {
    height: HERO_HEIGHT,
    paddingHorizontal: 18,
    paddingBottom: 20,
    justifyContent: 'flex-end',
  },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
  },
  topBarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    gap: 8,
  },
  topBarTitleWrap: {
    flex: 1,
    alignItems: 'center',
  },
  stickyTitle: {
    fontFamily: fontFamily.bold,
    fontSize: 14,
    letterSpacing: -0.21,
  },
  heroActions: { flexDirection: 'row', gap: 8 },
  circleBtn: {
    width: 40,
    height: 40,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroBottom: { gap: 12 },
  tag: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  tagText: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  heroTitle: {
    fontFamily: fontFamily.display,
    fontSize: 38,
    lineHeight: 38 * 0.92,
    letterSpacing: -1.5,
    color: palette.ink,
  },

  // Body
  body: { padding: 20 },

  // Meta row
  metaRow: { flexDirection: 'row', gap: 8, marginBottom: 20 },
  metaCell: {
    flex: 1,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  metaLabel: {
    fontFamily: fontFamily.mono,
    fontSize: 9,
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  },
  metaValue: {
    fontFamily: fontFamily.bold,
    fontSize: 14,
    letterSpacing: -0.21,
    marginTop: 4,
  },

  bodyText: {
    fontFamily: fontFamily.body,
    fontSize: 13,
    lineHeight: 20.8,
    marginBottom: 12,
  },

  // Loading / error fallback
  fallbackBody: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
  },
  fallbackText: {
    fontFamily: fontFamily.mono,
    fontSize: 12,
    letterSpacing: 0.6,
    textAlign: 'center',
    lineHeight: 18,
  },
  fallbackBackBtn: {
    width: 40,
    height: 40,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fallbackAction: {
    alignSelf: 'center',
    marginTop: 18,
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 999,
    borderWidth: 1,
  },
  fallbackActionText: {
    fontFamily: fontFamily.medium,
    fontSize: 13,
    letterSpacing: -0.07,
  },

  // Invite
  invite: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    marginTop: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  inviteText: {
    flex: 1,
    fontFamily: fontFamily.medium,
    fontSize: 13,
    letterSpacing: -0.07,
  },
  inviteChev: { fontFamily: fontFamily.mono, fontSize: 14 },

  // CTA dock
  ctaDock: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 20,
    paddingTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  priceWrap: { flex: 1 },
  price: {
    fontFamily: fontFamily.display,
    fontSize: 22,
    letterSpacing: -0.44,
  },
  priceNote: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginTop: 2,
    opacity: 0.7,
  },
  cta: {
    paddingHorizontal: 22,
    paddingVertical: 14,
    borderRadius: 999,
  },
  ctaText: {
    fontFamily: fontFamily.medium,
    fontSize: 13,
    letterSpacing: -0.07,
  },
});
