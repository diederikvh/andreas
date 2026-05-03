import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { Image } from 'expo-image';
import { router, useFocusEffect, useNavigation } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import MapView, { Marker, PROVIDER_DEFAULT } from 'react-native-maps';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { Cross } from '@/components/Cross';
import { TabIconAgenda, TabIconVenues } from '@/components/icons/TabIcons';
import { brandEase } from '@/lib/easing';
import type { ApiEvent, ApiFriendBadge } from '@/lib/api';
import {
  CATEGORY_DOT,
  CATEGORY_TICK,
  distanceKm,
  formatTime,
  isNachtHour,
  socialWindow,
  walkingMinutes,
} from '@/lib/eventDisplay';
import { useEvents } from '@/lib/queries';
import { useDeviceLocation } from '@/lib/useDeviceLocation';
import type { BadgeTone } from '@/mocks/feed';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

const TONE = {
  nacht: {
    acid: palette.acid,
    flare: palette.flare,
    plum: palette.plum,
    azure: palette.azure,
  },
  dag: {
    acid: palette.red,
    flare: palette.forest,
    plum: palette.cobalt,
    azure: '#8a5b00',
  },
} as const;

const SHEET_OPEN = 200;
const SHEET_CLOSED = 0;
// Hoogte van de extra controls onder de logo-rij in AppHeader:
// context-line (paddingTop 4 + tekst + paddingBottom 14 ≈ 30) +
// kaart/lijst switch + recentre (paddingHorizontal 18, height 36,
// marginBottom 8 ≈ 44).
const CONTROLS_HEIGHT = 76;
const TABBAR_CLEARANCE = 60;

// Default-centre voor de kaart wanneer device-locatie nog niet binnen
// is, geweigerd, of buiten de Amsterdam-bubbel valt (bv. iOS simulator
// in Cupertino). Amsterdam CS — net zo bruikbaar voor nacht als dag.
const AMSTERDAM_CS = { lat: 52.3791, lng: 4.9003 };
/** Max afstand vanaf CS waarbij we de echte device-locatie nog gebruiken. */
const AMSTERDAM_RADIUS_KM = 50;

type MapEvent = {
  event: ApiEvent;
  minutes: number;
};

