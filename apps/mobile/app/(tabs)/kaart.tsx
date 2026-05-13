import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { Image } from 'expo-image';
import { router, useFocusEffect } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import {
  Camera as MapCamera,
  type CameraRef,
  Map as MapView,
  Marker as MapMarker,
} from '@maplibre/maplibre-react-native';
import Animated, {
  Easing,
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
  VENUE_TYPE_TICK,
  distanceKm,
  eventImageUrl,
  rowTimeLabel,
  getTimeBlock,
  translateCategory,
  travelMinutes,
  type TransportMode,
} from '@/lib/eventDisplay';
import { useLocale, useT } from '@/lib/i18n';
import { useEvents } from '@/lib/queries';
import { useDeviceLocation } from '@/lib/useDeviceLocation';
import type { BadgeTone } from '@/lib/types';
import { useMode, useRoles } from '@/store/mode';
import { useVandaagFilters } from '@/store/vandaagFilters';
import { fontFamily, palette } from '@/theme/tokens';

import { AvondFilterSheet } from './avond';

const TONE = {
  nacht: {
    acid: palette.acid,
    flare: palette.flare,
    plum: palette.plum,
    azure: palette.azure,
    saffron: palette.saffron,
  },
  dag: {
    acid: palette.red,
    flare: palette.forest,
    plum: palette.cobalt,
    azure: '#8a5b00',
    saffron: '#9d6008',
  },
} as const;

