import { Ionicons } from '@expo/vector-icons';
import MaskedView from '@react-native-masked-view/masked-view';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import {
  Linking,
  Modal,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedRef,
  useAnimatedStyle,
  useScrollViewOffset,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Cross } from '@/components/Cross';
import { EventListRow } from '@/components/EventListRow';
import type { ApiVenueProgramItem, VenueFollowState } from '@/lib/api';
import {
  CATEGORY_TICK,
  DOW_NL_MIXED,
  MONTHS_NL,
  formatTime,
} from '@/lib/eventDisplay';
import { useSession } from '@/lib/authClient';
import { useSetVenueFollow, useVenue } from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
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
          <View style={styles.topBarActions}>
            <FollowVenueButton
              venueId={venue.id}
              name={venue.name}
              state={data?.myFollowState ?? 'normaal'}
            />
            <ShareVenueButton slug={venue.slug} name={venue.name} />
          </View>
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

function FollowVenueButton({
  venueId,
  name,
  state,
}: {
  venueId: string;
  name: string;
  state: VenueFollowState;
}) {
  const mode = useMode();
  const { data: session } = useSession();
  const authed = Boolean(session?.user?.id);
  const setFollow = useSetVenueFollow();
  const [sheetOpen, setSheetOpen] = useState(false);

  const iconName: keyof typeof Ionicons.glyphMap =
    state === 'volgen'
      ? 'heart'
      : state === 'blokken'
        ? 'ban-outline'
        : 'heart-outline';
  const iconColor =
    state === 'volgen'
      ? mode === 'nacht'
        ? palette.acid
        : palette.red
      : state === 'blokken'
        ? palette.ink
        : palette.ink;

  const onPick = (next: VenueFollowState) => {
    setSheetOpen(false);
    if (next === state) return;
    Haptics.selectionAsync();
    setFollow.mutate({ venueId, state: next });
  };

  const onTap = () => {
    if (!authed) {
      // Niet ingelogd → naar Jij waar de inlog-flow leeft. Andreas
      // onthoudt geen lokale follow-state meer (server-only).
      router.push('/jij');
      return;
    }
    setSheetOpen(true);
  };

  return (
    <>
      <Pressable onPress={onTap} style={styles.circleBtn}>
        <Ionicons name={iconName} size={20} color={iconColor} />
      </Pressable>
      <Modal
        visible={sheetOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setSheetOpen(false)}
      >
        <FollowVenueSheet
          name={name}
          current={state}
          onPick={onPick}
          onClose={() => setSheetOpen(false)}
        />
      </Modal>
    </>
  );
}

