import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useScrollToTop } from '@react-navigation/native';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  SectionList,
  type SectionListData,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { Cross } from '@/components/Cross';
import { RefreshBanner } from '@/components/RefreshBanner';
import { SpinningCross } from '@/components/SpinningCross';
import type {
  ApiVenueListItem,
  VenueDayNight,
  VenueScene,
  VenueType,
} from '@/lib/api';
import {
  getVenueTypeChips,
  monthShort,
  translateVenueScene,
  translateVenueType,
  VENUE_TYPE_TICK,
  VENUE_TYPE_VALUES,
} from '@/lib/eventDisplay';
import { softTap, tinyTap } from '@/lib/haptics';
import { useLocale, useT, type Locale } from '@/lib/i18n';
import { useVenues, useVenueSubtypes } from '@/lib/queries';
import { useTabDoubleTap } from '@/lib/useTabDoubleTap';
import { useMode, useRoles } from '@/store/mode';
import { useResetFiltersOnTabBlur } from '@/lib/useResetFiltersOnTabBlur';
import { useVenuesFilters } from '@/store/venuesFilters';
import {
  isSavedVenueSearchActive,
  type SavedVenueSearch,
  useAddSavedVenueSearch,
  useRemoveSavedVenueSearch,
  useSavedVenueSearches,
} from '@/store/savedVenueSearches';
import { fontFamily, palette } from '@/theme/tokens';

// Filter-opties voor de unified filter-sheet. Geordend zodat de meest
// gebruikte chips bovenaan staan binnen elke sectie. Labels worden
// per locale opgehaald via getDaynightChips/Type/Scene.
const DN_VALUES: VenueDayNight[] = ['day', 'night', 'both'];
const SCENE_VALUES: VenueScene[] = [
  'mainstream',
  'alternatief',
  'underground',
  'fringe',
];

function getDaynightChips(
  locale: Locale
): { value: VenueDayNight; label: string }[] {
  if (locale === 'nl') {
    return [
      { value: 'day', label: 'Dag' },
      { value: 'night', label: 'Nacht' },
      { value: 'both', label: 'Beide' },
    ];
  }
  return [
    { value: 'day', label: 'Day' },
    { value: 'night', label: 'Night' },
    { value: 'both', label: 'Both' },
  ];
}

function getSceneChips(
  locale: Locale
): { value: VenueScene; label: string }[] {
  if (locale === 'nl') {
    return [
      { value: 'mainstream', label: 'Mainstream' },
      { value: 'alternatief', label: 'Alternatief' },
      { value: 'underground', label: 'Underground' },
      { value: 'fringe', label: 'Fringe' },
    ];
  }
  return [
    { value: 'mainstream', label: 'Mainstream' },
    { value: 'alternatief', label: 'Alternative' },
    { value: 'underground', label: 'Underground' },
    { value: 'fringe', label: 'Fringe' },
  ];
}

// Tone-mapping voor mode-aware kleuren — zelfde shape als de TONE-map
// in EventListRow zodat venue-types en event-categorieën dezelfde
// brand-palette delen.
const TONE: Record<
  'nacht' | 'dag',
  Record<'acid' | 'flare' | 'plum' | 'azure' | 'saffron', string>
> = {
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
};

const CHIPROW_HEIGHT = 60;

/**
 * Venues-tab — bladerbare lijst van alle venues met categorie-chips
 * en zoekveld. URL-synced via `?cat=` en `?q=` zodat deeplinks (bv.
 * filter-tap elders) direct landen op de juiste view.
 */