const SHEET_OPEN = 200;
const SHEET_CLOSED = 0;
// Hoogte van de toolbar-rij onder de logo-rij in AppHeader: kicker
// staat sinds de IA-shift in rij 1 (rightSlot), dus geen aparte
// context-line meer. Toolbar = 44 + marginBottom 8 + paddingBottom 4.
const CONTROLS_HEIGHT = 56;
// TabBar is verborgen op de kaart-tab; de drawer hoeft geen extra
// clearance meer onder zich te hebben voor een (er niet meer
// staande) tab-bar.
const TABBAR_CLEARANCE = 0;

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
  const t = useT();
  const locationStatus = useDeviceLocation();
  const centre = (() => {
    if (locationStatus.status !== 'granted') return AMSTERDAM_CS;
    return distanceKm(locationStatus.location, AMSTERDAM_CS) > AMSTERDAM_RADIUS_KM
      ? AMSTERDAM_CS
      : locationStatus.location;
  })();

  const [view, setView] = useState<'map' | 'list'>('map');
  const [transport, setTransport] = useState<TransportMode>('walk');
  const [filterOpen, setFilterOpen] = useState(false);

  // Hele dag — 00:00 t/m morgen 00:00. Mode (nacht/dag) is alleen
  // stijl, geen filter. Voor scope-controle dezelfde filter-store
  // als de Vandaag-tab gebruiken zodat keuzes synced zijn.
  const todayWindow = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { from: start.toISOString(), to: end.toISOString() };
  }, []);
  const { data: events } = useEvents({
    from: todayWindow.from,
    to: todayWindow.to,
  });

  // Filters worden gedeeld met de Vandaag-tab — dezelfde dag,
  // dezelfde events. Filter-sheet hergebruikt AvondFilterSheet.
  const query = useVandaagFilters((s) => s.query);
  const onlyFriends = useVandaagFilters((s) => s.onlyFriends);
  const onlyFavorites = useVandaagFilters((s) => s.onlyFavorites);
  const activeBlocks = useVandaagFilters((s) => s.activeBlocks);
  const activeCats = useVandaagFilters((s) => s.activeCats);
  const activeTypes = useVandaagFilters((s) => s.activeTypes);
  const activeGenres = useVandaagFilters((s) => s.activeGenres);
  const setOnlyFriends = useVandaagFilters((s) => s.setOnlyFriends);
  const setOnlyFavorites = useVandaagFilters((s) => s.setOnlyFavorites);
  const setActiveBlocks = useVandaagFilters((s) => s.setActiveBlocks);
  const setActiveCats = useVandaagFilters((s) => s.setActiveCats);
  const setActiveTypes = useVandaagFilters((s) => s.setActiveTypes);
  const setActiveGenres = useVandaagFilters((s) => s.setActiveGenres);
  const toggleBlock = useVandaagFilters((s) => s.toggleBlock);

  const showFavoritesChip = useMemo(
    () => Boolean(events?.some((e) => e.venueFollowed)),
    [events]
  );

  const mapEvents: MapEvent[] = useMemo(() => {
    if (!events) return [];
    const needle = query.trim().toLowerCase();
    return events
      .filter((e) => {
        if (e.kind === 'exhibition') return false;
        if (activeCats.length > 0 && !activeCats.includes(e.category)) {
          return false;
        }
        if (activeTypes.length > 0) {
          if (!e.venue.type || !activeTypes.includes(e.venue.type)) {
            return false;
          }
        }
        if (activeGenres.length > 0) {
          const evGenres = e.genres ?? [];
          if (!evGenres.some((g) => activeGenres.includes(g))) return false;
        }
        if (activeBlocks.length > 0) {
          const block = getTimeBlock(new Date(e.startsAt).getHours());
          if (!activeBlocks.includes(block)) return false;
        }
        if (onlyFriends && (e.friendsSaved?.length ?? 0) === 0) return false;
        if (onlyFavorites && !e.venueFollowed) return false;
        if (needle.length > 0) {
          const inTitle = e.title.toLowerCase().includes(needle);
          const inVenue = e.venue.name.toLowerCase().includes(needle);
          if (!inTitle && !inVenue) return false;
        }
        return true;
      })
      .map((e) => ({
        event: e,
        minutes: travelMinutes(
          centre,
          { lat: e.venue.lat, lng: e.venue.lng },
          transport
        ),
      }));
  }, [
    events,
    centre,
    transport,
    query,
    activeCats,
    activeTypes,
    activeGenres,
    activeBlocks,
    onlyFriends,
    onlyFavorites,
  ]);

  const filterCount =
    activeBlocks.length +
    activeCats.length +
    activeTypes.length +
    activeGenres.length +
    (onlyFriends ? 1 : 0) +
    (onlyFavorites ? 1 : 0);
  const sorted = useMemo(
    () => [...mapEvents].sort((a, b) => a.minutes - b.minutes),
    [mapEvents]
  );
  const sheetHeight = useSharedValue(0);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const cameraRef = useRef<CameraRef>(null);
  // True na de eerste auto-recentre van deze "kaart-sessie". Reset
  // wanneer de gebruiker de kaart sluit (close-knop). Doel:
  //  - bij openen vanuit Vandaag → recentre op huidige plek ✓
  //  - bij terugkomen vanuit /event/[id] → géén recentre, focus
  //    behouden ✓
  // De ref blijft staan over blur/focus van de tab-stack zelf;
  // alleen een expliciete close reset 'm.
  const hasAutoRecenteredRef = useRef(false);

  const activeMapEvent = mapEvents.find((m) => m.event.id === activeId) ?? null;

  const recentre = useCallback(() => {
    cameraRef.current?.flyTo({
      center: [centre.lng, centre.lat],
      zoom: 13,
      duration: 450,
    });
  }, [centre.lat, centre.lng]);

  useFocusEffect(
    useCallback(() => {
      if (!hasAutoRecenteredRef.current) {
        recentre();
        hasAutoRecenteredRef.current = true;
      }
      // Bij blur de event-detail bottom sheet sluiten zodat bij
      // terugkeer een schone kaart staat. De filter-sheet is een
      // page-sheet-Modal en blokkeert tab-navigatie zelf — geen
      // cleanup nodig.
      return () => {
        setActiveId(null);
        sheetHeight.value = withTiming(SHEET_CLOSED, {
          duration: 220,
          easing: brandEase,
        });
        setSheetOpen(false);
      };
    }, [recentre, sheetHeight])
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

  // Reset selection on mode swap (visual context wijzigt, sheet
  // sluiten voor schoonheid).
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
            style={StyleSheet.absoluteFill}
            // CARTO basemaps — free vector-style JSON's, geen API-key.
            // Positron = clean light, dark-matter = clean dark; matcht
            // de noir/paper-tones van Andreas. OpenFreeMap heeft (nog)
            // geen dark-style, daarom CARTO ipv mixed-providers.
            mapStyle={
              mode === 'nacht'
                ? 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
                : 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
            }
          >
            <MapCamera
              ref={cameraRef}
              initialViewState={{
                center: [centre.lng, centre.lat],
                zoom: 13,
              }}
            />

            {/* "You" — centre marker. Marker accepteert één child
                (View tree) en re-rendert wanneer props veranderen
                — geen tracksViewChanges nodig zoals bij
                react-native-maps. */}
            <MapMarker
              id="centre"
              lngLat={[centre.lng, centre.lat]}
              anchor="center"
            >
              <View style={[styles.you, { backgroundColor: roles.accent }]}>
                <Cross size={14} thickness={3} color={roles.onAccent} />
              </View>
            </MapMarker>

            {/* Events as markers — friend-overlay komt terug zodra
                friendships in de DB staan. */}
            {mapEvents.map((m) => (
              <EventMarker
                key={m.event.id}
                m={m}
                isActive={activeId === m.event.id}
                onPress={selectEvent}
              />
            ))}
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
            {activeMapEvent && (
              <DrawerCard mapEvent={activeMapEvent} transport={transport} />
            )}
          </Animated.View>
        </>
      )}

      <AppHeader
        solid={view === 'map'}
        title={t('Kaart', 'Map')}
        rightSlot={
          // Kicker in row 1 ipv eigen rij — comprimeert de header.
          // 'Today' (accent) + telling op één regel rechts naast de
          // titel; flexShrink zodat 'ie netjes inkort op smalle
          // schermen.
          <View style={styles.headerKicker}>
            <Text style={[styles.contextLabel, { color: roles.accent }]}>
              {t('Vandaag', 'Today')}
            </Text>
            <Text
              style={[styles.contextMeta, { color: roles.fgMuted }]}
              numberOfLines={1}
            >
              {mapEvents.length}
            </Text>
          </View>
        }
      >
        <View style={styles.toolbar}>
          {/* Links-cluster: map/list-switch (icons-only) + filter,
              dicht tegen elkaar zodat ze als familie ogen. */}
          <View style={styles.toolbarLeft}>
            <ViewSwitch view={view} onChange={setView} />
            <FilterButton
              count={filterCount}
              onPress={() => setFilterOpen(true)}
            />
          </View>
          {/* Rechts: sluit-knop, met zoveel mogelijk witruimte ertussen
              via space-between op de parent. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('Sluit kaart', 'Close map')}
            onPress={() => {
              // Reset de auto-recentre flag bij echt sluiten — zodat
              // bij heropenen vanuit Vandaag de kaart wél weer
              // recentreert op je huidige plek.
              hasAutoRecenteredRef.current = false;
              if (router.canGoBack()) router.back();
              else router.replace('/avond');
            }}
            hitSlop={8}
            style={[styles.closeBtn, { borderColor: roles.bgChip }]}
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
            <Cross size={16} thickness={3} color={roles.fgMuted} />
          </Pressable>
        </View>
      </AppHeader>

      {/* Map-overlay: recentre + transport-toggle drijven links­
          boven op de kaart, gestapeld in een column. Direct onder
          de AppHeader-toolbar. Alleen op map-view. */}
      {view === 'map' && (
        <View
          pointerEvents="box-none"
          style={[
            styles.mapOverlay,
            { top: insets.top + HEADER_HEIGHT + CONTROLS_HEIGHT + 12 },
          ]}
        >
          <TransportToggle transport={transport} onChange={setTransport} />
          <Pressable
            onPress={recentre}
            accessibilityLabel={t('Centreer kaart', 'Centre map')}
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
            <Ionicons name="locate" size={20} color={roles.fgMuted} />
          </Pressable>
        </View>
      )}
      <Modal
        visible={filterOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setFilterOpen(false)}
      >
        <AvondFilterSheet
          query={query}
          onlyFriends={onlyFriends}
          onlyFavorites={onlyFavorites}
          activeBlocks={activeBlocks}
          activeCats={activeCats}
          activeTypes={activeTypes}
          activeGenres={activeGenres}
          showFavoritesChip={showFavoritesChip}
          onSetFriends={setOnlyFriends}
          onSetFavorites={setOnlyFavorites}
          onToggleBlock={toggleBlock}
          onSetBlocks={setActiveBlocks}
          onSetCats={setActiveCats}
          onSetTypes={setActiveTypes}
          onSetGenres={setActiveGenres}
          onClose={() => setFilterOpen(false)}
        />
      </Modal>
    </View>
  );
}

