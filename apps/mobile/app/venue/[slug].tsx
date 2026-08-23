import { Ionicons } from '@expo/vector-icons';
import MaskedView from '@react-native-masked-view/masked-view';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type LayoutChangeEvent,
  Linking,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  SectionList,
  type SectionListData,
  Share,
  StyleSheet,
  Text,
  View,
  type ViewToken,
} from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Cross } from '@/components/Cross';
import { EventListRow } from '@/components/EventListRow';
import { RefreshBanner } from '@/components/RefreshBanner';
import { SpinningCross } from '@/components/SpinningCross';
import type { ApiVenueProgramItem, VenueFollowState } from '@/lib/api';
import {

  CATEGORY_TICK,
  dowMixed,
  formatWijk,
  monthShort,
  translateCategory,
  translateVenueCapacity,
  translateVenueScene,
  translateVenueType,
  VENUE_TYPE_TICK,
  formatTime,
  formatTimeRange,
  formatDateRange,
  isAllDayRange,
} from '@/lib/eventDisplay';
import { useLocale, useT, type Locale } from '@/lib/i18n';
import { safeBack } from '@/lib/navigation';
import { useSession } from '@/lib/authClient';
import { useSetVenueFollow, useVenue } from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

const HERO_HEIGHT = 380;
const PILL_BAR_HEIGHT = 44;

// Animated wrapper rond SectionList — werkt identiek als Animated.View
// voor onScroll, maar geeft ons SectionList's virtualization. Pure JS-
// thread onScroll houden we zoals bij de oude Animated.ScrollView.
// `as typeof SectionList` herstelt de generic typing die Animated's
// wrapper anders weggooit (anders krijg je `SectionList<unknown,
// unknown>` op de ref).
const AnimatedSectionList = Animated.createAnimatedComponent(
  SectionList
) as unknown as typeof SectionList;

