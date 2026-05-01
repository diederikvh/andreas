import { Ionicons } from '@expo/vector-icons';
import MaskedView from '@react-native-masked-view/masked-view';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { Fragment } from 'react';
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

import type { BadgeTone } from '@/mocks/feed';
import { DETAIL, type DetailData } from '@/mocks/detail';
import { useMode, useRoles } from '@/store/mode';
import { useIsSaved, useSavedStore, type SavedEvent } from '@/store/saved';
import { fontFamily, palette } from '@/theme/tokens';

const HERO_HEIGHT = 420;

/**
 * Event detail screen. Until fase 4 wires real data, every event tap
 * lands on the same per-mode mock — the route accepts an id so the
 * shape is right for later.
 */
export default function EventDetail() {
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const id = rawId ?? 'detail';
  const mode = useMode();
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const data = DETAIL[mode];
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
  // Pull-to-zoom: when the user over-scrolls (negative scrollY), grow
  // the hero photo from its top edge so it pushes downward with the
  // bounce. translateY emulates `transformOrigin: 'top'`.
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
  const stickyTitle = data.title.replace(/\n/g, ' ');

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
        <Image
          source={{ uri: data.photo }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
        />
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
                {data.tag}
              </Text>
            </View>
            <Text style={styles.heroTitle}>{data.title}</Text>
          </View>
        </View>

        <View style={[styles.body, { backgroundColor: roles.bg }]}>
          <View style={styles.metaRow}>
            <MetaCell label="Datum" value={data.date} />
            <MetaCell label="Aanvang" value={data.time} />
            <MetaCell label="Venue" value={data.venue} />
          </View>

          <Text style={[styles.bodyText, { color: roles.fgRead }]}>
            {data.description}
          </Text>

          <View style={styles.photoStrip}>
            {data.photoStrip.map((url) => (
              <Image
                key={url}
                source={{ uri: url }}
                style={styles.photoStripItem}
                contentFit="cover"
              />
            ))}
          </View>

          <Text style={[styles.h4, { color: roles.fg }]}>Line-up</Text>
          <View style={styles.lineup}>
            {data.lineup.map((item) => (
              <View
                key={item.name}
                style={[
                  styles.lineupRow,
                  {
                    backgroundColor: isNacht ? '#101012' : palette.paper2,
                    borderColor: isNacht ? '#232327' : palette.paper,
                  },
                ]}
              >
                <Text style={[styles.lineupName, { color: roles.fg }]}>
                  {item.name}
                </Text>
                <Text style={[styles.lineupTime, { color: roles.fgMuted }]}>
                  {item.time}
                </Text>
              </View>
            ))}
          </View>

          <Text style={[styles.h4, styles.h4Spaced, { color: roles.fg }]}>
            Vrienden gaan ook
          </Text>
          <View
            style={[
              styles.friends,
              {
                backgroundColor: isNacht ? '#101012' : palette.paper2,
                borderColor: isNacht ? '#232327' : palette.paper,
              },
            ]}
          >
            <View style={styles.friendsAvatars}>
              {data.friends.avatars.map((url, i) => (
                <Image
                  key={url}
                  source={{ uri: url }}
                  style={[
                    styles.avatar,
                    {
                      borderColor: isNacht ? '#101012' : palette.paper2,
                      marginLeft: i === 0 ? 0 : -8,
                    },
                  ]}
                />
              ))}
            </View>
            <Text style={[styles.friendsText, { color: roles.fgRead }]}>
              {data.friends.names.map((name, i, arr) => (
                <Fragment key={name}>
                  <Text style={[styles.friendsName, { color: roles.fg }]}>
                    {name}
                  </Text>
                  {i < arr.length - 2 ? ', ' : i === arr.length - 2 ? ' en ' : ''}
                </Fragment>
              ))}
              {' '}{data.friends.suffix}
            </Text>
          </View>

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
            <HeartButton id={id} data={data} />
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
          <Text style={[styles.price, { color: roles.fg }]}>{data.price}</Text>
          <Text style={[styles.priceNote, { color: roles.fgMuted }]}>
            {data.priceNote}
          </Text>
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

const MONTHS_NL = [
  'JAN', 'FEB', 'MRT', 'APR', 'MEI', 'JUN',
  'JUL', 'AUG', 'SEP', 'OKT', 'NOV', 'DEC',
];

const CATEGORY_TICK: Record<string, BadgeTone> = {
  Muziek: 'acid',
  Theater: 'flare',
  Literatuur: 'plum',
  Film: 'azure',
};

function buildSnapshot(id: string, data: DetailData): SavedEvent {
  // "Vr 25.04" → dow "Vr", num "25", month "APR"
  const [dow = '', date = ''] = data.date.split(' ');
  const [num = '', mm = ''] = date.split('.');
  const monthIdx = Math.max(0, Math.min(11, parseInt(mm, 10) - 1));
  // "Muziek · post-punk" → category "Muziek", duration "post-punk"
  const [categoryRaw = 'Muziek', durationRaw = ''] = data.tag.split(' · ');
  const category = categoryRaw.trim();
  return {
    id,
    dow,
    num,
    month: MONTHS_NL[monthIdx] ?? '',
    time: data.time,
    duration: durationRaw.trim() || category.toLowerCase(),
    title: data.title.replace(/\n/g, ' ').replace(/-\s+/g, ''),
    venue: data.venue,
    category,
    tick: CATEGORY_TICK[category] ?? 'acid',
    friends: data.friends.names.map((name, i) => ({
      name,
      avatar: data.friends.avatars[i] ?? data.friends.avatars[0],
    })),
  };
}

function HeartButton({ id, data }: { id: string; data: DetailData }) {
  const mode = useMode();
  const isSaved = useIsSaved(id);
  const toggle = useSavedStore((s) => s.toggle);
  const scale = useSharedValue(1);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const onPress = () => {
    const nowSaved = toggle(buildSnapshot(id, data));
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

function MetaCell({ label, value }: { label: string; value: string }) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  return (
    <View
      style={[
        styles.metaCell,
        {
          backgroundColor: isNacht ? '#101012' : palette.paper2,
          borderColor: isNacht ? '#232327' : palette.paper,
        },
      ]}
    >
      <Text style={[styles.metaLabel, { color: roles.fgMuted }]}>{label}</Text>
      <Text style={[styles.metaValue, { color: roles.fg }]}>{value}</Text>
    </View>
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

  // Photo strip
  photoStrip: { flexDirection: 'row', gap: 6, marginVertical: 12 },
  photoStripItem: { flex: 1, aspectRatio: 1, borderRadius: 6 },

  h4: {
    fontFamily: fontFamily.bold,
    fontSize: 12,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginVertical: 10,
    marginTop: 20,
  },
  h4Spaced: { marginTop: 24 },

  // Lineup
  lineup: { gap: 6 },
  lineupRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  lineupName: {
    fontFamily: fontFamily.bold,
    fontSize: 13,
    letterSpacing: -0.13,
  },
  lineupTime: { fontFamily: fontFamily.mono, fontSize: 10 },

  // Friends
  friends: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
  },
  friendsAvatars: { flexDirection: 'row' },
  avatar: { width: 28, height: 28, borderRadius: 999, borderWidth: 2 },
  friendsText: {
    flex: 1,
    fontFamily: fontFamily.body,
    fontSize: 12.5,
    lineHeight: 17.5,
  },
  friendsName: { fontFamily: fontFamily.bold },

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