function FilterButton({
  count,
  onPress,
}: {
  count: number;
  onPress: () => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const t = useT();
  const active = count > 0;
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      style={[
        styles.filterBtn,
        {
          borderColor: active ? roles.fg : roles.bgChip,
          backgroundColor: active ? roles.fg : 'transparent',
        },
      ]}
    >
      {!active && (
        <>
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
        </>
      )}
      <Ionicons
        name="options-outline"
        size={18}
        color={active ? roles.bg : roles.fgMuted}
      />
      {active && (
        <Text
          style={[
            styles.filterBtnCount,
            { color: roles.bg },
          ]}
        >
          {count}
        </Text>
      )}
      <Text style={{ display: 'none' }}>{t('Filter', 'Filter')}</Text>
    </Pressable>
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
  const t = useT();
  const [trackW, setTrackW] = useState(0);
  const activeIndex = view === 'map' ? 0 : 1;
  const progress = useSharedValue(activeIndex);
  useEffect(() => {
    progress.value = withTiming(activeIndex, {
      duration: 240,
      easing: Easing.bezier(0.65, 0, 0.35, 1),
    });
  }, [activeIndex, progress]);
  const blobStyle = useAnimatedStyle(() => {
    const inner = Math.max(0, trackW - 6);
    const w = inner / 2;
    return {
      width: w,
      transform: [{ translateX: progress.value * w }],
    };
  });
  return (
    <View
      style={[styles.switchTrack, { borderColor: roles.bgChip }]}
      onLayout={(e) => setTrackW(e.nativeEvent.layout.width)}
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
      <Animated.View
        pointerEvents="none"
        style={[
          styles.switchBlob,
          blobStyle,
          { backgroundColor: roles.accent },
        ]}
      />
      <SwitchBtn
        Icon={TabIconVenues}
        label={t('Kaart', 'Map')}
        active={view === 'map'}
        onPress={() => onChange('map')}
      />
      <SwitchBtn
        Icon={TabIconAgenda}
        label={t('Lijst', 'List')}
        active={view === 'list'}
        onPress={() => onChange('list')}
      />
    </View>
  );
}

function TransportToggle({
  transport,
  onChange,
}: {
  transport: TransportMode;
  onChange: (next: TransportMode) => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isWalk = transport === 'walk';
  return (
    <Pressable
      onPress={() => onChange(isWalk ? 'bike' : 'walk')}
      hitSlop={6}
      style={[styles.transport, { borderColor: roles.bgChip }]}
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
      <Ionicons
        name={isWalk ? 'walk-outline' : 'bicycle-outline'}
        size={18}
        color={roles.fgMuted}
      />
    </Pressable>
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
  // Icon-only — geen tekst-label naast de glyph. accessibilityLabel
  // op de Pressable houdt screen-readers tevreden.
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      style={styles.switchBtn}
    >
      <Icon color={tint} />
    </Pressable>
  );
}

/**
 * Event-marker met stabiele identiteit. Eerdere implementatie remountte
 * via een instabiele key (`id-minutes-active`); dat triggerde een
 * `AIRMap insertReactSubview:atIndex:` out-of-range crash op iOS bij
 * filter/transport-wisselingen waar tientallen markers tegelijk
 * remounten.
 *
 * tracksViewChanges staat default op false (pixel-snapshot, performant).
 * Bij visuele veranderingen (`isActive` of `minutes`) flippen we 'm
 * kort op true zodat de snapshot wordt vernieuwd, daarna direct weer
 * uit. Geen remount → geen crash.
 */
const EventMarker = memo(function EventMarker({
  m,
  isActive,
  onPress,
}: {
  m: MapEvent;
  isActive: boolean;
  onPress: (id: string) => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const tone: BadgeTone = CATEGORY_TICK[m.event.category];
  return (
    <MapMarker
      id={`evt-${m.event.id}`}
      lngLat={[m.event.venue.lng, m.event.venue.lat]}
      anchor="center"
      onPress={() => onPress(m.event.id)}
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
        <View style={[styles.dot, { backgroundColor: TONE[mode][tone] }]}>
          <Text
            style={[
              styles.dotText,
              {
                color: mode === 'nacht' ? palette.noir : palette.paper3,
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
    </MapMarker>
  );
});

function SheetRow({ mapEvent }: { mapEvent: MapEvent }) {
  const mode = useMode();
  const roles = useRoles();
  const locale = useLocale();
  const catTone = TONE[mode][CATEGORY_TICK[mapEvent.event.category]];
  const venueType = mapEvent.event.venue.type;
  const venueTone = venueType ? TONE[mode][VENUE_TYPE_TICK[venueType]] : null;
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
      {(() => {
        const img = eventImageUrl(mapEvent.event);
        return img ? (
          <Image
            source={{ uri: img }}
            style={styles.sheetThumb}
            contentFit="cover"
          />
        ) : null;
      })()}
      <View style={styles.sheetBody}>
        <Text
          numberOfLines={1}
          style={[styles.sheetTitle, { color: roles.fg }]}
        >
          {mapEvent.event.title}
        </Text>
        <View style={styles.sheetMetaRow}>
          {venueTone ? (
            <View
              style={[styles.sheetTag, { backgroundColor: `${venueTone}26` }]}
            >
              <Text style={[styles.sheetTagText, { color: venueTone }]}>
                {mapEvent.event.venue.name}
              </Text>
            </View>
          ) : (
            <Text
              numberOfLines={1}
              style={[styles.sheetVenue, { color: roles.fgMuted }]}
            >
              {mapEvent.event.venue.name}
            </Text>
          )}
          <View style={[styles.sheetTag, { backgroundColor: `${catTone}26` }]}>
            <Text style={[styles.sheetTagText, { color: catTone }]}>
              {translateCategory(mapEvent.event.category, locale)}
            </Text>
          </View>
          {friends.length > 0 && (
            <FriendAvatarStack friends={friends} />
          )}
        </View>
      </View>
      <Text style={[styles.sheetTime, { color: roles.fg }]}>
        {rowTimeLabel(mapEvent.event.startsAt, mapEvent.event.endsAt)}
      </Text>
    </Pressable>
  );
}

function DrawerCard({
  mapEvent,
  transport,
}: {
  mapEvent: MapEvent;
  transport: TransportMode;
}) {
  const mode = useMode();
  const roles = useRoles();
  const locale = useLocale();
  const catTone = TONE[mode][CATEGORY_TICK[mapEvent.event.category]];
  const venueType = mapEvent.event.venue.type;
  const venueTone = venueType ? TONE[mode][VENUE_TYPE_TICK[venueType]] : null;
  const transportIcon = transport === 'walk' ? 'walk-outline' : 'bicycle-outline';
  return (
    <Pressable
      onPress={() => router.push(`/event/${mapEvent.event.id}`)}
      style={styles.cardWrap}
    >
      <View style={styles.cardTop}>
        {(() => {
          const img = eventImageUrl(mapEvent.event);
          return img ? (
            <Image
              source={{ uri: img }}
              style={styles.cardThumb}
              contentFit="cover"
            />
          ) : null;
        })()}
        <View style={styles.cardBody}>
          <View style={styles.cardTimeRow}>
            <Ionicons
              name={transportIcon}
              size={16}
              color={roles.fgMuted}
            />
            <Text style={[styles.cardTime, { color: roles.fgMuted }]}>
              {mapEvent.minutes} min ·{' '}
              {rowTimeLabel(mapEvent.event.startsAt, mapEvent.event.endsAt)}
              {!venueTone ? ` · ${mapEvent.event.venue.name}` : ''}
            </Text>
          </View>
          <Text
            numberOfLines={2}
            style={[styles.cardTitle, { color: roles.fg }]}
          >
            {mapEvent.event.title}
          </Text>
          <View style={styles.cardMetaRow}>
            {venueTone && (
              <View
                style={[styles.cardTag, { backgroundColor: `${venueTone}26` }]}
              >
                <Text style={[styles.cardTagText, { color: venueTone }]}>
                  {mapEvent.event.venue.name}
                </Text>
              </View>
            )}
            <View style={[styles.cardTag, { backgroundColor: `${catTone}26` }]}>
              <Text style={[styles.cardTagText, { color: catTone }]}>
                {translateCategory(mapEvent.event.category, locale)}
              </Text>
            </View>
          </View>
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
                accent={catTone}
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

  // Sluit-knop in de toolbar-rij. 44×44 zodat 'ie dezelfde
  // footprint heeft als de andere toolbar-knoppen (FilterButton,
  // recentre, ViewSwitch) — voelt visueel als één familie, met
  // dezelfde blur + rgba-tint achtergrond.
  closeBtn: {
    width: 44,
    height: 44,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },

  // Floating overlay linksonder op de kaart — bevat de transport-
  // toggle (loop/fiets) + recentre-knop, verticaal gestapeld zodat
  // ze als één duim-bereik-blok lezen. pointerEvents=box-none op de
  // wrap zodat tussenruimte de map-pannen niet blokkeert.
  mapOverlay: {
    position: 'absolute',
    left: 18,
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 10,
    zIndex: 5,
  },

  // Kicker in row 1 van de AppHeader (Today · 41 plekken in de buurt)
  // — rechts uitgelijnd naast de title, één regel, inkort op smal
  // scherm. Comprimeert de header want geen aparte contextLine.
  headerKicker: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
    flexShrink: 1,
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
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    marginBottom: 8,
  },
  // Links-cluster: switch + filter dicht bij elkaar, daarna grote
  // witruimte naar de sluit-knop rechts (via space-between).
  toolbarLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },

  // Map/List view switch (in AppHeader children)
  switchTrack: {
    flexDirection: 'row',
    padding: 3,
    borderRadius: 999,
    borderWidth: 1,
    gap: 2,
    overflow: 'hidden',
  },
  switchBlob: {
    position: 'absolute',
    top: 3,
    left: 3,
    bottom: 3,
    borderRadius: 999,
  },
  // Icon-only switch button — compact, geen tekst meer. 44×38 zodat
  // de switch zelf op 44 hoog uitkomt (= matched aan andere toolbar-
  // knoppen). Beide halves samen geven dus een pill van 88×44.
  switchBtn: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 999,
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
    width: 44,
    height: 44,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },

  // Filter-knop — pill ernaast, count-bubble in accent als filter actief
  filterBtn: {
    height: 44,
    minWidth: 44,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 999,
    borderWidth: 1,
    overflow: 'hidden',
  },
  filterBtnCount: {
    fontFamily: fontFamily.monoMedium,
    fontSize: 12,
    letterSpacing: 0.5,
  },

  // Transport-mode toggle (walk/bike) — zelfde pill-stijl als recentre.
  transport: {
    width: 44,
    height: 44,
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
  // "X min · 20:00" bóven de titel — bold sans + transport-icoon
  // (walk/bike). Zelfde plek als de datum-regel op de venue-pagina:
  // klein, gedempt, leidt het oog naar de titel.
  cardTimeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  cardTime: {
    fontFamily: fontFamily.bold,
    fontSize: 13,
    letterSpacing: -0.1,
  },
  cardTitle: {
    fontFamily: fontFamily.bold,
    fontSize: 18,
    letterSpacing: -0.27,
    lineHeight: 20,
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
    width: 26,
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetMinNum: {
    fontFamily: fontFamily.display,
    fontSize: 18,
    letterSpacing: -0.18,
    lineHeight: 20,
    textAlign: 'center',
  },
  sheetMinUnit: {
    fontFamily: fontFamily.mono,
    fontSize: 9,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginTop: 1,
  },
  sheetThumb: {
    width: 40,
    height: 40,
    borderRadius: 8,
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
    fontFamily: fontFamily.bold,
    fontSize: 14,
    letterSpacing: -0.14,
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