export default function VenueDetail() {
  const { slug: rawSlug } = useLocalSearchParams<{ slug: string }>();
  const slug = rawSlug ?? '';
  const mode = useMode();
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const isNacht = mode === 'nacht';
  const t = useT();
  const locale = useLocale();

  const scrollRef = useRef<SectionList<ApiVenueProgramItem, MonthGroup>>(null);
  // scrollY wordt via JS-thread onScroll geüpdatet (zie verderop).
  // Animated styles lezen 'm via .value op de UI-thread — werkt
  // identiek als bij useScrollViewOffset, maar geeft ons één plek
  // (de onScroll-callback) waar zowel de SharedValue als alle
  // afhankelijke React-state worden bijgewerkt. Geen worklet +
  // runOnJS-keten meer, die was te broos op fysieke devices bij
  // venue-switching.
  const scrollY = useSharedValue(0);
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

  // Pull-to-refresh: invalideert de venue + events caches. Hooks
  // staan vóór de early returns om Rules of Hooks te respecteren.
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    const start = Date.now();
    try {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['venue', slug] }),
        qc.invalidateQueries({ queryKey: ['events'] }),
      ]);
    } finally {
      const elapsed = Date.now() - start;
      if (elapsed < 700) {
        await new Promise((r) => setTimeout(r, 700 - elapsed));
      }
      setRefreshing(false);
    }
  }, [qc, slug]);

  // Maand-groepering voor de scroll-to maand-pills. Werkt op
  // `data?.events ?? []` zodat de hook altijd draait, ook in de
  // loading/error-fase (Rules of Hooks).
  const monthGroups = useMemo<MonthGroup[]>(
    () => groupEventsByMonth(data?.events ?? [], locale),
    [data?.events, locale]
  );
  const showMonthPills = monthGroups.length > 1;
  const [activeMonthKey, setActiveMonthKey] = useState<string | null>(null);
  const [stickyVisible, setStickyVisible] = useState(false);
  // Y-offset van de progSection in scroll-content + relatieve y van de
  // inline pill-bar binnen progSection. SharedValues zodat de animated
  // style ze direct kan lezen voor de fade-in threshold; JS-handlers
  // lezen via .value.
  const progSectionY = useSharedValue(0);
  const inlinePillsY = useSharedValue(0);

  // Sections voor SectionList — month-groups met `data: events` zoals
  // SectionList verwacht. Behoudt de andere MonthGroup-velden (key,
  // label, monthIdx) voor renderSectionHeader.
  const sections = useMemo(
    () => monthGroups.map((g) => ({ ...g, data: g.events })),
    [monthGroups]
  );

  // Sticky topBar-pills fade pas in zodra de inline pill-bar voorbij
  // de onderkant van de topBar is gescrold — voorkomt dubbele pills
  // wanneer beide tegelijk in beeld zouden staan. Threshold is
  // `progSectionY + inlinePillsY + PILL_BAR_HEIGHT - topBarBottom`;
  // fade-window van 60px erboven naar 20px eronder voor een zachte
  // overgang.
  const topBarBottom = insets.top + 50;
  const pillsStickyStyle = useAnimatedStyle(() => {
    const threshold =
      progSectionY.value + inlinePillsY.value + PILL_BAR_HEIGHT - topBarBottom;
    return {
      opacity: interpolate(
        scrollY.value,
        [threshold - 60, threshold + 20],
        [0, 1],
        Extrapolation.CLAMP
      ),
    };
  });

  // JS-thread onScroll: updatet scrollY (voor animated styles) en de
  // sticky-visible state. Active-month detectie gebeurt via
  // onViewableItemsChanged op de SectionList — Y-meten op individuele
  // maand-secties werkt niet meer in een virtualized lijst (off-screen
  // sections zijn niet gemount).
  const lastStickyRef = useRef(false);
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const y = e.nativeEvent.contentOffset.y;
      scrollY.value = y;

      const threshold =
        progSectionY.value +
        inlinePillsY.value +
        PILL_BAR_HEIGHT -
        topBarBottom;
      const newVisible = y > threshold - 20;
      if (newVisible !== lastStickyRef.current) {
        lastStickyRef.current = newVisible;
        setStickyVisible(newVisible);
      }
    },
    [scrollY, progSectionY, inlinePillsY, topBarBottom]
  );

  // Active-month-detectie via viewableItems. Twee gotcha's (zelfde
  // patroon als Agenda's day-strip):
  //  1) viewableItems[0] is de topmost row, vaak nog van de vorige
  //     maand bij sectie-grenzen (1px telt met threshold=0). We pakken
  //     daarom de sectie die het meest vertegenwoordigd is in de
  //     zichtbare items — dat is wat de gebruiker écht ziet — én
  //     verhogen de threshold naar 50% zodat een staart-rij niet
  //     meetelt.
  //  2) Tijdens een tap-geinitieerde scroll (isProgrammaticScroll)
  //     skippen we updates volledig zodat tussenliggende maanden de
  //     chip niet flickeren tot landing. onScrollBeginDrag clear't
  //     de flag bij een echte user-touch.
  const isProgrammaticScroll = useRef(false);
  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      if (isProgrammaticScroll.current) return;
      if (viewableItems.length === 0) return;
      const counts = new Map<string, number>();
      for (const v of viewableItems) {
        const k = (v.section as MonthGroup | undefined)?.key;
        if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      let bestKey: string | undefined;
      let bestCount = 0;
      for (const [k, c] of counts.entries()) {
        if (c > bestCount) {
          bestCount = c;
          bestKey = k;
        }
      }
      if (bestKey) {
        setActiveMonthKey((prev) => (prev === bestKey ? prev : bestKey!));
      }
    }
  ).current;
  const viewabilityConfig = useRef({
    itemVisiblePercentThreshold: 50,
  }).current;

  // Onthoudt de target-section voor de retry-fallback van
  // onScrollToIndexFailed (zelfde patroon als Agenda).
  const pendingSectionRef = useRef<number | null>(null);

  const handleMonthPress = useCallback(
    (key: string) => {
      const sectionIndex = monthGroups.findIndex((g) => g.key === key);
      if (sectionIndex < 0) return;
      pendingSectionRef.current = sectionIndex;
      isProgrammaticScroll.current = true;
      // Spring direct visueel naar de target — onViewableItemsChanged
      // is uitgezet tijdens de scroll-animatie.
      setActiveMonthKey(key);
      scrollRef.current?.scrollToLocation({
        sectionIndex,
        itemIndex: 0,
        // Offset zodat de month-header net onder de top-bar valt ipv
        // erachter te verdwijnen.
        viewOffset: topBarBottom + (showMonthPills ? PILL_BAR_HEIGHT : 0),
        animated: true,
      });
    },
    [monthGroups, topBarBottom, showMonthPills]
  );

  // User-touch op de lijst clear't de programmatic-flag (zo nemen
  // onViewableItemsChanged-updates het over). Op Android killt 'n
  // scrollTo naar de huidige Y de lopende scrollToLocation-animatie
  // zodat de drag-gesture 't kan overnemen — iOS doet dat zelf.
  const onScrollBeginDrag = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const wasProgrammatic = isProgrammaticScroll.current;
      isProgrammaticScroll.current = false;
      pendingSectionRef.current = null;
      if (Platform.OS === 'android' && wasProgrammatic) {
        const y = e.nativeEvent.contentOffset.y;
        scrollRef.current?.getScrollResponder()?.scrollTo({ y, animated: false });
      }
    },
    []
  );

  // Fallback wanneer scrollToLocation faalt door variable-height items
  // of nog niet gemounted sections — voorkomt EXC_BAD_ACCESS-crashes
  // op iOS Fabric. Twee-staps: eerst grof scrollen op basis van avg
  // item length, dan opnieuw scrollToLocation.
  const onScrollToIndexFailed = useCallback(
    (info: {
      index: number;
      highestMeasuredFrameIndex: number;
      averageItemLength: number;
    }) => {
      const offset = topBarBottom + (showMonthPills ? PILL_BAR_HEIGHT : 0);
      scrollRef.current?.getScrollResponder()?.scrollTo({
        y: Math.max(0, info.averageItemLength * info.index - offset),
        animated: true,
      });
      setTimeout(() => {
        const target = pendingSectionRef.current;
        if (target !== null) {
          scrollRef.current?.scrollToLocation({
            sectionIndex: target,
            itemIndex: 0,
            viewOffset: offset,
            animated: true,
          });
        }
      }, 200);
    },
    [topBarBottom, showMonthPills]
  );

  if (isLoading || (!data && !error)) {
    return <VenueFallback>{undefined}</VenueFallback>;
  }
  if (error || !data) {
    return (
      <VenueFallback tone="error">
        {t('Deze venue is niet beschikbaar.', 'This venue is not available.')}
      </VenueFallback>
    );
  }

  const { venue, events } = data;
  const hasAddress = venue.address.trim().length > 0;
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

      <RefreshBanner
        visible={refreshing}
        topOffset={insets.top + 60}
      />
      <AnimatedSectionList
        ref={scrollRef}
        sections={sections}
        keyExtractor={(item) => (item as ApiVenueProgramItem).id}
        renderItem={({ item }) => (
          // Wrapper met bg-color zodat de events de absolute-pinned hero
          // niet doorheen laten zien (in de oude ScrollView-versie zat
          // dat op de progSection-wrapper, die nu in ListHeaderComponent
          // alleen het kop-deel dekt).
          <View style={{ backgroundColor: roles.bg }}>
            <ProgramRow
              event={item as ApiVenueProgramItem}
              venueImageUrl={venue.imageUrl ?? null}
            />
          </View>
        )}
        renderSectionHeader={({ section }) =>
          showMonthPills ? (
            <View style={{ backgroundColor: roles.bg }}>
              <Text style={[styles.monthHeader, { color: roles.fgMuted }]}>
                {(section as SectionListData<ApiVenueProgramItem, MonthGroup>).label}
              </Text>
            </View>
          ) : null
        }
        stickySectionHeadersEnabled={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        onScrollBeginDrag={onScrollBeginDrag}
        onScrollToIndexFailed={onScrollToIndexFailed}
        windowSize={11}
        initialNumToRender={12}
        removeClippedSubviews
        ListFooterComponent={
          // Vult de ruimte onder de laatste event-row + de bottom-
          // padding met de bg-kleur, anders schemert de heroPinned
          // erdoorheen voor venues met weinig events.
          <View style={{ backgroundColor: roles.bg, minHeight: 400 }} />
        }
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={roles.accent}
            colors={[roles.accent]}
          />
        }
        ListHeaderComponent={
          <>
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
          {(venue.type ||
            venue.dayNight ||
            venue.wijk ||
            venue.scene ||
            venue.capacity ||
            (venue.subtype ?? []).length > 0) && (
            <View style={styles.metaPills}>
              {venue.type && (() => {
                const toneKey = VENUE_TYPE_TICK[venue.type];
                const tone =
                  isNacht
                    ? toneKey === 'acid'
                      ? palette.acid
                      : toneKey === 'flare'
                        ? palette.flare
                        : toneKey === 'plum'
                          ? palette.plum
                          : palette.azure
                    : toneKey === 'acid'
                      ? palette.red
                      : toneKey === 'flare'
                        ? palette.forest
                        : toneKey === 'plum'
                          ? palette.cobalt
                          : '#0f6e8c';
                return (
                  <View
                    style={[
                      styles.metaPill,
                      { backgroundColor: `${tone}30` },
                    ]}
                  >
                    <Text style={[styles.metaPillText, { color: tone }]}>
                      {translateVenueType(venue.type, locale)}
                    </Text>
                  </View>
                );
              })()}
              {venue.dayNight && (
                <View
                  style={[
                    styles.metaPill,
                    { backgroundColor: roles.bgTag },
                  ]}
                >
                  <Ionicons
                    name={
                      venue.dayNight === 'day'
                        ? 'sunny-outline'
                        : venue.dayNight === 'night'
                          ? 'moon-outline'
                          : 'contrast-outline'
                    }
                    size={12}
                    color={roles.fgMuted}
                    style={{ marginRight: 4 }}
                  />
                  <Text style={[styles.metaPillText, { color: roles.fg }]}>
                    {venue.dayNight === 'day'
                      ? t('Dag', 'Day')
                      : venue.dayNight === 'night'
                        ? t('Avond', 'Evening')
                        : t('Beide', 'Both')}
                  </Text>
                </View>
              )}
              {venue.wijk && (
                <View
                  style={[
                    styles.metaPill,
                    { backgroundColor: roles.bgTag },
                  ]}
                >
                  <Text style={[styles.metaPillText, { color: roles.fg }]}>
                    {formatWijk(venue.wijk)}
                  </Text>
                </View>
              )}
              {venue.scene && (
                <View
                  style={[
                    styles.metaPill,
                    { backgroundColor: roles.bgTag },
                  ]}
                >
                  <Text style={[styles.metaPillText, { color: roles.fg }]}>
                    {translateVenueScene(venue.scene, locale)}
                  </Text>
                </View>
              )}
              {venue.capacity && (
                <View
                  style={[
                    styles.metaPill,
                    { backgroundColor: roles.bgTag },
                  ]}
                >
                  <Text style={[styles.metaPillText, { color: roles.fg }]}>
                    {translateVenueCapacity(venue.capacity, locale)}
                  </Text>
                </View>
              )}
              {(venue.subtype ?? []).map((s) => (
                <View
                  key={s}
                  style={[
                    styles.metaPill,
                    { backgroundColor: roles.bgTag },
                  ]}
                >
                  <Text style={[styles.metaPillText, { color: roles.fg }]}>
                    {s}
                  </Text>
                </View>
              ))}
            </View>
          )}
          {hasAddress && (
            <View
              style={[
                styles.addr,
                { borderColor: isNacht ? '#1f1f23' : palette.paper },
              ]}
            >
              <View style={styles.addrText}>
                <Text style={[styles.addrLine, { color: roles.fgRead }]}>
                  {addrLine1}
                </Text>
                {addrLine2.length > 0 && (
                  <Text style={[styles.addrLine, { color: roles.fgRead }]}>
                    {addrLine2}
                  </Text>
                )}
              </View>
              <View style={styles.addrActions}>
                <Pressable
                  onPress={() => openMaps(venue.name, venue.lat, venue.lng)}
                  hitSlop={10}
                  accessibilityLabel={t('Route openen', 'Open route')}
                  style={styles.addrMapBtn}
                >
                  <Ionicons
                    name="map-outline"
                    size={20}
                    color={roles.fgMuted}
                  />
                </Pressable>
                {venue.website && (
                  <Pressable
                    onPress={() => openWebsite(venue.website!)}
                    hitSlop={10}
                    accessibilityLabel={t('Website openen', 'Open website')}
                    style={styles.addrMapBtn}
                  >
                    <Ionicons
                      name="globe-outline"
                      size={20}
                      color={roles.fgMuted}
                    />
                  </Pressable>
                )}
                {venue.instagram && (
                  <Pressable
                    onPress={() => openInstagram(venue.instagram!)}
                    hitSlop={10}
                    accessibilityLabel={t('Instagram openen', 'Open Instagram')}
                    style={styles.addrMapBtn}
                  >
                    <Ionicons
                      name="logo-instagram"
                      size={20}
                      color={roles.fgMuted}
                    />
                  </Pressable>
                )}
              </View>
            </View>
          )}

          {venue.description && (
            <Text style={[styles.desc, { color: roles.fgRead }]}>
              {venue.description}
            </Text>
          )}
        </View>

        {(events.length > 0 || (data.series && data.series.length > 0)) && (
          <View
            style={[styles.progSection, { backgroundColor: roles.bg }]}
            onLayout={(e: LayoutChangeEvent) => {
              progSectionY.value = e.nativeEvent.layout.y;
            }}
          >
            <View style={styles.progHead}>
              <Text style={[styles.progLabel, { color: roles.fg }]}>
                {t('Programma', 'Programme')}
              </Text>
            </View>

            {data.series && data.series.length > 0 && (
              <View style={styles.seriesPillStack}>
                {data.series.map((s) => (
                  <Pressable
                    key={s.id}
                    onPress={() => router.push(`/series/${s.slug}` as never)}
                    style={[
                      styles.seriesPill,
                      { borderColor: isNacht ? '#2a2a2e' : palette.paper },
                    ]}
                  >
                    <Ionicons name="layers-outline" size={20} color={roles.fg} />
                    <Text
                      style={[styles.seriesPillName, { color: roles.fg }]}
                      numberOfLines={1}
                    >
                      {s.name}
                    </Text>
                    <Text
                      style={[styles.seriesChev, { color: roles.fgPlaceholder }]}
                    >
                      ›
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}

            {showMonthPills && (
              <View
                onLayout={(e: LayoutChangeEvent) => {
                  inlinePillsY.value = e.nativeEvent.layout.y;
                }}
              >
                <MonthPills
                  groups={monthGroups}
                  activeKey={activeMonthKey}
                  onPress={handleMonthPress}
                />
              </View>
            )}
          </View>
        )}
          </>
        }
      />

      {/* Top bar */}
      <View
        style={[
          styles.topBar,
          {
            height:
              insets.top + 50 + (showMonthPills ? PILL_BAR_HEIGHT : 0),
            paddingTop: insets.top + 2,
          },
        ]}
      >
        {/* Blur fadet aan de onderkant naar transparant zodat scroll-
            content er onderdoor netjes vervaagt — zelfde behandeling
            als AppHeader's non-solid mode. */}
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, stickyStyle]}
        >
          <MaskedView
            style={StyleSheet.absoluteFill}
            maskElement={
              <LinearGradient
                colors={['#000', '#000', 'transparent']}
                locations={[0, 0.7, 1]}
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
          <CircleButton icon="chevron-back" onPress={() => safeBack()} />
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
        {showMonthPills && (
          <Animated.View
            style={[styles.topBarPillsRow, pillsStickyStyle]}
            pointerEvents={stickyVisible ? 'auto' : 'none'}
          >
            <MonthPills
              groups={monthGroups}
              activeKey={activeMonthKey}
              onPress={handleMonthPress}
            />
          </Animated.View>
        )}
      </View>
    </View>
  );
}

function ProgramRow({
  event,
  venueImageUrl,
}: {
  event: ApiVenueProgramItem;
  venueImageUrl: string | null;
}) {
  const locale = useLocale();
  const d = new Date(event.startsAt);
  const dow = dowMixed(d.getDay(), locale);
  const num = String(d.getDate()).padStart(2, '0');
  const month = monthShort(d.getMonth(), locale).toLowerCase();
  const allDay = isAllDayRange(event.startsAt, event.endsAt);
  // Jaar alleen tonen als het event in een ander jaar valt dan vandaag.
  const currentYear = new Date().getFullYear();
  const yearSuffix = d.getFullYear() !== currentYear ? ` ${d.getFullYear()}` : '';
  const friends = event.friendsSaved?.map((f) => ({
    name: f.name,
    avatar: f.avatarUrl,
  }));
  return (
    <EventListRow
      time={
        allDay
          ? formatTimeRange(event.startsAt, event.endsAt, locale)
          : formatTime(event.startsAt)
      }
      duration={
        allDay
          ? `${formatDateRange(event.startsAt, event.endsAt, locale)}${yearSuffix}`
          : `${dow} ${num} ${month}${yearSuffix}`
      }
      thumb={event.imageUrl ?? venueImageUrl ?? ''}
      thumbSize={96}
      title={event.title}
      venue=""
      tags={[
        {
          label: translateCategory(event.category, locale),
          tone: CATEGORY_TICK[event.category],
        },
      ]}
      seriesLabel={event.series?.[0]?.name}
      genreLabel={event.genres?.[0]}
      friends={friends && friends.length > 0 ? friends : undefined}
      featured={event.featured}
      tick={CATEGORY_TICK[event.category]}
      dateAbove
      onPress={() => {
        // Eerstvolgende occurrence AT THIS VENUE meegeven zodat event-
        // detail bij multi-venue films (Anora draait ook in andere
        // bioscopen) de juiste voorstelling selecteert. Zonder `o=`
        // valt 't terug op de globale next, die bij een ander venue
        // kan zitten — dan zie je bij /v/eye-filmmuseum klikken op
        // Amadeus opeens Theater de Omval's volgende vertoning.
        const occId = event.occurrencesInRange?.[0]?.id;
        const qs = occId
          ? `?source=venue&o=${encodeURIComponent(occId)}`
          : `?source=venue`;
        router.push(`/event/${event.id}${qs}`);
      }}
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
      ? 'bookmark'
      : state === 'blokken'
        ? 'ban-outline'
        : 'bookmark-outline';
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
  const t = useT();

  const options: {
    state: VenueFollowState;
    title: string;
    sub: string;
    icon: keyof typeof Ionicons.glyphMap;
  }[] = [
    {
      state: 'volgen',
      title: t('Volgen', 'Follow'),
      sub: t(
        'Events van deze venue komen prominent in je feed.',
        'Events from this venue appear prominently in your feed.'
      ),
      icon: 'bookmark',
    },
    {
      state: 'normaal',
      title: t('Niet volgen', 'Don’t follow'),
      sub: t(
        'Standaard. Events worden gewoon getoond, geen voorkeur.',
        'Default. Events show as usual, no preference.'
      ),
      icon: 'bookmark-outline',
    },
    {
      state: 'blokken',
      title: t('Blokkeren', 'Block'),
      sub: t(
        'Events van deze venue verschijnen nergens meer in de app.',
        'Events from this venue won’t appear anywhere in the app.'
      ),
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
          {t('Hoe wil je deze venue zien?', 'How do you want to see this venue?')}
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
  children?: string;
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
          <CircleButton icon="chevron-back" onPress={() => safeBack()} />
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
        {tone === 'error' && (
          <Pressable
            onPress={() => safeBack()}
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

type MonthGroup = {
  key: string; // e.g. '2026-04'
  label: string; // 'apr' of 'apr 2027' wanneer jaar afwijkt van vandaag
  monthIdx: number; // 0-11 — voor tone-kleur cycling
  events: ApiVenueProgramItem[];
};

function groupEventsByMonth(
  events: ApiVenueProgramItem[],
  locale: Locale
): MonthGroup[] {
  const currentYear = new Date().getFullYear();
  const groups = new Map<string, MonthGroup>();
  for (const e of events) {
    const d = new Date(e.startsAt);
    const y = d.getFullYear();
    const m = d.getMonth();
    const key = `${y}-${String(m).padStart(2, '0')}`;
    if (!groups.has(key)) {
      const monthLbl = monthShort(m, locale).toLowerCase();
      const label = y !== currentYear ? `${monthLbl} ${y}` : monthLbl;
      groups.set(key, { key, label, monthIdx: m, events: [] });
    }
    groups.get(key)!.events.push(e);
  }
  return Array.from(groups.values());
}

// Cycle van vier brand-accenten (acid/flare/plum/azure) per maand —
// als je verticaal door het programma scrolt zie je het kleurtje van
// de actieve pill langs de palette springen. Stabiel per maand, zodat
// "april" altijd dezelfde kleur heeft.
function toneForMonth(monthIdx: number, isNacht: boolean): string {
  const tones = isNacht
    ? [palette.acid, palette.flare, palette.plum, palette.azure]
    : [palette.red, palette.forest, palette.cobalt, '#0f6e8c'];
  return tones[monthIdx % 4];
}

// Mengt hex-kleur met wit voor leesbaarheid op donkere bg in nacht-mode.
function lightenHex(hex: string, amount: number): string {
  const h = hex.replace('#', '');
  if (h.length !== 6) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const blend = (c: number) =>
    Math.round(c + (255 - c) * amount).toString(16).padStart(2, '0');
  return `#${blend(r)}${blend(g)}${blend(b)}`;
}

/**
 * Horizontale scroll-to maand-pill bar. Eén component dient zowel de
 * inline plek (boven de eerste maand-sectie) als de duplicaat in de
 * sticky topBar. Auto-scrollt naar de actieve pill zodat 'ie zichtbaar
 * blijft tijdens verticaal scrollen.
 */
function MonthPills({
  groups,
  activeKey,
  onPress,
}: {
  groups: MonthGroup[];
  activeKey: string | null;
  onPress: (key: string) => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const scrollRef = useRef<ScrollView>(null);
  const xsRef = useRef<Record<string, number>>({});
  useEffect(() => {
    if (!activeKey) return;
    const x = xsRef.current[activeKey];
    if (x !== undefined) {
      scrollRef.current?.scrollTo({
        x: Math.max(0, x - 60),
        animated: true,
      });
    }
  }, [activeKey]);
  return (
    <ScrollView
      ref={scrollRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.pillBarContent}
      style={styles.pillBar}
    >
      {groups.map((g) => {
        const active = g.key === activeKey;
        const tone = toneForMonth(g.monthIdx, isNacht);
        const labelColor = active
          ? isNacht
            ? lightenHex(tone, 0.35)
            : tone
          : roles.fgMuted;
        const bg = active ? `${tone}26` : roles.bgTag;
        return (
          <Pressable
            key={g.key}
            onPress={() => onPress(g.key)}
            onLayout={(e: LayoutChangeEvent) => {
              xsRef.current[g.key] = e.nativeEvent.layout.x;
            }}
            style={[styles.monthPill, { backgroundColor: bg }]}
          >
            <Text style={[styles.monthPillText, { color: labelColor }]}>
              {g.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function openWebsite(url: string) {
  const finalUrl = url.startsWith('http') ? url : `https://${url}`;
  Haptics.selectionAsync();
  Linking.openURL(finalUrl).catch(() => {
    /* niet-openbare URL of geen browser */
  });
}

function openInstagram(handle: string) {
  const clean = handle.replace(/^@+/, '');
  Haptics.selectionAsync();
  // Probeer eerst de Instagram-app via deeplink; fall back op web.
  const app = `instagram://user?username=${encodeURIComponent(clean)}`;
  const web = `https://www.instagram.com/${encodeURIComponent(clean)}`;
  Linking.openURL(app).catch(() => {
    Linking.openURL(web).catch(() => {
      /* geen Instagram + geen browser */
    });
  });
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingTop: 12,
    paddingBottom: 14,
    borderTopWidth: 1,
    borderBottomWidth: 1,
  },
  addrText: { flex: 1, minWidth: 0 },
  addrLine: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.21,
    lineHeight: 20,
  },
  addrActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  addrMapBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },

  desc: {
    fontFamily: fontFamily.body,
    fontSize: 14.5,
    lineHeight: 20.8,
    marginTop: 4,
  },

  // Meta-pills (type / dayNight / wijk) boven het adres. Hoofd-tag
  // (type) krijgt tone-tinted bg, dayNight + wijk gebruiken bgChip
  // — zelfde lettertype overal voor visuele consistentie met de
  // sub-labels eronder.
  metaPills: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 6,
  },
  metaPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  metaPillText: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  },

  // Subtype-tags onder beschrijving — neutraal, zelfde shape als
  // metaPill maar met `bgChip` background.
  subtypeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 4,
  },
  subtypeTag: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  subtypeTagText: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  },

  // Series-pills — full-width tappable rij naar de serie-pagina,
  // zelfde stijl als de seriesPill op event-detail.
  seriesPillStack: {
    gap: 8,
    paddingHorizontal: 22,
    paddingBottom: 10,
  },
  seriesPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderRadius: 8,
    borderWidth: 1,
  },
  seriesPillName: {
    flex: 1,
    fontFamily: fontFamily.medium,
    fontSize: 14.5,
    letterSpacing: -0.07,
  },
  seriesChev: { fontFamily: fontFamily.mono, fontSize: 14 },

  // Wrapper rond de hele programma-sectie zodat de hero-foto er niet
  // doorheen blijft schijnen wanneer je voorbij de body scrollt.
  progSection: {
    paddingBottom: 16,
  },

  // Programma header — display-stijl, zelfde als sub-koppen op event-detail.
  progHead: {
    paddingHorizontal: 22,
    paddingTop: 18,
    paddingBottom: 10,
  },
  progLabel: {
    fontFamily: fontFamily.display,
    fontSize: 18,
    lineHeight: 18,
    letterSpacing: -0.36,
  },
  progEmpty: {
    fontFamily: fontFamily.body,
    fontSize: 14.5,
    lineHeight: 20.8,
    paddingHorizontal: 22,
    paddingVertical: 12,
  },

  // Maand-pills boven het programma + sticky duplicaat in de topBar.
  // Horizontale scroller met scroll-to navigatie. Actieve pill heeft
  // een geïnverteerde fg/bg (donker op licht); inactieve gebruikt de
  // bgChip-tint zodat 'ie subtiel los staat van de venue-bg.
  pillBar: {
    flexGrow: 0,
  },
  pillBarContent: {
    paddingHorizontal: 22,
    paddingVertical: 6,
    gap: 6,
    alignItems: 'center',
  },
  monthPill: {
    height: 30,
    paddingHorizontal: 14,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monthPillText: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 1.0,
    textTransform: 'uppercase',
  },
  // Maand-divider boven elke maand-sectie in de programma-lijst.
  // Klein, mono uppercase, dempt — geeft visuele hint zonder met de
  // event-rijen om aandacht te concurreren.
  monthHeader: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    paddingHorizontal: 22,
    paddingTop: 18,
    paddingBottom: 8,
  },
  // Tweede rij in de sticky topBar onder de venue-titel; alleen
  // zichtbaar wanneer er meerdere maanden zijn én de page voorbij de
  // hero is gescrold (via stickyStyle + pointerEvents).
  topBarPillsRow: {
    height: PILL_BAR_HEIGHT,
    justifyContent: 'center',
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