function FollowVenueSheet({
  name,
  current,
  onPick,
  onClose,
}: {
  name: string;
  current: VenueFollowState;
  onPick: (next: VenueFollowState) => void;
  onClose: () => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';

  const options: {
    state: VenueFollowState;
    title: string;
    sub: string;
    icon: keyof typeof Ionicons.glyphMap;
  }[] = [
    {
      state: 'volgen',
      title: 'Volgen',
      sub: 'Events van deze venue komen prominent in je feed.',
      icon: 'heart',
    },
    {
      state: 'normaal',
      title: 'Niet volgen',
      sub: 'Standaard. Events worden gewoon getoond, geen voorkeur.',
      icon: 'heart-outline',
    },
    {
      state: 'blokken',
      title: 'Blokkeren',
      sub: 'Events van deze venue verschijnen nergens meer in de app.',
      icon: 'ban-outline',
    },
  ];

  return (
    <View style={[styles.sheetRoot, { backgroundColor: roles.bg }]}>
      <View style={styles.sheetDragHandleWrap}>
        <View
          style={[
            styles.sheetDragHandle,
            { backgroundColor: roles.fgPlaceholder },
          ]}
        />
      </View>
      {Platform.OS !== 'ios' && (
        <Pressable
          onPress={onClose}
          hitSlop={8}
          style={[
            styles.sheetCloseBtn,
            { backgroundColor: isNacht ? palette.noir2 : palette.paper2 },
          ]}
        >
          <Cross size={14} thickness={2.6} color={roles.fg} />
        </Pressable>
      )}
      <View style={styles.sheetBody}>
        <Text style={[styles.sheetTitle, { color: roles.fg }]}>{name}</Text>
        <Text style={[styles.sheetLead, { color: roles.fgMuted }]}>
          Hoe wil je deze venue zien?
        </Text>

        <View style={styles.sheetOptions}>
          {options.map((opt) => {
            const active = opt.state === current;
            const accent =
              opt.state === 'blokken'
                ? '#c9453a'
                : isNacht
                  ? palette.acid
                  : palette.red;
            return (
              <Pressable
                key={opt.state}
                onPress={() => onPick(opt.state)}
                style={[
                  styles.sheetOption,
                  {
                    borderColor: active ? accent : roles.bgChip,
                    backgroundColor: active
                      ? `${accent}14`
                      : 'transparent',
                  },
                ]}
              >
                <Ionicons
                  name={opt.icon}
                  size={22}
                  color={active ? accent : roles.fgMuted}
                />
                <View style={styles.sheetOptionBody}>
                  <Text
                    style={[
                      styles.sheetOptionTitle,
                      { color: active ? accent : roles.fg },
                    ]}
                  >
                    {opt.title}
                  </Text>
                  <Text
                    style={[
                      styles.sheetOptionSub,
                      { color: roles.fgMuted },
                    ]}
                  >
                    {opt.sub}
                  </Text>
                </View>
                {active && (
                  <Ionicons name="checkmark" size={20} color={accent} />
                )}
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

function ShareVenueButton({ slug, name }: { slug: string; name: string }) {
  const onPress = async () => {
    const url = `https://andreas.amsterdam/v/${encodeURIComponent(slug)}`;
    const messageBody = `${name} via Andreas — ${url}`;
    try {
      await Share.share(
        Platform.OS === 'ios'
          ? { url, message: messageBody }
          : { message: messageBody }
      );
      Haptics.selectionAsync();
    } catch {
      // Cancel of share-error — geen actie nodig.
    }
  };
  return (
    <Pressable onPress={onPress} style={styles.circleBtn}>
      <Ionicons name="share-outline" size={20} color={palette.ink} />
    </Pressable>
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
  topBarActions: { flexDirection: 'row', gap: 8 },

  // Follow action-sheet
  sheetRoot: { flex: 1 },
  sheetDragHandleWrap: {
    alignItems: 'center',
    paddingTop: 8,
    paddingBottom: 8,
  },
  sheetDragHandle: {
    width: 44,
    height: 5,
    borderRadius: 2.5,
    opacity: 0.6,
  },
  sheetCloseBtn: {
    position: 'absolute',
    top: 16,
    right: 16,
    width: 36,
    height: 36,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetBody: {
    flex: 1,
    paddingHorizontal: 22,
    paddingTop: 24,
  },
  sheetTitle: {
    fontFamily: fontFamily.display,
    fontSize: 24,
    lineHeight: 24 * 1.05,
    letterSpacing: -0.6,
  },
  sheetLead: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 6,
    marginBottom: 22,
  },
  sheetOptions: { gap: 10 },
  sheetOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 16,
    borderRadius: 14,
    borderWidth: 1,
  },
  sheetOptionBody: { flex: 1, minWidth: 0 },
  sheetOptionTitle: {
    fontFamily: fontFamily.medium,
    fontSize: 15,
    letterSpacing: -0.15,
  },
  sheetOptionSub: {
    fontFamily: fontFamily.body,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 4,
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
    fontSize: 14.5,
    letterSpacing: -0.07,
  },

  desc: {
    fontFamily: fontFamily.body,
    fontSize: 14.5,
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
    fontSize: 14.5,
    letterSpacing: -0.07,
  },
});
