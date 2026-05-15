import { Ionicons } from '@expo/vector-icons';
import MaskedView from '@react-native-masked-view/masked-view';
import { BlurView } from 'expo-blur';
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
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EventListRow } from '@/components/EventListRow';
import { SpinningCross } from '@/components/SpinningCross';
import type { ApiEvent } from '@/lib/api';
import {
  eventImageUrl,
  CATEGORY_TICK,
  dowMixed,
  monthShort,
  rowTimeLabel,
  translateCategory,
} from '@/lib/eventDisplay';
import { useLocale, useT, type Locale } from '@/lib/i18n';
import { useSeries } from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

const HERO_HEIGHT = 380;

export default function SeriesDetail() {
  const { slug: rawSlug } = useLocalSearchParams<{ slug: string }>();
  const slug = rawSlug ?? '';
  const mode = useMode();
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const isNacht = mode === 'nacht';
  const t = useT();
  const locale = useLocale();

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

  const { data, isLoading, error } = useSeries(slug);

  if (isLoading || (!data && !error)) {
    return <SeriesFallback>{undefined}</SeriesFallback>;
  }
  if (error || !data) {
    return (
      <SeriesFallback tone="error">
        {t('Deze serie is niet beschikbaar.', 'This series is not available.')}
      </SeriesFallback>
    );
  }

  const { series, events } = data;
  const dateRange = formatDateRange(series.startsAt, series.endsAt, locale, t);

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <Animated.View
        style={[
          styles.heroPinned,
          { backgroundColor: isNacht ? palette.noir : palette.forest },
          heroStyle,
        ]}
      >
        {series.imageUrl && (
          <Image
            source={{ uri: series.imageUrl }}
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
                {t('Serie', 'Series')}
              </Text>
            </View>
            <Text style={styles.heroTitle}>{series.name}</Text>
          </View>
        </View>

        <View style={[styles.body, { backgroundColor: roles.bg }]}>
          {dateRange && (
            <View
              style={[
                styles.dateRow,
                { borderColor: isNacht ? '#1f1f23' : palette.paper },
              ]}
            >
              <Text style={[styles.dateText, { color: roles.fgRead }]}>
                {dateRange}
              </Text>
            </View>
          )}
          {series.description && (
            <Text style={[styles.desc, { color: roles.fgRead }]}>
              {series.description}
            </Text>
          )}
        </View>

        <View style={[styles.progSection, { backgroundColor: roles.bg }]}>
          <View style={styles.progHead}>
            <Text style={[styles.progLabel, { color: roles.fg }]}>
              {t('Programma', 'Programme')}
            </Text>
            <Text style={[styles.progCount, { color: roles.fgMuted }]}>
              {events.length} {t('komend', 'upcoming')}
            </Text>
          </View>

          {events.length === 0 && (
            <Text style={[styles.progEmpty, { color: roles.fgMuted }]}>
              {t(
                'Niets aangekondigd voor de komende periode.',
                'Nothing announced for the coming period.'
              )}
            </Text>
          )}
          {events.map((e) => (
            <ProgramRow key={e.id} event={e} />
          ))}
        </View>
      </Animated.ScrollView>

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
              {series.name}
            </Text>
          </Animated.View>
          <View style={styles.topBarSpacer} />
        </View>
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

function ProgramRow({ event }: { event: ApiEvent }) {
  const locale = useLocale();
  const d = new Date(event.startsAt);
  const dow = dowMixed(d.getDay(), locale);
  const num = String(d.getDate()).padStart(2, '0');
  const month = monthShort(d.getMonth(), locale).toLowerCase();
  return (
    <EventListRow
      time={rowTimeLabel(event.startsAt, event.endsAt, locale)}
      duration={`${dow} ${num} ${month}`}
      thumb={eventImageUrl(event) ?? ''}
      title={event.title}
      venue={event.venue.name}
      tags={[
        {
          label: translateCategory(event.category, locale),
          tone: CATEGORY_TICK[event.category],
        },
      ]}
      tick={CATEGORY_TICK[event.category]}
      onPress={() => router.push(`/event/${event.id}?source=series`)}
    />
  );
}

function formatDateRange(
  startsAt: string | null,
  endsAt: string | null,
  locale: Locale,
  t: (nl: string, en: string) => string
): string | null {
  if (!startsAt) return null;
  const start = new Date(startsAt);
  const end = endsAt ? new Date(endsAt) : null;
  const monthName = (d: Date) => monthShort(d.getMonth(), locale).toLowerCase();
  const day = (d: Date) => String(d.getDate());

  if (!end) {
    return t(
      `Vanaf ${day(start)} ${monthName(start)}`,
      `From ${day(start)} ${monthName(start)}`
    );
  }

  const sameDay =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate();
  if (sameDay) return `${day(start)} ${monthName(start)}`;

  const sameMonth =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth();
  if (sameMonth)
    return `${day(start)} – ${day(end)} ${monthName(start)}`;

  return `${day(start)} ${monthName(start)} – ${day(end)} ${monthName(end)}`;
}

function SeriesFallback({
  children,
  tone = 'muted',
}: {
  children?: string;
  tone?: 'muted' | 'error';
}) {
  const roles = useRoles();
  const insets = useSafeAreaInsets();
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
        {children ? (
          <Text
            style={[
              styles.fallbackText,
              { color: tone === 'error' ? '#c9453a' : roles.fgMuted },
            ]}
          >
            {children}
          </Text>
        ) : (
          <SpinningCross size={32} color={roles.fgPlaceholder} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

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
  topBarTitleWrap: { flex: 1, alignItems: 'center' },
  topBarSpacer: { width: 40 },
  stickyTitle: {
    fontFamily: fontFamily.bold,
    fontSize: 14,
    letterSpacing: -0.21,
  },

  body: { padding: 20, gap: 14 },
  dateRow: {
    paddingTop: 12,
    paddingBottom: 14,
    borderTopWidth: 1,
    borderBottomWidth: 1,
  },
  dateText: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.21,
    lineHeight: 20,
  },
  desc: {
    fontFamily: fontFamily.body,
    fontSize: 14.5,
    lineHeight: 20.8,
    marginTop: 4,
  },

  // Wrapper rond de hele programma-sectie zodat de hero-foto er niet
  // doorheen blijft schijnen wanneer je voorbij de body scrollt.
  progSection: {
    paddingBottom: 16,
  },
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

  circleBtn: {
    width: 40,
    height: 40,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