export default function Kaart() {
  const mode = useMode();
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const locationStatus = useDeviceLocation();
  const centre = (() => {
    if (locationStatus.status !== 'granted') return AMSTERDAM_CS;
    return distanceKm(locationStatus.location, AMSTERDAM_CS) > AMSTERDAM_RADIUS_KM
      ? AMSTERDAM_CS
      : locationStatus.location;
  })();

  // Kaart toont dezelfde subset als Avond — events binnen het sociale
  // venster (vannacht / overdag). "Wat speelt nu in de buurt?".
  const window = useMemo(() => socialWindow(mode), [mode]);
  const { data: events } = useEvents({
    from: window.from,
    to: window.to,
  });
  const mapEvents: MapEvent[] = useMemo(() => {
    if (!events) return [];
    return events
      .filter((e) => {
        const hour = new Date(e.startsAt).getHours();
        return mode === 'nacht' ? isNachtHour(hour) : !isNachtHour(hour);
      })
      .map((e) => ({
        event: e,
        minutes: walkingMinutes(centre, {
          lat: e.venue.lat,
          lng: e.venue.lng,
        }),
      }));
  }, [events, centre, mode]);
  const sorted = useMemo(
    () => [...mapEvents].sort((a, b) => a.minutes - b.minutes),
    [mapEvents]
  );

  const [view, setView] = useState<'map' | 'list'>('map');
  const sheetHeight = useSharedValue(0);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const mapRef = useRef<MapView>(null);

  const activeMapEvent = mapEvents.find((m) => m.event.id === activeId) ?? null;

  const recentre = useCallback(() => {
    mapRef.current?.animateToRegion(
      {
        latitude: centre.lat,
        longitude: centre.lng,
        latitudeDelta: 0.045,
        longitudeDelta: 0.04,
      },
      450
    );
  }, [centre.lat, centre.lng]);

  const navigation = useNavigation();
  useEffect(() => {
    const unsub = navigation.addListener('tabPress' as never, () => {
      recentre();
    });
    return unsub;
  }, [navigation, recentre]);

  useFocusEffect(
    useCallback(() => {
      recentre();
    }, [recentre])
  );

  const snapTo = (open: boolean) => {
    sheetHeight.value = withTiming(open ? SHEET_OPEN : SHEET_CLOSED, {
      duration: 280,
      easing: brandEase,
    });
    setSheetOpen(open);
  };

  const selectEvent = (id: string) => {
    setActiveId(id);
    if (!sheetOpen) snapTo(true);
  };

  // Reset selection on mode swap.
  useEffect(() => {
    setActiveId(null);
    sheetHeight.value = withTiming(SHEET_CLOSED, {
      duration: 220,
      easing: brandEase,
    });
    setSheetOpen(false);
  }, [mode, sheetHeight]);

  const dragStart = useSharedValue(0);
  const dragGesture = Gesture.Pan()
    .onStart(() => {
      dragStart.value = sheetHeight.value;
    })
    .onUpdate((e) => {
      const next = dragStart.value - e.translationY;
      sheetHeight.value = Math.min(
        SHEET_OPEN,
        Math.max(SHEET_CLOSED, next)
      );
    })
    .onEnd(() => {
      const open = sheetHeight.value > (SHEET_OPEN + SHEET_CLOSED) / 2;
      sheetHeight.value = withTiming(open ? SHEET_OPEN : SHEET_CLOSED, {
        duration: 220,
        easing: brandEase,
      });
      runOnJS(setSheetOpen)(open);
    });

  const sheetStyle = useAnimatedStyle(() => ({
    height:
      sheetHeight.value > 0
        ? sheetHeight.value + insets.bottom + TABBAR_CLEARANCE
        : 0,
  }));

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      {view === 'list' ? (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            paddingTop: insets.top + HEADER_HEIGHT + CONTROLS_HEIGHT + 8,
            paddingBottom: insets.bottom + 110,
          }}
        >
          <Text style={[styles.listKicker, { color: roles.fgMuted }]}>
            In de buurt
          </Text>
          {sorted.map((m) => (
            <SheetRow key={m.event.id} mapEvent={m} />
          ))}
        </ScrollView>
      ) : (
        <>
          <MapView
            ref={mapRef}
            provider={PROVIDER_DEFAULT}
            mapType={mode === 'nacht' ? 'mutedStandard' : 'standard'}
            style={StyleSheet.absoluteFill}
            initialRegion={{
              latitude: centre.lat,
              longitude: centre.lng,
              latitudeDelta: 0.045,
              longitudeDelta: 0.04,
            }}
            showsUserLocation={false}
            showsCompass={false}
            showsMyLocationButton={false}
          >
            {/* "You" — centre marker */}
            <Marker
              coordinate={{ latitude: centre.lat, longitude: centre.lng }}
              anchor={{ x: 0.5, y: 0.5 }}
            >
              <View style={[styles.you, { backgroundColor: roles.accent }]}>
                <Cross size={14} thickness={3} color={roles.onAccent} />
              </View>
            </Marker>

            {/* Events as markers — friend-overlay komt terug zodra
                friendships in de DB staan. */}
            {mapEvents.map((m) => {
              const isActive = activeId === m.event.id;
              const tone: BadgeTone = CATEGORY_TICK[m.event.category];
              return (
                <Marker
                  key={m.event.id}
                  coordinate={{
                    latitude: m.event.venue.lat,
                    longitude: m.event.venue.lng,
                  }}
                  anchor={{ x: 0.5, y: 0.5 }}
                  onPress={() => selectEvent(m.event.id)}
                >
                  <View
                    style={[
                      styles.marker,
                      {
                        backgroundColor: isActive
                          ? roles.accent
                          : mode === 'nacht'
                            ? palette.noir2
                            : palette.paper3,
                      },
                    ]}
                  >
                    <View
                      style={[styles.dot, { backgroundColor: TONE[mode][tone] }]}
                    >
                      <Text
                        style={[
                          styles.dotText,
                          {
                            color:
                              mode === 'nacht' ? palette.noir : palette.paper3,
                          },
                        ]}
                      >
                        {CATEGORY_DOT[m.event.category]}
                      </Text>
                    </View>
                    <Text
                      style={[
                        styles.minutes,
                        { color: isActive ? roles.onAccent : roles.fg },
                      ]}
                    >
                      {m.minutes}m
                    </Text>
                  </View>
                </Marker>
              );
            })}
          </MapView>

          <Animated.View
            style={[
              styles.sheet,
              {
                backgroundColor:
                  mode === 'nacht' ? palette.noir2 : palette.paper3,
              },
              sheetStyle,
            ]}
          >
            <GestureDetector gesture={dragGesture}>
              <Pressable
                onPress={() => snapTo(!sheetOpen)}
                style={styles.sheetHandleHit}
              >
                <View
                  style={[
                    styles.sheetHandle,
                    { backgroundColor: roles.fgMuted },
                  ]}
                />
              </Pressable>
            </GestureDetector>
            {activeMapEvent && <DrawerCard mapEvent={activeMapEvent} />}
          </Animated.View>
        </>
      )}

      <AppHeader solid={view === 'map'}>
        <View style={styles.contextLine}>
          <Text style={[styles.contextLabel, { color: roles.accent }]}>
            {mode === 'nacht'
              ? 'Vanavond'
              : window.shifted
                ? 'Morgen overdag'
                : 'Vandaag overdag'}
          </Text>
          <Text style={[styles.contextMeta, { color: roles.fgMuted }]}>
            {mapEvents.length}{' '}
            {mapEvents.length === 1 ? 'plek in de buurt' : 'plekken in de buurt'}
          </Text>
        </View>
        <View style={styles.toolbar}>
          <View style={styles.toolbarSwitch}>
            <ViewSwitch view={view} onChange={setView} />
          </View>
          {view === 'map' && (
            <Pressable
              onPress={recentre}
              style={[styles.recentre, { borderColor: roles.bgChip }]}
            >
              <BlurView
                intensity={40}
                tint={mode === 'nacht' ? 'dark' : 'light'}
                style={StyleSheet.absoluteFill}
              />
              <View
                style={[
                  StyleSheet.absoluteFill,
                  {
                    backgroundColor:
                      mode === 'nacht'
                        ? 'rgba(23,23,26,0.65)'
                        : 'rgba(235,230,216,0.7)',
                  },
                ]}
              />
              <Ionicons name="locate" size={16} color={roles.fgMuted} />
            </Pressable>
          )}
        </View>
      </AppHeader>
    </View>
  );
}

