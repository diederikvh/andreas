import { Ionicons } from '@expo/vector-icons';
import MaskedView from '@react-native-masked-view/masked-view';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
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

import { EventListRow } from '@/components/EventListRow';
import type { ApiVenueProgramItem } from '@/lib/api';
import {
  CATEGORY_TICK,
  DOW_NL_MIXED,
  MONTHS_NL,
  formatTime,
} from '@/lib/eventDisplay';
import { useVenue } from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
import { useIsVenueSaved, useSavedVenuesStore } from '@/store/savedVenues';
import { fontFamily, palette } from '@/theme/tokens';

const HERO_HEIGHT = 380;

export default function VenueDetail() {
  const { slug: rawSlug } = useLocalSearchParams<{ slug: string }>();
  const slug = rawSlug ?? '';
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

  const { data, isLoading, error } = useVenue(slug);

  if (isLoading || (!data && !error)) {
    return <VenueFallback>Laden…</VenueFallback>;
  }
  if (error || !data) {
    return (
      <VenueFallback tone="error">
        Deze venue is niet beschikbaar.
      </VenueFallback>
    );
  }

  const { venue, events } = data;
  const [addrLine1, ...rest] = venue.address.split(',');
  const addrLine2 = rest.join(',').trim();

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <Animated.View
        style={[
          styles.heroPinned,
          { backgroundColor: isNacht ? palette.noir : palette.forest },
          heroStyle,
        ]}
      >
        {venue.imageUrl && (
          <Image
            source={{ uri: venue.imageUrl }}
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
        contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
      >
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
                Venue
              </Text>
            </View>
            <Text style={styles.heroTitle}>{venue.name}</Text>
          </View>
        </View>

        <View style={[styles.body, { backgroundColor: roles.bg }]}>
          <View
            style={[
              styles.addr,
              { borderColor: isNacht ? '#1f1f23' : palette.paper },
            ]}
          >
            <Text style={[styles.addrLine, { color: roles.fgRead }]}>
              {addrLine1}
            </Text>
            {addrLine2.length > 0 && (
              <Text style={[styles.addrLine, { color: roles.fgRead }]}>
                {addrLine2}
              </Text>
            )}
          </View>

          <Pressable
            onPress={() => openMaps(venue.name, venue.lat, venue.lng)}
            style={[
              styles.actionPrimary,
              {
                backgroundColor: isNacht ? palette.acid : palette.red,
              },
            ]}
          >
            <Ionicons
              name="navigate-outline"
              size={16}
              color={isNacht ? palette.noir : palette.paper3}
            />
            <Text
              style={[
                styles.actionPrimaryText,
                { color: isNacht ? palette.noir : palette.paper3 },
              ]}
            >
              Route openen
            </Text>
          </Pressable>

          {venue.description && (
            <Text style={[styles.desc, { color: roles.fgRead }]}>
              {venue.description}
            </Text>
          )}
        </View>

        <View style={styles.progHead}>
          <Text style={[styles.progLabel, { color: roles.fg }]}>Programma</Text>
          <Text style={[styles.progCount, { color: roles.fgMuted }]}>
            {events.length} komend
          </Text>
        </View>

        {events.length === 0 && (
          <Text style={[styles.progEmpty, { color: roles.fgMuted }]}>
            Niets aangekondigd voor de komende periode.
          </Text>
        )}
        {events.map((e) => (
          <ProgramRow key={e.id} event={e} />
        ))}
      </Animated.ScrollView>

      {/* Top bar */}
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
              {venue.name}
            </Text>
          </Animated.View>
          <SaveVenueIcon slug={venue.slug} />
        </View>
      </View>
    </View>
  );
}

function ProgramRow({ event }: { event: ApiVenueProgramItem }) {
  const d = new Date(event.startsAt);
  const dow = DOW_NL_MIXED[d.getDay()];
  const num = String(d.getDate()).padStart(2, '0');
  const month = MONTHS_NL[d.getMonth()].toLowerCase();
  return (
    <EventListRow
      time={formatTime(event.startsAt)}
      duration={`${dow} ${num} ${month}`}
      thumb={event.imageUrl ?? ''}
      title={event.title}
      venue=""
      tags={[{ label: event.category, tone: CATEGORY_TICK[event.category] }]}
      tick={CATEGORY_TICK[event.category]}
      onPress={() => router.push(`/event/${event.id}`)}
    />
  );
}

function SaveVenueIcon({ slug }: { slug: string }) {
  const mode = useMode();
  const isSaved = useIsVenueSaved(slug);
  const toggle = useSavedVenuesStore((s) => s.toggle);
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const onPress = () => {
    const nowSaved = toggle(slug);
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

  const iconName = isSaved ? 'bookmark' : 'bookmark-outline';
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

function VenueFallback({
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
              Terug
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

function openMaps(name: string, lat: number, lng: number) {
  // Apple Maps op iOS, Google Maps elders. Beide formaten worden door de
  // andere ook geaccepteerd, maar dit is wat het OS native opent.
  const label = encodeURIComponent(name);
  const url =
    Platform.OS === 'ios'
      ? `maps:0,0?q=${label}@${lat},${lng}`
      : `geo:${lat},${lng}?q=${lat},${lng}(${label})`;
  Linking.openURL(url).catch(() => {
    // Final fallback: web Google Maps
    Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${lat},${lng}`);
  });
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

  // Top bar
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
  circleBtn: {
    width: 40,
    height: 40,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Body
  body: { padding: 20, gap: 14 },

  // Address
  addr: {
    paddingTop: 12,
    paddingBottom: 14,
    borderTopWidth: 1,
    borderBottomWidth: 1,
  },
  addrLine: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.21,
    lineHeight: 20,
  },

  // Action button
  actionPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 13,
    borderRadius: 999,
  },
  actionPrimaryText: {
    fontFamily: fontFamily.medium,
    fontSize: 13,
    letterSpacing: -0.07,
  },

  desc: {
    fontFamily: fontFamily.body,
    fontSize: 13,
    lineHeight: 20.8,
    marginTop: 4,
  },

  // Programma header — outside the body padding, matches Agenda inset.
  progHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingHorizontal: 22,
    paddingTop: 14,
    paddingBottom: 6,
  },
  progLabel: {
    fontFamily: fontFamily.bold,
    fontSize: 12,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  progCount: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  progEmpty: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.6,
    paddingHorizontal: 22,
    paddingVertical: 12,
  },

  // Fallback
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
});