export default function Venues() {
  const mode = useMode();
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const isNacht = mode === 'nacht';
  const tx = useT();
  const scrollRef = useRef<
    SectionList<ApiVenueListItem, { type: VenueType | null; items: ApiVenueListItem[] }>
  >(null);
  useScrollToTop(scrollRef);

  // Filter-state komt nu uit de persistente Zustand-store ipv URL-params
  // — zo blijven keuzes actief bij tab-wissels en app-restart.
  const q = useVenuesFilters((s) => s.query);
  const setQ = useVenuesFilters((s) => s.setQuery);
  const activeDn = useVenuesFilters((s) => s.activeDn);
  const activeType = useVenuesFilters((s) => s.activeType);
  const activeScene = useVenuesFilters((s) => s.activeScene);
  const activeSubtypes = useVenuesFilters((s) => s.activeSubtypes);
  const onlyVolgend = useVenuesFilters((s) => s.onlyVolgend);
  const setActiveDn = useVenuesFilters((s) => s.setActiveDn);
  const setActiveType = useVenuesFilters((s) => s.setActiveType);
  const setActiveScene = useVenuesFilters((s) => s.setActiveScene);
  const setActiveSubtypes = useVenuesFilters((s) => s.setActiveSubtypes);
  const setOnlyVolgend = useVenuesFilters((s) => s.setOnlyVolgend);
  const resetFilters = useVenuesFilters((s) => s.reset);

  // Stack-persistent filter-state: reset bij tab-wissel, behoud bij
  // tap op een venue → terug. markPush wordt aangeroepen vóór elke
  // navigatie naar de venue-detail.
  const markPush = useResetFiltersOnTabBlur(resetFilters);
  const onVenueTap = useCallback(
    (slug: string) => {
      markPush();
      router.push(`/venue/${slug}` as never);
    },
    [markPush]
  );

  const [debouncedQ, setDebouncedQ] = useState(q.trim());
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);

  // Server-side filter alleen op de zoekterm — alle andere filters
  // gebeuren clientside, want de venue-lijst is klein (< 200 items)
  // en multi-select past niet in de huidige API-shape.
  const { data: venuesAll, isLoading } = useVenues({ q: debouncedQ });
  const venues = useMemo(() => {
    if (!venuesAll) return [];
    return venuesAll.filter((v) => {
      if (onlyVolgend && v.myFollowState !== 'volgen') return false;
      if (activeDn.length > 0) {
        if (!v.dayNight || !activeDn.includes(v.dayNight)) return false;
      }
      if (activeType.length > 0) {
        if (!v.type || !activeType.includes(v.type)) return false;
      }
      if (activeScene.length > 0) {
        if (!v.scene || !activeScene.includes(v.scene)) return false;
      }
      if (activeSubtypes.length > 0) {
        // Array-overlap: venue moet minstens één van de gekozen
        // subtypes hebben.
        const vs = v.subtype ?? [];
        if (!vs.some((s) => activeSubtypes.includes(s))) return false;
      }
      return true;
    });
  }, [venuesAll, onlyVolgend, activeDn, activeType, activeScene, activeSubtypes]);

  // Toon de Volgen-quick-toggle in de chip-row alleen als de gebruiker
  // ook daadwerkelijk venues volgt — anders heeft 'ie geen functie.
  const showVolgendChip = useMemo(
    () => Boolean(venuesAll?.some((v) => v.myFollowState === 'volgen')),
    [venuesAll]
  );

  // Groepeer per venue-type — volgorde van VENUE_TYPE_VALUES (podium,
  // club, galerie, museum, film, ruimte, boekhandel-cafe), binnen elke
  // groep alfabetisch. Venues zonder type komen onderaan in een aparte
  // "Overig"-sectie zodat ze niet stilletjes verdwijnen.
  const groupedVenues = useMemo(() => {
    const buckets = new Map<VenueType | '__none__', ApiVenueListItem[]>();
    for (const v of venues) {
      const key = v.type ?? '__none__';
      const arr = buckets.get(key) ?? [];
      arr.push(v);
      buckets.set(key, arr);
    }
    for (const arr of buckets.values()) {
      arr.sort((a, b) => a.name.localeCompare(b.name));
    }
    const ordered: { type: VenueType | null; items: ApiVenueListItem[] }[] = [];
    for (const t of VENUE_TYPE_VALUES) {
      const items = buckets.get(t);
      if (items && items.length > 0) ordered.push({ type: t, items });
    }
    const orphan = buckets.get('__none__');
    if (orphan && orphan.length > 0) ordered.push({ type: null, items: orphan });
    return ordered;
  }, [venues]);

  // Pull-to-refresh: invalideert venues + series. 700ms minimum
  // zichtbaarheid voor de banner.
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    const start = Date.now();
    try {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['venues'] }),
        qc.invalidateQueries({ queryKey: ['series'] }),
      ]);
    } finally {
      const elapsed = Date.now() - start;
      if (elapsed < 700) {
        await new Promise((r) => setTimeout(r, 700 - elapsed));
      }
      setRefreshing(false);
    }
  }, [qc]);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.root, { backgroundColor: roles.bg }]}
    >
      <RefreshBanner
        visible={refreshing}
        topOffset={insets.top + HEADER_HEIGHT + 8}
      />
      <SectionList
        ref={scrollRef}
        sections={
          isLoading
            ? []
            : groupedVenues.map((g) => ({ ...g, data: g.items }))
        }
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <VenueRow venue={item} onTap={onVenueTap} />}
        renderSectionHeader={({ section }) => {
          const s = section as SectionListData<
            ApiVenueListItem,
            { type: VenueType | null; items: ApiVenueListItem[] }
          >;
          return <VenueGroupTitle type={s.type} count={s.items.length} />;
        }}
        stickySectionHeadersEnabled={false}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: insets.top + HEADER_HEIGHT + CHIPROW_HEIGHT,
          paddingBottom: insets.bottom + 96,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={roles.accent}
            colors={[roles.accent]}
            progressViewOffset={insets.top + HEADER_HEIGHT + CHIPROW_HEIGHT}
          />
        }
        windowSize={11}
        initialNumToRender={12}
        removeClippedSubviews
        ListHeaderComponent={
          isLoading ? (
            <View style={styles.loadingWrap}>
              <SpinningCross size={28} color={roles.fgPlaceholder} />
            </View>
          ) : null
        }
        ListEmptyComponent={
          isLoading ? null : (
            <Animated.View entering={FadeIn.duration(220)}>
              <Text style={[styles.hint, { color: roles.fgMuted }]}>
                {debouncedQ.length > 0
                  ? tx(
                      `Geen venue gevonden voor "${debouncedQ}".`,
                      `No venue found for "${debouncedQ}".`
                    )
                  : onlyVolgend
                    ? tx(
                        'Je volgt nog geen venues.',
                        'You don’t follow any venues yet.'
                      )
                    : activeDn.length +
                          activeType.length +
                          activeScene.length +
                          activeSubtypes.length >
                        0
                      ? tx(
                          'Geen venues voor deze filter.',
                          'No venues for this filter.'
                        )
                      : tx('Geen venues om te tonen.', 'No venues to show.')}
              </Text>
            </Animated.View>
          )
        }
      />
      <AppHeader title={tx('Venues', 'Venues')}>
        <ChipRow
          query={q}
          onQuery={setQ}
          activeDn={activeDn}
          activeType={activeType}
          activeScene={activeScene}
          activeSubtypes={activeSubtypes}
          onlyVolgend={onlyVolgend}
          showVolgendChip={showVolgendChip}
          onDn={setActiveDn}
          onType={setActiveType}
          onScene={setActiveScene}
          onSubtypes={setActiveSubtypes}
          onVolgend={setOnlyVolgend}
        />
      </AppHeader>
    </KeyboardAvoidingView>
  );
}

