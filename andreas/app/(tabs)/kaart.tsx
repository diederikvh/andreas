import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { Image } from 'expo-image';
import { router, useFocusEffect, useNavigation } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { TabIconAgenda, TabIconKaart } from '@/components/icons/TabIcons';
import { brandEase } from '@/lib/easing';
import type { KaartVenue } from '@/mocks/kaart';
import { KAART } from '@/mocks/kaart';
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
const SHEET_CLOSED = 0; // fully tucked away — opens via marker tap
const SWITCH_HEIGHT = 44; // Kaart/Lijst switch + its margins
// Clearance between the bottom of the drawer card and the floating
// tabbar — the tabbar sits on insets.bottom + 4 with ~48px height, so
// 60px keeps the card just above it with breathing room.
const TABBAR_CLEARANCE = 60;

export default function Kaart() {
  const mode = useMode();
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const data = KAART[mode];

  // Sort venues by walking time so the closest sit at the top of the sheet.
  const sorted = [...data.venues].sort((a, b) => a.minutes - b.minutes);

  const [view, setView] = useState<'map' | 'list'>('map');
  // Drawer starts hidden — it opens when the user taps a marker.
  const sheetHeight = useSharedValue(0);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const mapRef = useRef<MapView>(null);

  const activeVenue = data.venues.find((v) => v.id === activeId) ?? null;

  const recentre = useCallback(() => {
    mapRef.current?.animateToRegion(
      {
        latitude: data.centre.lat,
        longitude: data.centre.lng,
        latitudeDelta: 0.045,
        longitudeDelta: 0.04,
      },
      450
    );
  }, [data.centre.lat, data.centre.lng]);

  // Re-centre on every tab tap — first nav and re-taps both fire
  // tabPress, so a "double-click on the menu item" recenters the map.
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

  const selectVenue = (id: string) => {
    setActiveId(id);
    if (!sheetOpen) snapTo(true);
  };

  // Reset selection on mode swap — the drawer would otherwise stay open
  // showing a venue from the other mode.
  useEffect(() => {
    setActiveId(null);
    sheetHeight.value = withTiming(SHEET_CLOSED, {
      duration: 220,
      easing: brandEase,
    });
    setSheetOpen(false);
  }, [mode, sheetHeight]);

  // Drag the handle to resize the sheet — snaps to open/closed on release.
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
            paddingTop: insets.top + HEADER_HEIGHT + SWITCH_HEIGHT + 8,
            paddingBottom: insets.bottom + 110,
          }}
        >
          <Text style={[styles.listKicker, { color: roles.fgMuted }]}>
            In de buurt
          </Text>
          {sorted.map((v) => (
            <SheetRow key={v.id} venue={v} />
          ))}
        </ScrollView>
      ) : (
        <>
          <MapView
        ref={mapRef}
        provider={PROVIDER_DEFAULT}
        style={StyleSheet.absoluteFill}
        initialRegion={{
          latitude: data.centre.lat,
          longitude: data.centre.lng,
          latitudeDelta: 0.045,
          longitudeDelta: 0.04,
        }}
        showsUserLocation={false}
        showsCompass={false}
        showsMyLocationButton={false}
      >
        {/* "You" — centre marker */}
        <Marker
          coordinate={{
            latitude: data.centre.lat,
            longitude: data.centre.lng,
          }}
          anchor={{ x: 0.5, y: 0.5 }}
        >
          <View style={[styles.you, { backgroundColor: roles.accent }]}>
            <Cross size={14} thickness={3} color={roles.onAccent} />
          </View>
        </Marker>

        {/* Friends */}
        {data.friends.map((f) => (
          <Marker
            key={f.id}
            coordinate={{ latitude: f.lat, longitude: f.lng }}
            anchor={{ x: 0.5, y: 0.5 }}
          >
            <View style={[styles.friend, { borderColor: roles.bg }]}>
              <Image source={{ uri: f.avatar }} style={styles.friendImg} />
            </View>
          </Marker>
        ))}

        {/* Venues */}
        {data.venues.map((v) => {
          const isActive = activeId === v.id;
          return (
          <Marker
            key={v.id}
            coordinate={{ latitude: v.lat, longitude: v.lng }}
            anchor={{ x: 0.5, y: 0.5 }}
            onPress={() => selectVenue(v.id)}
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
                style={[
                  styles.dot,
                  { backgroundColor: TONE[mode][v.tone] },
                ]}
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
                  {v.dot}
                </Text>
              </View>
              <Text
                style={[
                  styles.minutes,
                  { color: isActive ? roles.onAccent : roles.fg },
                ]}
              >
                {v.minutes}m
              </Text>
            </View>
          </Marker>
          );
        })}
      </MapView>

      {/* Animated bottom sheet — drag the handle to resize, tap to toggle.
          List scrolls all the way under the floating tabbar. */}
      <Animated.View
        style={[
          styles.sheet,
          {
            backgroundColor: mode === 'nacht' ? palette.noir2 : palette.paper3,
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
              style={[styles.sheetHandle, { backgroundColor: roles.fgMuted }]}
            />
          </Pressable>
        </GestureDetector>
        {activeVenue && <DrawerCard venue={activeVenue} />}
      </Animated.View>
        </>
      )}

      <AppHeader>
        <View style={styles.toolbar}>
          <View style={styles.toolbarSwitch}>
            <ViewSwitch view={view} onChange={setView} />
          </View>
          <Pressable
            onPress={view === 'map' ? recentre : undefined}
            disabled={view === 'list'}
            style={[
              styles.recentre,
              {
                borderColor: roles.bgChip,
                opacity: view === 'list' ? 0.4 : 1,
              },
            ]}
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
        Icon={TabIconKaart}
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

function SheetRow({
  venue,
  active,
  onLayout,
}: {
  venue: KaartVenue;
  active?: boolean;
  onLayout?: (y: number) => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const tone = TONE[mode][venue.tone];
  const tagBg = `${tone}26`; // ~15% alpha

  return (
    <Pressable
      onPress={() => router.push(`/event/${venue.id}`)}
      onLayout={(e) => onLayout?.(e.nativeEvent.layout.y)}
      style={[
        styles.sheetRow,
        { borderColor: roles.bgChip },
        active && { backgroundColor: `${tone}1f` },
      ]}
    >
      <View style={styles.sheetMin}>
        <Text style={[styles.sheetMinNum, { color: roles.fg }]}>
          {venue.minutes}
        </Text>
        <Text style={[styles.sheetMinUnit, { color: roles.fgMuted }]}>min</Text>
      </View>
      <View style={styles.sheetBody}>
        <Text
          numberOfLines={1}
          style={[styles.sheetTitle, { color: roles.fg }]}
        >
          {venue.title}
        </Text>
        <View style={styles.sheetMetaRow}>
          <View style={[styles.sheetTag, { backgroundColor: tagBg }]}>
            <Text style={[styles.sheetTagText, { color: tone }]}>
              {venue.category}
            </Text>
          </View>
          <Text
            numberOfLines={1}
            style={[styles.sheetVenue, { color: roles.fgMuted }]}
          >
            {venue.venue}
          </Text>
        </View>
      </View>
      <Text style={[styles.sheetTime, { color: roles.fgMuted }]}>
        {venue.time}
      </Text>
    </Pressable>
  );
}

function DrawerCard({ venue }: { venue: KaartVenue }) {
  const mode = useMode();
  const roles = useRoles();
  const tone = TONE[mode][venue.tone];
  return (
    <Pressable
      onPress={() => router.push(`/event/${venue.id}`)}
      style={styles.cardWrap}
    >
      <View style={styles.cardTop}>
        <Image
          source={{ uri: venue.thumb }}
          style={styles.cardThumb}
          contentFit="cover"
        />
        <View style={styles.cardBody}>
          <View style={styles.cardMetaRow}>
            <View
              style={[styles.cardTag, { backgroundColor: `${tone}26` }]}
            >
              <Text style={[styles.cardTagText, { color: tone }]}>
                {venue.category}
              </Text>
            </View>
            <Text style={[styles.cardMeta, { color: roles.fgMuted }]}>
              {venue.minutes} min · {venue.time}
            </Text>
          </View>
          <Text
            numberOfLines={2}
            style={[styles.cardTitle, { color: roles.fg }]}
          >
            {venue.title}
          </Text>
          <Text
            numberOfLines={1}
            style={[styles.cardVenue, { color: roles.fgMuted }]}
          >
            {venue.venue}
          </Text>
          <Text
            numberOfLines={3}
            style={[styles.cardIntro, { color: roles.fgRead }]}
          >
            {venue.intro}
          </Text>
          {venue.friends && venue.friends.length > 0 && (
            <View
              style={[styles.cardFriends, { backgroundColor: `${tone}1f` }]}
            >
              <View style={styles.cardAvstack}>
                {venue.friends.map((f, i) => (
                  <Image
                    key={f.name}
                    source={{ uri: f.avatar }}
                    style={[
                      styles.cardAvatar,
                      {
                        marginLeft: i === 0 ? 0 : -6,
                        borderColor:
                          mode === 'nacht' ? palette.noir2 : palette.paper3,
                      },
                    ]}
                  />
                ))}
              </View>
              <Text
                numberOfLines={1}
                style={[styles.cardFriendsText, { color: tone }]}
              >
                {friendsLabel(venue.friends.map((f) => f.name))}
              </Text>
            </View>
          )}
        </View>
      </View>
    </Pressable>
  );
}

function friendsLabel(names: string[]): string {
  if (names.length === 1) return `${names[0]} gaat ook`;
  if (names.length === 2) return `${names[0]} & ${names[1]} gaan ook`;
  return `${names[0]} +${names.length - 1} gaan ook`;
}

const styles = StyleSheet.create({
  root: { flex: 1 },

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
  // Tab-icons are 22×22; shrink to ~70% so they sit balanced beside the label.
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

  // Friend marker
  friend: {
    width: 24,
    height: 24,
    borderRadius: 999,
    borderWidth: 2,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 3,
  },
  friendImg: { width: '100%', height: '100%' },

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

  // Drawer single-venue card (map view)
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
    fontSize: 13,
    lineHeight: 18,
    marginTop: 4,
  },
  cardFriends: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 4,
    paddingRight: 12,
    paddingVertical: 4,
    borderRadius: 999,
  },
  cardAvstack: { flexDirection: 'row' },
  cardAvatar: {
    width: 22,
    height: 22,
    borderRadius: 999,
    borderWidth: 1.5,
  },
  cardFriendsText: {
    fontFamily: fontFamily.medium,
    fontSize: 12,
  },
  cardActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginTop: 6,
  },
  cardCta: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 999,
  },
  cardCtaText: {
    fontFamily: fontFamily.medium,
    fontSize: 12,
    letterSpacing: -0.06,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    opacity: 0.4,
  },
  sheetKicker: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    marginBottom: 8,
    paddingHorizontal: 22,
  },
  sheetList: { gap: 0 },
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
});