function ViewSwitch({
  view,
  onChange,
}: {
  view: 'map' | 'list';
  onChange: (v: 'map' | 'list') => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  return (
    <View style={[styles.switchTrack, { borderColor: roles.bgChip }]}>
      <BlurView
        intensity={40}
        tint={mode === 'nacht' ? 'dark' : 'light'}
        style={StyleSheet.absoluteFill}
      />
      <View
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor:
              mode === 'nacht'
                ? 'rgba(23,23,26,0.65)'
                : 'rgba(235,230,216,0.7)',
          },
        ]}
      />
      <SwitchBtn
        Icon={TabIconVenues}
        label="Kaart"
        active={view === 'map'}
        onPress={() => onChange('map')}
      />
      <SwitchBtn
        Icon={TabIconAgenda}
        label="Lijst"
        active={view === 'list'}
        onPress={() => onChange('list')}
      />
    </View>
  );
}

function SwitchBtn({
  Icon,
  label,
  active,
  onPress,
}: {
  Icon: React.ComponentType<{ color: string }>;
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const roles = useRoles();
  const tint = active ? roles.onAccent : roles.fgMuted;
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.switchBtn,
        active && { backgroundColor: roles.accent },
      ]}
    >
      <View style={styles.switchIcon}>
        <Icon color={tint} />
      </View>
      <Text style={[styles.switchBtnText, { color: tint }]}>{label}</Text>
    </Pressable>
  );
}

function SheetRow({ mapEvent }: { mapEvent: MapEvent }) {
  const mode = useMode();
  const roles = useRoles();
  const tone = TONE[mode][CATEGORY_TICK[mapEvent.event.category]];
  const tagBg = `${tone}26`;
  const friends = mapEvent.event.friendsSaved ?? [];

  return (
    <Pressable
      onPress={() => router.push(`/event/${mapEvent.event.id}`)}
      style={[styles.sheetRow, { borderColor: roles.bgChip }]}
    >
      <View style={styles.sheetMin}>
        <Text style={[styles.sheetMinNum, { color: roles.fg }]}>
          {mapEvent.minutes}
        </Text>
        <Text style={[styles.sheetMinUnit, { color: roles.fgMuted }]}>
          min
        </Text>
      </View>
      <View style={styles.sheetBody}>
        <Text
          numberOfLines={1}
          style={[styles.sheetTitle, { color: roles.fg }]}
        >
          {mapEvent.event.title}
        </Text>
        <View style={styles.sheetMetaRow}>
          <View style={[styles.sheetTag, { backgroundColor: tagBg }]}>
            <Text style={[styles.sheetTagText, { color: tone }]}>
              {mapEvent.event.category}
            </Text>
          </View>
          <Text
            numberOfLines={1}
            style={[styles.sheetVenue, { color: roles.fgMuted }]}
          >
            {mapEvent.event.venue.name}
          </Text>
          {friends.length > 0 && (
            <FriendAvatarStack friends={friends} />
          )}
        </View>
      </View>
      <Text style={[styles.sheetTime, { color: roles.fgMuted }]}>
        {formatTime(mapEvent.event.startsAt)}
      </Text>
    </Pressable>
  );
}