/**
 * Sectie-titel bij elke venue-type-groep — kleur volgt VENUE_TYPE_TICK
 * (acid voor podium, flare voor club, ...) zodat je in één oogopslag
 * ziet welk type onder welke kleur valt. Zelfde tone-mapping als de
 * pills op de Vandaag/Agenda-rijen, dus visueel coherent. Voor venues
 * zonder type-veld val je terug op een neutrale "Overig"-titel.
 */
function VenueGroupTitle({
  type,
  count,
}: {
  type: VenueType | null;
  count: number;
}) {
  const mode = useMode();
  const roles = useRoles();
  const locale = useLocale();
  const t = useT();
  const titleColor =
    type !== null ? TONE[mode][VENUE_TYPE_TICK[type]] : roles.fg;
  const label = type !== null ? translateVenueType(type, locale) : t('Overig', 'Other');
  const meta = `${count} ${count === 1 ? t('venue', 'venue') : t('venues', 'venues')}`;
  return (
    <View style={styles.groupTitle}>
      <Text style={[styles.groupTitleLabel, { color: titleColor }]}>
        {label}
      </Text>
      <Text style={[styles.groupTitleMeta, { color: roles.fgMuted }]}>
        {meta}
      </Text>
    </View>
  );
}

function VenueRow({
  venue,
  onTap,
}: {
  venue: ApiVenueListItem;
  onTap: (slug: string) => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const locale = useLocale();
  const typeChips = useMemo(() => getVenueTypeChips(locale), [locale]);
  const sceneChips = useMemo(() => getSceneChips(locale), [locale]);
  return (
    <Pressable
      onPress={() => onTap(venue.slug)}
      style={[styles.row, { borderColor: roles.bgChip }]}
    >
      {venue.imageUrl ? (
        <Image
          source={{ uri: venue.imageUrl }}
          style={styles.thumb}
          contentFit="cover"
        />
      ) : (
        <View
          style={[
            styles.thumb,
            { backgroundColor: isNacht ? palette.noir2 : palette.paper2 },
          ]}
        />
      )}
      <View style={styles.body}>
        <Text numberOfLines={1} style={[styles.name, { color: roles.fg }]}>
          {venue.name}
        </Text>
        <Text
          numberOfLines={1}
          style={[styles.address, { color: roles.fgMuted }]}
        >
          {venue.address}
        </Text>
        {(venue.type || venue.scene || (venue.subtype ?? []).length > 0) && (
          <View style={styles.tags}>
            {venue.type && (() => {
              const tone = TONE[mode][VENUE_TYPE_TICK[venue.type]];
              return (
                <View
                  style={[styles.tag, { backgroundColor: `${tone}26` }]}
                >
                  <Text
                    style={[styles.tagText, { color: toneText(tone, mode) }]}
                  >
                    {typeChips.find((c) => c.value === venue.type)?.label ??
                      venue.type}
                  </Text>
                </View>
              );
            })()}
            {venue.scene && (
              <View
                style={[styles.subtypeTag, { backgroundColor: roles.bgTag }]}
              >
                <Text style={[styles.subtypeTagText, { color: roles.fg }]}>
                  {sceneChips.find((c) => c.value === venue.scene)?.label ??
                    venue.scene}
                </Text>
              </View>
            )}
            {(venue.subtype ?? []).slice(0, 2).map((s) => (
              <View
                key={s}
                style={[styles.subtypeTag, { backgroundColor: roles.bgTag }]}
              >
                <Text style={[styles.subtypeTagText, { color: roles.fg }]}>
                  {s}
                </Text>
              </View>
            ))}
          </View>
        )}
      </View>
      <FollowBadge state={venue.myFollowState} />
    </Pressable>
  );
}

function FollowBadge({
  state,
}: {
  state: ApiVenueListItem['myFollowState'];
}) {
  const mode = useMode();
  const roles = useRoles();
  if (state === 'normaal') return null;
  const isVolgen = state === 'volgen';
  const tone = isVolgen
    ? mode === 'nacht'
      ? palette.acid
      : palette.red
    : roles.fgPlaceholder;
  return (
    <View style={[styles.followBadge, { borderColor: `${tone}80` }]}>
      <Ionicons
        name={isVolgen ? 'heart' : 'ban-outline'}
        size={12}
        color={tone}
      />
    </View>
  );
}

function ChipRow({
  query,
  onQuery,
  activeDn,
  activeType,
  activeScene,
  activeSubtypes,
  onlyVolgend,
  showVolgendChip,
  onDn,
  onType,
  onScene,
  onSubtypes,
  onVolgend,
}: {
  query: string;
  onQuery: (q: string) => void;
  activeDn: VenueDayNight[];
  activeType: VenueType[];
  activeScene: VenueScene[];
  activeSubtypes: string[];
  onlyVolgend: boolean;
  showVolgendChip: boolean;
  onDn: (next: VenueDayNight[]) => void;
  onType: (next: VenueType[]) => void;
  onScene: (next: VenueScene[]) => void;
  onSubtypes: (next: string[]) => void;
  onVolgend: (next: boolean) => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const t = useT();
  const locale = useLocale();
  const [focused, setFocused] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const saved = useSavedVenueSearches();
  const removeSaved = useRemoveSavedVenueSearch();
  // Dubbele tap op de Venues-tab = zoekveld leegmaken + focussen.
  useTabDoubleTap(() => {
    onQuery('');
    inputRef.current?.focus();
  });
  // Blur bij scherm-blur zodat het keyboard niet open blijft staan
  // wanneer je naar een andere tab of detail-pagina wisselt.
  useFocusEffect(
    useCallback(() => {
      return () => inputRef.current?.blur();
    }, [])
  );

  const open = focused || query.length > 0;
  const COLLAPSED_W = 44;
  const MIN_OPEN_W = 130;
  const MAX_OPEN_W = 260;
  const textWidthEstimate = 44 + query.length * 8 + 18;
  const width = !open
    ? COLLAPSED_W
    : Math.min(MAX_OPEN_W, Math.max(MIN_OPEN_W, textWidthEstimate));

  const onIconPress = () => {
    if (open) {
      onQuery('');
      inputRef.current?.blur();
    } else {
      inputRef.current?.focus();
    }
  };

  // Volgen-toggle telt niet mee in de filter-count omdat 'ie nu een
  // quick-chip is buiten het filter-sheet (zelfde patroon als Vrienden/
  // Favorieten op Vandaag/Agenda — die badge geeft alleen sheet-filters
  // weer).
  const filterCount =
    activeDn.length +
    activeType.length +
    activeScene.length +
    activeSubtypes.length;
  const filterActive = filterCount > 0;
  // Eerste belangrijke filter als label: venue-type > scene >
  // subtype. Render: "Podium + 1" voor primair + extra; geen
  // primair? terug naar "Filter · N".
  const filterLabel = filterActive
    ? (() => {
        let primary: string | null = null;
        if (activeType.length > 0) {
          primary = translateVenueType(activeType[0], locale);
        } else if (activeScene.length > 0) {
          primary = translateVenueScene(activeScene[0], locale);
        } else if (activeSubtypes.length > 0) {
          primary = activeSubtypes[0];
        }
        if (primary === null) return `${t('Filter', 'Filter')} · ${filterCount}`;
        const others = filterCount - 1;
        return others > 0 ? `${primary} + ${others}` : primary;
      })()
    : t('Filter', 'Filter');

  const current = {
    dn: activeDn,
    type: activeType,
    sc: activeScene,
    st: activeSubtypes,
    vo: onlyVolgend,
    q: query,
  };

  const applySaved = (s: SavedVenueSearch) => {
    const active = isSavedVenueSearchActive(s, current);
    if (active) {
      onDn([]);
      onType([]);
      onScene([]);
      onSubtypes([]);
      onVolgend(false);
      onQuery('');
      return;
    }
    onDn(s.dn);
    onType(s.type);
    onScene(s.sc);
    onSubtypes(s.st ?? []);
    onVolgend(s.vo);
    onQuery(s.q);
  };

  const onLongPressSaved = (s: SavedVenueSearch) => {
    Alert.alert(
      t('Verwijderen', 'Remove'),
      t(
        `"${s.name}" verwijderen uit je opgeslagen filters?`,
        `Remove "${s.name}" from your saved filters?`
      ),
      [
        { text: t('Annuleren', 'Cancel'), style: 'cancel' },
        {
          text: t('Verwijder', 'Remove'),
          style: 'destructive',
          onPress: () => removeSaved(s.id),
        },
      ]
    );
  };

  return (
    <>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipRow}
        keyboardShouldPersistTaps="handled"
      >
        <View
          style={[
            styles.searchChip,
            {
              backgroundColor: isNacht ? palette.noir2 : palette.paper2,
              borderColor: isNacht ? '#2a2a2d' : palette.paper,
              width,
              paddingHorizontal: open ? 14 : 0,
              gap: open ? 8 : 0,
              justifyContent: open ? 'flex-start' : 'center',
            },
          ]}
        >
          <Pressable onPress={onIconPress} hitSlop={6} style={styles.searchIcon}>
            <Ionicons
              name={open ? 'close' : 'search'}
              size={18}
              color={roles.fgMuted}
            />
          </Pressable>
          <TextInput
            ref={inputRef}
            value={query}
            onChangeText={onQuery}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={open ? t('ZOEK', 'SEARCH') : ''}
            placeholderTextColor={roles.fgPlaceholder}
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="search"
            style={[
              styles.searchInput,
              {
                color: roles.fg,
                flex: open ? 1 : 0,
                width: open ? undefined : 0,
              },
            ]}
          />
        </View>
        <Pressable
          onPress={() => {
            softTap();
            setFilterOpen(true);
          }}
          style={[
            styles.catChip,
            {
              borderColor: filterActive
                ? roles.fg
                : isNacht
                  ? '#2a2a2d'
                  : palette.paper,
              backgroundColor: filterActive
                ? roles.fg
                : isNacht
                  ? palette.noir2
                  : palette.paper2,
              flexDirection: 'row',
              gap: 4,
            },
          ]}
        >
          <Ionicons
            name="options-outline"
            size={12}
            color={filterActive ? roles.bg : roles.fgMuted}
          />
          <Text
            style={[
              styles.catChipText,
              { color: filterActive ? roles.bg : roles.fgMuted },
            ]}
          >
            {filterLabel}
          </Text>
        </Pressable>
        {showVolgendChip && (
          <Pressable
            accessibilityLabel={
              onlyVolgend
                ? t('Toon alle venues', 'Show all venues')
                : t(
                    'Alleen venues die ik volg',
                    'Only venues I follow'
                  )
            }
            onPress={() => onVolgend(!onlyVolgend)}
            style={[
              styles.volgendToggle,
              {
                borderColor: onlyVolgend
                  ? roles.fg
                  : isNacht
                    ? '#2a2a2d'
                    : palette.paper,
                backgroundColor: onlyVolgend
                  ? roles.fg
                  : isNacht
                    ? palette.noir2
                    : palette.paper2,
              },
            ]}
          >
            <Ionicons
              name={onlyVolgend ? 'heart' : 'heart-outline'}
              size={14}
              color={onlyVolgend ? roles.bg : roles.fgMuted}
            />
          </Pressable>
        )}
        {saved.map((s) => {
          const active = isSavedVenueSearchActive(s, current);
          return (
            <Pressable
              key={s.id}
              onPress={() => {
                tinyTap();
                applySaved(s);
              }}
              onLongPress={() => onLongPressSaved(s)}
              delayLongPress={400}
              style={[
                styles.catChip,
                {
                  borderColor: active
                    ? roles.accent
                    : isNacht
                      ? '#2a2a2d'
                      : palette.paper,
                  backgroundColor: active
                    ? `${isNacht ? palette.acid : palette.red}1f`
                    : isNacht
                      ? palette.noir2
                      : palette.paper2,
                  flexDirection: 'row',
                  gap: 4,
                },
              ]}
            >
              <Ionicons
                name="bookmark"
                size={11}
                color={active ? roles.accent : roles.fgMuted}
              />
              <Text
                style={[
                  styles.catChipText,
                  { color: active ? roles.accent : roles.fgMuted },
                ]}
              >
                {s.name}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <Modal
        visible={filterOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setFilterOpen(false)}
      >
        <FilterSheet
          activeDn={activeDn}
          activeType={activeType}
          activeScene={activeScene}
          activeSubtypes={activeSubtypes}
          onlyVolgend={onlyVolgend}
          query={query}
          onDn={onDn}
          onType={onType}
          onScene={onScene}
          onSubtypes={onSubtypes}
          onVolgend={onVolgend}
          onClose={() => setFilterOpen(false)}
        />
      </Modal>
    </>
  );
}

function FilterSheet({
  activeDn,
  activeType,
  activeScene,
  activeSubtypes,
  onlyVolgend,
  query,
  onDn,
  onType,
  onScene,
  onSubtypes,
  onVolgend,
  onClose,
}: {
  activeDn: VenueDayNight[];
  activeType: VenueType[];
  activeScene: VenueScene[];
  activeSubtypes: string[];
  onlyVolgend: boolean;
  query: string;
  onDn: (next: VenueDayNight[]) => void;
  onType: (next: VenueType[]) => void;
  onScene: (next: VenueScene[]) => void;
  onSubtypes: (next: string[]) => void;
  onVolgend: (next: boolean) => void;
  onClose: () => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const t = useT();
  const locale = useLocale();
  const daynightChips = useMemo(() => getDaynightChips(locale), [locale]);
  const typeChips = useMemo(() => getVenueTypeChips(locale), [locale]);
  const sceneChips = useMemo(() => getSceneChips(locale), [locale]);
  const addSaved = useAddSavedVenueSearch();
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');

  // Subtypes scope-bound op de gekozen types — als er niets gekozen
  // is komen alle subtypes per type terug; we groeperen straks per type
  // in de UI zodat "techno" onder Club niet wordt gemerged met "techno"
  // onder Podium.
  const {
    data: subtypeData,
    isLoading: subtypesLoading,
    error: subtypesError,
  } = useVenueSubtypes(activeType.length > 0 ? activeType : undefined);

  const groupedSubtypes = useMemo(() => {
    if (!subtypeData) return [] as Array<{
      type: VenueType;
      items: { subtype: string; count: number }[];
    }>;
    const map = new Map<VenueType, { subtype: string; count: number }[]>();
    for (const b of subtypeData) {
      if (!b.type) continue;
      const arr = map.get(b.type) ?? [];
      arr.push({ subtype: b.subtype, count: b.count });
      map.set(b.type, arr);
    }
    // Stabiele volgorde: zelfde als TYPE_CHIPS zodat Podium boven Club
    // staat en niet random alfabetisch op enum-naam.
    return VENUE_TYPE_VALUES.flatMap((value) => {
      const items = map.get(value);
      return items && items.length > 0 ? [{ type: value, items }] : [];
    });
  }, [subtypeData]);

  const toggleDn = (v: VenueDayNight) => {
    if (activeDn.includes(v)) onDn(activeDn.filter((x) => x !== v));
    else onDn([...activeDn, v]);
  };
  const toggleType = (v: VenueType) => {
    if (activeType.includes(v)) {
      onType(activeType.filter((x) => x !== v));
      // Subtypes die alleen onder dit type voorkwamen: laat ze staan,
      // de filter-logica negeert ze automatisch (geen overlap meer).
      // Maar wel netjes opschonen — anders blijft Sub-types-count hangen.
      const stillReachable = (subtypeData ?? [])
        .filter((b) => b.type !== v)
        .map((b) => b.subtype);
      const reachableSet = new Set(stillReachable);
      const next = activeSubtypes.filter((s) => reachableSet.has(s));
      if (next.length !== activeSubtypes.length) onSubtypes(next);
    } else onType([...activeType, v]);
  };
  const toggleScene = (v: VenueScene) => {
    if (activeScene.includes(v)) onScene(activeScene.filter((x) => x !== v));
    else onScene([...activeScene, v]);
  };
  const toggleSubtype = (s: string) => {
    if (activeSubtypes.includes(s))
      onSubtypes(activeSubtypes.filter((x) => x !== s));
    else onSubtypes([...activeSubtypes, s]);
  };

  // Volgen-toggle telt niet mee in de sheet-filterCount (z'n quick-chip
  // staat buiten dit sheet) maar wordt wel meegereset bij "Wis alles".
  const filterCount =
    activeDn.length +
    activeType.length +
    activeScene.length +
    activeSubtypes.length;

  const onClearAll = () => {
    onDn([]);
    onType([]);
    onScene([]);
    onSubtypes([]);
    onVolgend(false);
  };

  const onSave = () => {
    const name = saveName.trim();
    if (name.length === 0) return;
    addSaved({
      name,
      dn: activeDn,
      type: activeType,
      sc: activeScene,
      st: activeSubtypes,
      vo: onlyVolgend,
      q: query,
    });
    setSaveOpen(false);
    setSaveName('');
    onClose();
  };

  return (
    <KeyboardAvoidingView
      style={[styles.sheetRoot, { backgroundColor: roles.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 60 : 0}
    >
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
      <View style={styles.sheetHead}>
        <Text style={[styles.sheetTitle, { color: roles.fg }]}>
          {t('Filter', 'Filter')}
        </Text>
        <Text style={[styles.sheetLead, { color: roles.fgMuted }]}>
          {t(
            "Combineer dag/nacht, type, sub-type, scene en volg-status. Sla 'm op om de combinatie als chip te bewaren.",
            'Combine day/night, type, sub-type, scene and follow-status. Save it to keep the combination as a chip.'
          )}
        </Text>
      </View>

      <ScrollView
        style={styles.sheetScroll}
        contentContainerStyle={styles.sheetScrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[styles.sheetSectionHead, { color: roles.fgMuted }]}>
          {t('Dag of Nacht', 'Day or Night')}
        </Text>
        <View style={styles.sheetWrap}>
          {daynightChips.map((c) => (
            <FilterChip
              key={c.value}
              label={c.label}
              active={activeDn.includes(c.value)}
              onPress={() => toggleDn(c.value)}
            />
          ))}
        </View>

        <Text
          style={[
            styles.sheetSectionHead,
            { color: roles.fgMuted, marginTop: 22 },
          ]}
        >
          {t('Type', 'Type')}
        </Text>
        <View style={styles.sheetWrap}>
          {typeChips.map((c) => (
            <FilterChip
              key={c.value}
              label={c.label}
              active={activeType.includes(c.value)}
              onPress={() => toggleType(c.value)}
            />
          ))}
        </View>

        <Text
          style={[
            styles.sheetSectionHead,
            { color: roles.fgMuted, marginTop: 22 },
          ]}
        >
          {t('Scene', 'Scene')}
        </Text>
        <View style={styles.sheetWrap}>
          {sceneChips.map((c) => (
            <FilterChip
              key={c.value}
              label={c.label}
              active={activeScene.includes(c.value)}
              onPress={() => toggleScene(c.value)}
            />
          ))}
        </View>

        {/* "Volg-status" sectie verwijderd — toggle staat in de
            chip-row buiten dit sheet. onlyVolgend + onVolgend blijven
            als FilterSheet-prop voor "Wis alles" en saved-search-
            round-trip. */}

        {/* Sub-types onderaan: het kunnen er veel zijn, dus eerst de
            korte label-secties (dag/nacht, type, scene) en dan pas
            de lange sub-type-lijst. */}
        <Text
          style={[
            styles.sheetSectionHead,
            { color: roles.fgMuted, marginTop: 22 },
          ]}
        >
          {t('Sub-types', 'Sub-types')}
        </Text>
        {subtypesLoading && (
          <View style={styles.sheetLoading}>
            <SpinningCross size={24} color={roles.fgPlaceholder} />
          </View>
        )}
        {subtypesError && (
          <Text style={[styles.sheetEmpty, { color: '#c9453a' }]}>
            {t('Kon sub-types niet laden.', 'Couldn’t load sub-types.')}
          </Text>
        )}
        {!subtypesLoading && !subtypesError && groupedSubtypes.length === 0 && (
          <Text style={[styles.sheetEmpty, { color: roles.fgMuted }]}>
            {activeType.length > 0
              ? t('Geen sub-types voor dit type.', 'No sub-types for this type.')
              : t('Nog geen sub-types ingevuld.', 'No sub-types yet.')}
          </Text>
        )}
        <View style={styles.sheetSubSectionGroup}>
          {groupedSubtypes.map((section) => (
            <View key={section.type}>
              {/* Per-type sub-heading verschijnt alleen als er meer dan
                  één type-bucket zichtbaar is — anders is impliciet
                  duidelijk welk type erbij hoort. */}
              {groupedSubtypes.length > 1 && (
                <Text
                  style={[
                    styles.sheetSubSectionHead,
                    { color: roles.fgPlaceholder },
                  ]}
                >
                  {typeChips.find((c) => c.value === section.type)?.label ??
                    section.type}
                </Text>
              )}
              <View style={styles.sheetWrap}>
                {section.items.map((b) => {
                  const checked = activeSubtypes.includes(b.subtype);
                  return (
                    <Pressable
                      key={`${section.type}-${b.subtype}`}
                      onPress={() => {
                        tinyTap();
                        toggleSubtype(b.subtype);
                      }}
                      style={[
                        styles.subtypeFilterChip,
                        {
                          borderColor: checked ? roles.fg : roles.bgChip,
                          backgroundColor: checked
                            ? roles.fg
                            : isNacht
                              ? palette.noir2
                              : palette.paper2,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.subtypeFilterChipText,
                          { color: checked ? roles.bg : roles.fg },
                        ]}
                      >
                        {b.subtype}
                      </Text>
                      <Text
                        style={[
                          styles.subtypeFilterChipCount,
                          {
                            color: checked ? roles.bg : roles.fgPlaceholder,
                          },
                        ]}
                      >
                        {b.count}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ))}
        </View>
      </ScrollView>

      {saveOpen ? (
        <View
          style={[
            styles.sheetFooter,
            { borderTopColor: roles.bgChip, paddingBottom: 16 },
          ]}
        >
          <View
            style={[
              styles.saveInputWrap,
              {
                backgroundColor: isNacht ? palette.noir2 : palette.paper2,
                borderColor: roles.bgChip,
              },
            ]}
          >
            <TextInput
              value={saveName}
              onChangeText={setSaveName}
              placeholder={t(
                'Naam (bv. Galeries Oost)',
                'Name (e.g. Galleries East)'
              )}
              placeholderTextColor={roles.fgPlaceholder}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={onSave}
              style={[styles.saveInput, { color: roles.fg }]}
              maxLength={28}
            />
          </View>
          <Pressable
            accessibilityLabel={t('Opslaan', 'Save')}
            onPress={() => {
              softTap();
              onSave();
            }}
            disabled={saveName.trim().length === 0}
            style={[
              styles.sheetIconBtn,
              {
                backgroundColor: isNacht ? palette.acid : palette.red,
                borderColor: 'transparent',
                opacity: saveName.trim().length === 0 ? 0.4 : 1,
              },
            ]}
          >
            <Ionicons
              name="checkmark"
              size={20}
              color={isNacht ? palette.noir : palette.paper3}
            />
          </Pressable>
          <Pressable
            accessibilityLabel={t('Annuleer', 'Cancel')}
            onPress={() => {
              setSaveOpen(false);
              setSaveName('');
            }}
            style={[styles.sheetIconBtn, { borderColor: roles.bgChip }]}
          >
            <Ionicons name="close" size={18} color={roles.fgMuted} />
          </Pressable>
        </View>
      ) : (
        <View
          style={[
            styles.sheetFooter,
            { borderTopColor: roles.bgChip, paddingBottom: 16 },
          ]}
        >
          <Pressable
            onPress={onClose}
            style={[
              styles.sheetDoneBtn,
              { backgroundColor: isNacht ? palette.acid : palette.red },
            ]}
          >
            <Text
              style={[
                styles.sheetDoneText,
                { color: isNacht ? palette.noir : palette.paper3 },
              ]}
            >
              {t('Bekijk', 'View')}
            </Text>
          </Pressable>
          <Pressable
            accessibilityLabel={t('Bewaar filter', 'Save filter')}
            onPress={() => {
              softTap();
              setSaveOpen(true);
            }}
            disabled={filterCount === 0}
            style={[
              styles.sheetIconBtn,
              {
                borderColor: roles.bgChip,
                opacity: filterCount === 0 ? 0.4 : 1,
              },
            ]}
          >
            <Ionicons name="bookmark-outline" size={18} color={roles.accent} />
          </Pressable>
          <Pressable
            accessibilityLabel={t('Sluit filter', 'Close filter')}
            onPress={() => {
              if (filterCount > 0) onClearAll();
              onClose();
            }}
            style={[styles.sheetIconBtn, { borderColor: roles.bgChip }]}
          >
            <Ionicons name="close" size={18} color={roles.fgMuted} />
          </Pressable>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

function FilterChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  return (
    <Pressable
      onPress={() => {
        tinyTap();
        onPress();
      }}
      style={[
        styles.filterChip,
        {
          borderColor: active ? roles.fg : roles.bgChip,
          backgroundColor: active
            ? roles.fg
            : isNacht
              ? palette.noir2
              : palette.paper2,
        },
      ]}
    >
      <Text
        style={[
          styles.filterChipText,
          { color: active ? roles.bg : roles.fg },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

// Helper: lichte mix van tone-color voor leesbare tekst-op-getinte-bg
// labels — zelfde patroon als in EventListRow.
function toneText(hex: string, mode: 'nacht' | 'dag'): string {
  if (mode === 'dag') return hex;
  const h = hex.replace('#', '');
  if (h.length !== 6) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const blend = (c: number) =>
    Math.round(c + (255 - c) * 0.35)
      .toString(16)
      .padStart(2, '0');
  return `#${blend(r)}${blend(g)}${blend(b)}`;
}

const styles = StyleSheet.create({
  root: { flex: 1 },


  hint: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.5,
    paddingHorizontal: 22,
    paddingVertical: 14,
  },

  // Sectie-titel boven elke venue-type-groep — zelfde patroon als de
  // cat-titels op Vandaag (display-font, lowercase via natuurlijke
  // labels, tone-color uit VENUE_TYPE_TICK).
  groupTitle: {
    paddingHorizontal: 22,
    paddingTop: 18,
    paddingBottom: 6,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  groupTitleLabel: {
    fontFamily: fontFamily.display,
    fontSize: 24,
  },
  groupTitleMeta: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  loadingWrap: {
    paddingVertical: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Chip-row — gespiegeld op Agenda zodat 't visueel matcht
  chipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 22,
    paddingVertical: 6,
    height: CHIPROW_HEIGHT,
  },
  searchChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 44,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    overflow: 'hidden',
  },
  searchIcon: {
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchInput: {
    flex: 1,
    fontFamily: fontFamily.mono,
    fontSize: 13,
    letterSpacing: 0.8,
    padding: 0,
    margin: 0,
    height: 24,
  },
  catChip: {
    height: 44,
    paddingHorizontal: 18,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Compact rond toggle-chipje voor "alleen wat ik volg" — zelfde
  // patroon als de friends/favorites-toggles op Vandaag/Agenda.
  volgendToggle: {
    width: 44,
    height: 44,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  catChipText: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.06,
  },

  // Row
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingHorizontal: 22,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  thumb: { width: 76, height: 76, borderRadius: 10 },
  body: { flex: 1, minWidth: 0, gap: 4 },
  name: {
    fontFamily: fontFamily.bold,
    fontSize: 15,
    letterSpacing: -0.22,
    lineHeight: 18,
  },
  address: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  tags: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 6,
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  tag: {
    height: 24,
    paddingHorizontal: 10,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tagText: {
    fontFamily: fontFamily.mono,
    fontSize: 9,
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  },
  subtypeTag: {
    height: 24,
    paddingHorizontal: 10,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  subtypeTagText: {
    fontFamily: fontFamily.mono,
    fontSize: 9,
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  },

  followBadge: {
    width: 26,
    height: 26,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },

  // Filter-sheet — zelfde design als de Agenda-sheet.
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
    top: 12,
    right: 12,
    width: 44,
    height: 44,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetHead: {
    paddingHorizontal: 22,
    paddingTop: 16,
    paddingBottom: 14,
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
  },
  sheetScroll: { flex: 1 },
  sheetScrollContent: {
    paddingHorizontal: 22,
    paddingBottom: 24,
  },
  sheetSectionHead: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  sheetWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  sheetLoading: {
    paddingVertical: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetEmpty: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.8,
    paddingVertical: 14,
    textAlign: 'center',
  },
  sheetSubSectionGroup: { gap: 12 },
  sheetSubSectionHead: {
    fontFamily: fontFamily.mono,
    fontSize: 9,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  subtypeFilterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 44,
    paddingHorizontal: 18,
    borderRadius: 999,
    borderWidth: 1,
  },
  subtypeFilterChipText: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.13,
    textTransform: 'lowercase',
  },
  subtypeFilterChipCount: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.8,
  },
  filterChip: {
    minHeight: 44,
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterChipText: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.13,
  },
  sheetFooter: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 22,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  sheetClearBtn: {
    flex: 1,
    height: 48,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Vierkant icoontje-knop voor bewaar/wis (zelfde als Agenda).
  sheetIconBtn: {
    width: 48,
    height: 48,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetClearText: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.14,
  },
  sheetDoneBtn: {
    flex: 1.4,
    height: 48,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetDoneText: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.14,
  },
  saveInputWrap: {
    flex: 1.4,
    height: 48,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 14,
    justifyContent: 'center',
  },
  saveInput: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.14,
    padding: 0,
    margin: 0,
  },
});
