import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { Image } from 'expo-image';
import { router, useFocusEffect } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
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
import { RefreshBanner } from '@/components/RefreshBanner';
import {
  buildClusterIndex,
  getClusterMarkers,
  type ClusterMarker as ClusterMarkerData,
} from '@/lib/mapCluster';
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
import { useKaartFilters } from '@/store/kaartFilters';
import { fontFamily, palette } from '@/theme/tokens';

import { AvondFilterSheet } from './avond';

const TONE = {
  nacht: {
    acid: palette.acid,
    flare: palette.flare,
    plum: palette.plum,
    azure: palette.azure,
    saffron: palette.saffron,
    cobalt: palette.cobalt,
  },
  dag: {
    acid: palette.red,
    flare: palette.forest,
    plum: palette.cobalt,
    azure: '#8a5b00',
    saffron: '#9d6008',
    cobalt: '#1a3157',
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

/** Pin-eenheid: één event op één locatie. Voor films met multi-venue
    (Anora bij Eye én Kriterion) komt het zelfde event als twee
    MapEvents terug, elk met de venue-specifieke coords. Voor single-
    venue events (concerts/theater/exhibitions) is 't één-op-één met
    het event. */
type MapEvent = {
  /** `${event.id}::${venueId}` — uniek per pin zodat activeId multi-
      venue films correct kan onderscheiden. */
  id: string;
  event: ApiEvent;
  /** Resolved venue voor dit specifieke pin. Voor films de occurrence-
      venue, anders event.venue. */
  venue: {
    id: string;
    slug: string;
    name: string;
    lat: number;
    lng: number;
    type: string | null;
  };
  /** Tijd-label van de eerstvolgende occurrence op déze venue. */
  startsAt: string;
  endsAt: string | null;
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
    lean: true,
  });

  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    const start = Date.now();
    try {
      await qc.invalidateQueries({ queryKey: ['events'] });
    } finally {
      const elapsed = Date.now() - start;
      if (elapsed < 700) await new Promise((r) => setTimeout(r, 700 - elapsed));
      setRefreshing(false);
    }
  }, [qc]);

  // Filters zijn eigen aan Kaart (runtime-only) — eerder deelde
  // deze tab de useVandaagFilters store, maar dat lekte cat/type-
  // keuzes naar de Vandaag-rails. Filter-sheet hergebruikt
  // AvondFilterSheet voor de UI; alleen de state is losgekoppeld.
  const query = useKaartFilters((s) => s.query);
  const onlyFriends = useKaartFilters((s) => s.onlyFriends);
  const onlyFavorites = useKaartFilters((s) => s.onlyFavorites);
  const activeBlocks = useKaartFilters((s) => s.activeBlocks);
  const activeCats = useKaartFilters((s) => s.activeCats);
  const activeTypes = useKaartFilters((s) => s.activeTypes);
  const setOnlyFriends = useKaartFilters((s) => s.setOnlyFriends);
  const setOnlyFavorites = useKaartFilters((s) => s.setOnlyFavorites);
  const setActiveBlocks = useKaartFilters((s) => s.setActiveBlocks);
  const setActiveCats = useKaartFilters((s) => s.setActiveCats);
  const setActiveTypes = useKaartFilters((s) => s.setActiveTypes);
  const toggleBlock = useKaartFilters((s) => s.toggleBlock);

  const showFavoritesChip = useMemo(
    () => Boolean(events?.some((e) => e.venueFollowed)),
    [events]
  );

  const mapEvents: MapEvent[] = useMemo(() => {
    if (!events) return [];
    const needle = query.trim().toLowerCase();
    const result: MapEvent[] = [];
    for (const e of events) {
      if (e.kind === 'exhibition') continue;
      if (activeCats.length > 0 && !activeCats.includes(e.category)) continue;
      if (onlyFriends && (e.friendsSaved?.length ?? 0) === 0) continue;
      if (onlyFavorites && !e.venueFollowed) continue;

      // Splits over occurrence-venues: voor films met multi-venue
      // (Anora bij Eye én Kriterion) komt 't event als meerdere pins,
      // elk op de juiste locatie. Group eerst per venueId zodat we
      // dezelfde-venue-occurrences niet dubbel renderen. Fallback op
      // event.venue als de occurrences geen eigen venue hebben (legacy
      // rows of als 't endpoint occurrencesInRange niet meegeeft).
      type Bucket = {
        venue: MapEvent['venue'];
        startsAt: string;
        endsAt: string | null;
      };
      const byVenue = new Map<string, Bucket>();
      const occs = e.occurrencesInRange ?? [];
      for (const o of occs) {
        // Fallback op event.venue als de occurrence-venue ontbreekt
        // (legacy/cached responses voor 2026-05-19's deploy) OF als
        // ze coords mist (oudere cache schreef alleen id/slug/name).
        // Zonder finite lat/lng crasht MLRN's PointAnnotation op
        // asDouble().
        const occVenue = o.venue;
        const useOcc =
          occVenue &&
          Number.isFinite(occVenue.lat) &&
          Number.isFinite(occVenue.lng);
        const v = useOcc
          ? occVenue
          : {
              id: e.venue.id,
              slug: e.venue.slug,
              name: e.venue.name,
              lat: e.venue.lat,
              lng: e.venue.lng,
              type: e.venue.type ?? null,
            };
        const existing = byVenue.get(v.id);
        // Eerstvolgende occurrence per venue houden — sortering komt al
        // uit de backend (asc) maar we kunnen niet aannemen, dus expliciet.
        if (
          !existing ||
          new Date(o.startsAt).getTime() < new Date(existing.startsAt).getTime()
        ) {
          byVenue.set(v.id, {
            venue: v,
            startsAt: o.startsAt,
            endsAt: o.endsAt,
          });
        }
      }
      // Fallback: geen occurrences in range → één pin op event.venue
      // met event-niveau startsAt/endsAt.
      if (byVenue.size === 0 && e.startsAt) {
        byVenue.set(e.venue.id, {
          venue: {
            id: e.venue.id,
            slug: e.venue.slug,
            name: e.venue.name,
            lat: e.venue.lat,
            lng: e.venue.lng,
            type: e.venue.type ?? null,
          },
          startsAt: e.startsAt,
          endsAt: e.endsAt,
        });
      }

      for (const bucket of byVenue.values()) {
        // Defensive: alleen pins met finite lat/lng renderen — MapLibre's
        // PointAnnotation crashed op asDouble() als er een null/NaN
        // doorglipt (gebeurde bij occurrence-venues die door een join-
        // edge case zonder coords kwamen). Stille drop is hier veiliger
        // dan een hele-kaart-crash.
        if (
          !Number.isFinite(bucket.venue.lat) ||
          !Number.isFinite(bucket.venue.lng)
        ) {
          continue;
        }
        // Per-pin filters: type (op de pin-venue, niet event.venue),
        // time-block (op deze occurrence) en text-search (incl. venue-
        // naam van deze pin).
        if (activeTypes.length > 0) {
          const vtype = bucket.venue.type as (typeof activeTypes)[number] | null;
          if (!vtype || !activeTypes.includes(vtype)) {
            continue;
          }
        }
        if (activeBlocks.length > 0) {
          const block = getTimeBlock(new Date(bucket.startsAt).getHours());
          if (!activeBlocks.includes(block)) continue;
        }
        if (needle.length > 0) {
          const inTitle = e.title.toLowerCase().includes(needle);
          const inVenue = bucket.venue.name.toLowerCase().includes(needle);
          const inGenres = (e.genres ?? []).some((g) =>
            g.toLowerCase().includes(needle)
          );
          if (!inTitle && !inVenue && !inGenres) continue;
        }
        result.push({
          id: `${e.id}::${bucket.venue.id}`,
          event: e,
          venue: bucket.venue,
          startsAt: bucket.startsAt,
          endsAt: bucket.endsAt,
          minutes: travelMinutes(
            centre,
            { lat: bucket.venue.lat, lng: bucket.venue.lng },
            transport
          ),
        });
      }
    }
    return result;
  }, [
    events,
    centre,
    transport,
    query,
    activeCats,
    activeTypes,
    activeBlocks,
    onlyFriends,
    onlyFavorites,
  ]);

  const filterCount =
    activeBlocks.length +
    activeCats.length +
    activeTypes.length +
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

  const activeMapEvent = mapEvents.find((m) => m.id === activeId) ?? null;

  // Map clustering: bouw één index op `mapEvents`, recomputeer welke
  // markers tonen wanneer zoom of viewport-bbox wijzigt. Default-bbox
  // dekt heel groot-Amsterdam zodat de initial render (vóór de eerste
  // onRegionDidChange) al een correct beeld geeft.
  const [viewport, setViewport] = useState<{
    zoom: number;
    bbox: [number, number, number, number];
  }>({
    zoom: 13,
    bbox: [4.7, 52.28, 5.05, 52.45],
  });
  const clusterIndex = useMemo(() => {
    if (mapEvents.length === 0) return null;
    return buildClusterIndex(
      mapEvents.map((m) => ({
        id: m.id,
        lng: m.venue.lng,
        lat: m.venue.lat,
        payload: m,
      }))
    );
  }, [mapEvents]);
  const clusterMarkers = useMemo<ClusterMarkerData<MapEvent>[]>(() => {
    if (!clusterIndex) return [];
    return getClusterMarkers(clusterIndex, viewport.bbox, viewport.zoom);
  }, [clusterIndex, viewport]);

  const zoomToCluster = useCallback(
    (lng: number, lat: number, bbox: [number, number, number, number]) => {
      // Pragmatische zoom-stap op basis van bbox-spread, met een
      // ondergrens (huidige zoom + 2) en bovengrens (16).
      const span = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]);
      let targetZoom = viewport.zoom + 2;
      if (span > 0.02) targetZoom = viewport.zoom + 1.5;
      if (span > 0.05) targetZoom = viewport.zoom + 1;
      if (targetZoom > 16) targetZoom = 16;
      cameraRef.current?.flyTo({
        center: [lng, lat],
        zoom: targetZoom,
        duration: 450,
      });
    },
    [viewport.zoom]
  );

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
        <>
          <RefreshBanner
            visible={refreshing}
            topOffset={insets.top + HEADER_HEIGHT + CONTROLS_HEIGHT + 8}
          />
          <FlatList
            data={sorted}
            keyExtractor={(m) => m.id}
            renderItem={({ item }) => <SheetRow mapEvent={item} />}
            ListHeaderComponent={
              <Text style={[styles.listKicker, { color: roles.fgMuted }]}>
                In de buurt
              </Text>
            }
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{
              paddingTop: insets.top + HEADER_HEIGHT + CONTROLS_HEIGHT + 8,
              paddingBottom: insets.bottom + 110,
            }}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={roles.accent}
                colors={[roles.accent]}
                title={
                  refreshing
                    ? t('Vernieuwen…', 'Refreshing…')
                    : t('Trek om te vernieuwen', 'Pull to refresh')
                }
                titleColor={roles.fgMuted}
                progressViewOffset={insets.top + HEADER_HEIGHT + CONTROLS_HEIGHT + 60}
              />
            }
            windowSize={7}
            initialNumToRender={8}
            maxToRenderPerBatch={8}
            removeClippedSubviews
          />
        </>
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
            // Zoom + bbox-tracking voor clustering. onRegionDidChange
            // vuurt na een pan/zoom-rust — niet bij elk frame — dus
            // recomputeer-cost blijft klein.
            onRegionDidChange={(event) => {
              const { zoom: z, bounds } = event.nativeEvent;
              if (
                typeof z === 'number' &&
                bounds &&
                bounds.length === 4 &&
                (Math.abs(z - viewport.zoom) >= 0.5 ||
                  Math.abs(bounds[0] - viewport.bbox[0]) > 0.005 ||
                  Math.abs(bounds[2] - viewport.bbox[2]) > 0.005)
              ) {
                setViewport({
                  zoom: z,
                  bbox: [bounds[0], bounds[1], bounds[2], bounds[3]],
                });
              }
            }}
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

            {/* Cluster + event-markers. Bij uitgezoomd zicht klonteren
                overlappende pins samen tot een cluster-marker met een
                count; ingezoomd vallen ze uiteen in individuele
                EventMarkers. Friend-overlay komt terug zodra
                friendships in de DB staan. */}
            {clusterMarkers.map((c) =>
              c.type === 'cluster' ? (
                <ClusterMarker
                  key={`c-${c.id}`}
                  count={c.count}
                  lng={c.lng}
                  lat={c.lat}
                  onPress={() => zoomToCluster(c.lng, c.lat, c.bbox)}
                />
              ) : (
                <EventMarker
                  key={c.id}
                  m={c.payload}
                  isActive={activeId === c.id}
                  onPress={selectEvent}
                />
              )
            )}
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
          // Sluit-knop in dezelfde stijl als /theater en /films —
          // 36×36 ronde knop met paper2/noir2 surface en X-icoon.
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
            style={[
              styles.closeBtn,
              { backgroundColor: mode === 'nacht' ? palette.noir2 : palette.paper2 },
            ]}
          >
            <Ionicons name="close" size={20} color={roles.fg} />
          </Pressable>
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
          showFavoritesChip={showFavoritesChip}
          onSetFriends={setOnlyFriends}
          onSetFavorites={setOnlyFavorites}
          onToggleBlock={toggleBlock}
          onSetBlocks={setActiveBlocks}
          onSetCats={setActiveCats}
          onSetTypes={setActiveTypes}
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
        iconName="map-outline"
        label={t('Kaart', 'Map')}
        active={view === 'map'}
        onPress={() => onChange('map')}
      />
      <SwitchBtn
        iconName="list-outline"
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
  iconName,
  label,
  active,
  onPress,
}: {
  iconName: React.ComponentProps<typeof Ionicons>['name'];
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
      <Ionicons name={iconName} size={20} color={tint} />
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
      id={`evt-${m.id}`}
      lngLat={[m.venue.lng, m.venue.lat]}
      anchor="center"
      onPress={() => onPress(m.id)}
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

/**
 * Cluster-marker: ronde pill met aantal samengevoegde events. Tap →
 * caller zoomt in zodat 't cluster uiteenvalt in individuele markers.
 */
const ClusterMarker = memo(function ClusterMarker({
  count,
  lng,
  lat,
  onPress,
}: {
  count: number;
  lng: number;
  lat: number;
  onPress: () => void;
}) {
  const roles = useRoles();
  // Iets grotere pill bij grote clusters voor visuele hiërarchie.
  const size = count >= 50 ? 56 : count >= 20 ? 48 : 40;
  return (
    <MapMarker
      id={`cluster-${lng}-${lat}`}
      lngLat={[lng, lat]}
      anchor="center"
      onPress={onPress}
    >
      <View
        style={[
          styles.cluster,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: roles.accent,
          },
        ]}
      >
        <Text style={[styles.clusterText, { color: roles.onAccent }]}>
          {count}
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
  const venueType = mapEvent.venue.type;
  const venueTone =
    venueType && (VENUE_TYPE_TICK as Record<string, BadgeTone>)[venueType]
      ? TONE[mode][(VENUE_TYPE_TICK as Record<string, BadgeTone>)[venueType]]
      : null;
  const friends = mapEvent.event.friendsSaved ?? [];

  return (
    <Pressable
      onPress={() => router.push(`/event/${mapEvent.event.id}?source=kaart`)}
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
                {mapEvent.venue.name}
              </Text>
            </View>
          ) : (
            <Text
              numberOfLines={1}
              style={[styles.sheetVenue, { color: roles.fgMuted }]}
            >
              {mapEvent.venue.name}
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
        {rowTimeLabel(mapEvent.startsAt, mapEvent.endsAt)}
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
  const venueType = mapEvent.venue.type;
  const venueTone =
    venueType && (VENUE_TYPE_TICK as Record<string, BadgeTone>)[venueType]
      ? TONE[mode][(VENUE_TYPE_TICK as Record<string, BadgeTone>)[venueType]]
      : null;
  const transportIcon = transport === 'walk' ? 'walk-outline' : 'bicycle-outline';
  return (
    <Pressable
      onPress={() => router.push(`/event/${mapEvent.event.id}?source=kaart`)}
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
              {rowTimeLabel(mapEvent.startsAt, mapEvent.endsAt)}
              {!venueTone ? ` · ${mapEvent.venue.name}` : ''}
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
                  {mapEvent.venue.name}
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

  // Sluit-knop in rightSlot — zelfde maat/stijl als op /theater en
  // /films voor visuele consistentie tussen secundaire pagina's.
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
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
  cluster: {
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 6,
    elevation: 5,
  },
  clusterText: {
    fontFamily: fontFamily.bold,
    fontSize: 14,
    letterSpacing: -0.2,
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