function DrawerCard({ mapEvent }: { mapEvent: MapEvent }) {
  const mode = useMode();
  const roles = useRoles();
  const tone = TONE[mode][CATEGORY_TICK[mapEvent.event.category]];
  return (
    <Pressable
      onPress={() => router.push(`/event/${mapEvent.event.id}`)}
      style={styles.cardWrap}
    >
      <View style={styles.cardTop}>
        {mapEvent.event.imageUrl && (
          <Image
            source={{ uri: mapEvent.event.imageUrl }}
            style={styles.cardThumb}
            contentFit="cover"
          />
        )}
        <View style={styles.cardBody}>
          <View style={styles.cardMetaRow}>
            <View style={[styles.cardTag, { backgroundColor: `${tone}26` }]}>
              <Text style={[styles.cardTagText, { color: tone }]}>
                {mapEvent.event.category}
              </Text>
            </View>
            <Text style={[styles.cardMeta, { color: roles.fgMuted }]}>
              {mapEvent.minutes} min · {formatTime(mapEvent.event.startsAt)}
            </Text>
          </View>
          <Text
            numberOfLines={2}
            style={[styles.cardTitle, { color: roles.fg }]}
          >
            {mapEvent.event.title}
          </Text>
          <Text
            numberOfLines={1}
            style={[styles.cardVenue, { color: roles.fgMuted }]}
          >
            {mapEvent.event.venue.name}
          </Text>
          {mapEvent.event.description && (
            <Text
              numberOfLines={3}
              style={[styles.cardIntro, { color: roles.fgRead }]}
            >
              {mapEvent.event.description}
            </Text>
          )}
          {(mapEvent.event.friendsSaved?.length ?? 0) > 0 && (
            <View style={styles.cardFriendsWrap}>
              <FriendsPill
                friends={mapEvent.event.friendsSaved!}
                accent={tone}
              />
            </View>
          )}
        </View>
      </View>
    </Pressable>
  );
}

/** Standaard friends-pill (getinte bg + avatars + label). Zelfde
 *  vorm als die op de event-rijen elders. */
function FriendsPill({
  friends,
  accent,
}: {
  friends: ApiFriendBadge[];
  accent: string;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const bg = `${accent}1f`;
  const labelColor =
    mode === 'nacht' ? lightenHexLocal(accent, 0.35) : accent;
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <FriendAvatarStack friends={friends} borderTone="bg" />
      <Text
        numberOfLines={1}
        style={[styles.pillText, { color: labelColor }]}
      >
        {friendsLineLabel(friends.map((f) => f.name))}
      </Text>
    </View>
  );
}

/** Kale avatar-stack zonder label en bg, voor compacte plaatsen. */
function FriendAvatarStack({
  friends,
  borderTone = 'sheet',
}: {
  friends: ApiFriendBadge[];
  borderTone?: 'sheet' | 'bg';
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  // sheet = drawer/sheet-bg (noir2/paper3); bg = page-bg (noir/paper3)
  const borderColor =
    borderTone === 'bg'
      ? roles.bg
      : isNacht
        ? palette.noir2
        : palette.paper3;
  const max = 3;
  const visible = friends.slice(0, max);
  return (
    <View style={styles.friendsAvStack}>
      {visible.map((f, i) =>
        f.avatarUrl ? (
          <Image
            key={f.id}
            source={{ uri: f.avatarUrl }}
            style={[
              styles.friendsAv,
              { marginLeft: i === 0 ? 0 : -6, borderColor },
            ]}
          />
        ) : (
          <View
            key={f.id}
            style={[
              styles.friendsAv,
              styles.friendsAvFallback,
              {
                marginLeft: i === 0 ? 0 : -6,
                borderColor,
                backgroundColor: isNacht ? palette.noir3 : palette.paper,
              },
            ]}
          >
            <Text style={[styles.friendsAvInitial, { color: roles.fgMuted }]}>
              {(f.name.trim()[0] ?? '?').toUpperCase()}
            </Text>
          </View>
        )
      )}
    </View>
  );
}

function friendsLineLabel(names: string[]): string {
  if (names.length === 1) return `${names[0]} ook`;
  if (names.length === 2) return `${names[0]} & ${names[1]} ook`;
  return `${names[0]} +${names.length - 1} ook`;
}

function lightenHexLocal(hex: string, amount: number): string {
  const h = hex.replace('#', '');
  if (h.length !== 6) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const blend = (c: number) =>
    Math.round(c + (255 - c) * amount).toString(16).padStart(2, '0');
  return `#${blend(r)}${blend(g)}${blend(b)}`;
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  // Context-regel boven de toolbar — wat zie je op de kaart?
  contextLine: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingTop: 4,
    paddingBottom: 14,
    gap: 10,
  },
  contextLabel: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  contextMeta: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },

  // Toolbar row inside AppHeader (switch + recentre) — matches the
  // logo-lockup's 18px inset so they line up vertically.
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 18,
    marginBottom: 8,
  },
  toolbarSwitch: { flex: 1 },

  // Map/List view switch (in AppHeader children)
  switchTrack: {
    flexDirection: 'row',
    padding: 3,
    borderRadius: 999,
    borderWidth: 1,
    gap: 2,
    overflow: 'hidden',
  },
  switchBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 7,
    borderRadius: 999,
  },
  switchBtnText: {
    fontFamily: fontFamily.medium,
    fontSize: 12,
    letterSpacing: -0.06,
  },
  switchIcon: {
    width: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ scale: 0.7 }],
  },

  // List view kicker
  listKicker: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    marginBottom: 8,
    paddingHorizontal: 22,
  },

  // Recentre button — pill in the toolbar row
  recentre: {
    width: 36,
    height: 36,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },

  // "You" marker
  you: {
    width: 36,
    height: 36,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 6,
  },

  // Venue marker — pill with category dot + walking minutes
  marker: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 4,
    paddingRight: 10,
    paddingVertical: 4,
    borderRadius: 999,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
    elevation: 4,
  },
  dot: {
    width: 18,
    height: 18,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotText: {
    fontFamily: fontFamily.monoMedium,
    fontSize: 9,
    letterSpacing: 0.5,
  },
  minutes: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 0.5,
  },

  // Bottom sheet
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 4,
    overflow: 'hidden',
  },
  sheetHandleHit: {
    paddingVertical: 8,
    alignItems: 'center',
  },

  // Drawer single-event card (map view)
  cardWrap: {
    paddingHorizontal: 16,
    gap: 12,
  },
  cardTop: {
    flexDirection: 'row',
    gap: 14,
  },
  cardThumb: {
    width: 100,
    height: 150,
    borderRadius: 14,
  },
  cardBody: { flex: 1, gap: 6 },
  cardMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  cardTag: {
    height: 22,
    paddingHorizontal: 10,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTagText: {
    fontFamily: fontFamily.mono,
    fontSize: 9,
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  },
  cardMeta: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  cardTitle: {
    fontFamily: fontFamily.bold,
    fontSize: 18,
    letterSpacing: -0.27,
    lineHeight: 20,
  },
  cardVenue: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: -4,
  },
  cardIntro: {
    fontFamily: fontFamily.body,
    fontSize: 14.5,
    lineHeight: 18,
    marginTop: 4,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    opacity: 0.4,
  },

  // List view rows
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 22,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sheetMin: {
    width: 38,
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 2,
  },
  sheetMinNum: {
    fontFamily: fontFamily.display,
    fontSize: 18,
    letterSpacing: -0.18,
    lineHeight: 18,
  },
  sheetMinUnit: {
    fontFamily: fontFamily.mono,
    fontSize: 9,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  sheetBody: { flex: 1, minWidth: 0 },
  sheetTitle: {
    fontFamily: fontFamily.bold,
    fontSize: 14,
    letterSpacing: -0.14,
  },
  sheetVenue: {
    flex: 1,
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  sheetMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 5,
  },
  sheetTag: {
    height: 20,
    paddingHorizontal: 8,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetTagText: {
    fontFamily: fontFamily.mono,
    fontSize: 9,
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  },
  sheetTime: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 0.8,
  },

  // Friends — avatars + optionele tinted pill
  friendsAvStack: { flexDirection: 'row', marginLeft: 'auto' },
  friendsAv: {
    width: 18,
    height: 18,
    borderRadius: 999,
    borderWidth: 1.5,
  },
  friendsAvFallback: { alignItems: 'center', justifyContent: 'center' },
  friendsAvInitial: {
    fontFamily: fontFamily.monoMedium,
    fontSize: 9,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 24,
    paddingLeft: 3,
    paddingRight: 10,
    borderRadius: 999,
    alignSelf: 'flex-start',
  },
  pillText: {
    fontFamily: fontFamily.medium,
    fontSize: 11,
  },
  cardFriendsWrap: { marginTop: 8 },
});
