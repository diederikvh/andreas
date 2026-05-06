import { Ionicons } from '@expo/vector-icons';
import { useScrollToTop } from '@react-navigation/native';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
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
  ApiSeriesListItem,
  ApiVenueListItem,
  VenueDayNight,
  VenueScene,
  VenueType,
} from '@/lib/api';
import { MONTHS_NL, VENUE_TYPE_TICK } from '@/lib/eventDisplay';
import { useSeriesList, useVenues, useVenueSubtypes } from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
import {
  isSavedVenueSearchActive,
  type SavedVenueSearch,
  useAddSavedVenueSearch,
  useRemoveSavedVenueSearch,
  useSavedVenueSearches,
} from '@/store/savedVenueSearches';
import { fontFamily, palette } from '@/theme/tokens';

// Filter-opties voor de unified filter-sheet. Geordend zodat de meest
// gebruikte chips bovenaan staan binnen elke sectie.
const DAYNIGHT_CHIPS: { value: VenueDayNight; label: string }[] = [
  { value: 'day', label: 'Dag' },
  { value: 'night', label: 'Nacht' },
  { value: 'both', label: 'Beide' },
];
const DN_VALUES: VenueDayNight[] = DAYNIGHT_CHIPS.map((c) => c.value);

const TYPE_CHIPS: { value: VenueType; label: string }[] = [
  { value: 'podium', label: 'Podium' },
  { value: 'club', label: 'Club' },
  { value: 'galerie', label: 'Galerie' },
  { value: 'museum', label: 'Museum' },
  { value: 'film', label: 'Film' },
  { value: 'ruimte', label: 'Ruimte' },
  { value: 'boekhandel-cafe', label: 'Boekhandel' },
];
const TYPE_VALUES: VenueType[] = TYPE_CHIPS.map((c) => c.value);

const SCENE_CHIPS: { value: VenueScene; label: string }[] = [
  { value: 'mainstream', label: 'Mainstream' },
  { value: 'alternatief', label: 'Alternatief' },
  { value: 'underground', label: 'Underground' },
  { value: 'fringe', label: 'Fringe' },
];
const SCENE_VALUES: VenueScene[] = SCENE_CHIPS.map((c) => c.value);

// Tone-mapping voor mode-aware kleuren — zelfde shape als de TONE-map
// in EventListRow zodat venue-types en event-categorieën dezelfde
// brand-palette delen.
const TONE: Record<
  'nacht' | 'dag',
  Record<'acid' | 'flare' | 'plum' | 'azure', string>
> = {
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
};

const CHIPROW_HEIGHT = 48;

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
  const scrollRef = useRef<ScrollView>(null);
  useScrollToTop(scrollRef);

  // URL-state — alle filters multi-select (comma-separated) zodat
  // saved-searches 1-op-1 in een URL passen. Volgen is een booleantje.
  const params = useLocalSearchParams<{
    q?: string;
    dn?: string;
    t?: string;
    sc?: string;
    st?: string;
    vo?: string;
  }>();
  const activeDn = useMemo<VenueDayNight[]>(
    () =>
      (params.dn ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter((x): x is VenueDayNight => (DN_VALUES as string[]).includes(x)),
    [params.dn]
  );
  const activeType = useMemo<VenueType[]>(
    () =>
      (params.t ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter((x): x is VenueType => (TYPE_VALUES as string[]).includes(x)),
    [params.t]
  );
  const activeScene = useMemo<VenueScene[]>(
    () =>
      (params.sc ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter((x): x is VenueScene =>
          (SCENE_VALUES as string[]).includes(x)
        ),
    [params.sc]
  );
  // Sub-types is een vrije array — geen enum-validatie nodig, alleen
  // strippen en deduplicaten via de Set in toggleSubtype.
  const activeSubtypes = useMemo<string[]>(
    () =>
      (params.st ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x.length > 0),
    [params.st]
  );
  const onlyVolgend = params.vo === '1';
  const initialQ = params.q ?? '';

  const [q, setQ] = useState(initialQ);
  const [debouncedQ, setDebouncedQ] = useState(initialQ);
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
      <ScrollView
        ref={scrollRef}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: insets.top + HEADER_HEIGHT,
          paddingBottom: insets.bottom + 96,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={roles.accent}
            colors={[roles.accent]}
            progressViewOffset={insets.top + HEADER_HEIGHT}
          />
        }
      >
        <View style={styles.head}>
          <Text style={[styles.headKicker, { color: roles.accent }]}>
            Venues
          </Text>
          <Text style={[styles.headTitle, { color: roles.fg }]}>
            Plekken in de stad.
          </Text>
        </View>

        <SeriesSection />

        <ChipRow
          query={q}
          onQuery={setQ}
          activeDn={activeDn}
          activeType={activeType}
          activeScene={activeScene}
          activeSubtypes={activeSubtypes}
          onlyVolgend={onlyVolgend}
          onDn={(next) =>
            router.setParams({ dn: next.length > 0 ? next.join(',') : '' })
          }
          onType={(next) =>
            router.setParams({ t: next.length > 0 ? next.join(',') : '' })
          }
          onScene={(next) =>
            router.setParams({ sc: next.length > 0 ? next.join(',') : '' })
          }
          onSubtypes={(next) =>
            router.setParams({ st: next.length > 0 ? next.join(',') : '' })
          }
          onVolgend={(next) => router.setParams({ vo: next ? '1' : '' })}
        />

        {isLoading ? (
          <View style={styles.loadingWrap}>
            <SpinningCross size={28} thickness={5} color={roles.fgPlaceholder} />
          </View>
        ) : (
          <Animated.View entering={FadeIn.duration(220)}>
            {venues.length === 0 ? (
              <Text style={[styles.hint, { color: roles.fgMuted }]}>
                {debouncedQ.length > 0
                  ? `Geen venue gevonden voor "${debouncedQ}".`
                  : onlyVolgend
                    ? 'Je volgt nog geen venues.'
                    : activeDn.length +
                          activeType.length +
                          activeScene.length +
                          activeSubtypes.length >
                        0
                      ? 'Geen venues voor deze filter.'
                      : 'Geen venues om te tonen.'}
              </Text>
            ) : (
              venues.map((v) => <VenueRow key={v.id} venue={v} />)
            )}
          </Animated.View>
        )}
      </ScrollView>
      <AppHeader />
    </KeyboardAvoidingView>
  );
}

function SeriesSection() {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const { data, isLoading } = useSeriesList();
  if (isLoading || !data || data.length === 0) return null;

  return (
    <View style={styles.seriesSection}>
      <View style={styles.seriesHead}>
        <Text style={[styles.seriesHeadLabel, { color: roles.fg }]}>
          Series
        </Text>
        <Text style={[styles.seriesHeadCount, { color: roles.fgMuted }]}>
          {data.length} actief
        </Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.seriesScroller}
      >
        {data.map((s) => (
          <SeriesCard key={s.id} series={s} />
        ))}
      </ScrollView>
    </View>
  );
}

function SeriesCard({ series }: { series: ApiSeriesListItem }) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const dateRange = formatSeriesRange(series.startsAt, series.endsAt);
  return (
    <Pressable
      onPress={() => router.push(`/series/${series.slug}` as never)}
      style={[
        styles.seriesCard,
        {
          backgroundColor: isNacht ? palette.noir2 : palette.paper2,
          borderColor: isNacht ? '#2a2a2d' : palette.paper,
        },
      ]}
    >
      {series.imageUrl ? (
        <Image
          source={{ uri: series.imageUrl }}
          style={styles.seriesCardImg}
          contentFit="cover"
        />
      ) : (
        <View
          style={[
            styles.seriesCardImg,
            { backgroundColor: isNacht ? palette.noir3 : palette.paper },
          ]}
        />
      )}
      <View style={styles.seriesCardBody}>
        <Text
          numberOfLines={1}
          style={[styles.seriesCardName, { color: roles.fg }]}
        >
          {series.name}
        </Text>
        <Text
          numberOfLines={1}
          style={[styles.seriesCardMeta, { color: roles.fgMuted }]}
        >
          {[dateRange, `${series.eventCount} event${series.eventCount === 1 ? '' : 's'}`]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </View>
    </Pressable>
  );
}

function formatSeriesRange(
  startsAt: string | null,
  endsAt: string | null
): string | null {
  if (!startsAt) return null;
  const start = new Date(startsAt);
  const end = endsAt ? new Date(endsAt) : null;
  const monthName = (d: Date) => MONTHS_NL[d.getMonth()].toLowerCase();
  const day = (d: Date) => String(d.getDate());
  if (!end) return `Vanaf ${day(start)} ${monthName(start)}`;
  const sameMonth =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth();
  if (sameMonth) return `${day(start)} – ${day(end)} ${monthName(start)}`;
  return `${day(start)} ${monthName(start)} – ${day(end)} ${monthName(end)}`;
}

function VenueRow({ venue }: { venue: ApiVenueListItem }) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  return (
    <Pressable
      onPress={() => router.push(`/venue/${venue.slug}` as never)}
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
                    {venue.type}
                  </Text>
                </View>
              );
            })()}
            {venue.scene && (
              <View
                style={[styles.subtypeTag, { backgroundColor: roles.bgTag }]}
              >
                <Text style={[styles.subtypeTagText, { color: roles.fg }]}>
                  {venue.scene}
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
  onDn: (next: VenueDayNight[]) => void;
  onType: (next: VenueType[]) => void;
  onScene: (next: VenueScene[]) => void;
  onSubtypes: (next: string[]) => void;
  onVolgend: (next: boolean) => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const [focused, setFocused] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const saved = useSavedVenueSearches();
  const removeSaved = useRemoveSavedVenueSearch();

  const open = focused || query.length > 0;
  const COLLAPSED_W = 36;
  const MIN_OPEN_W = 110;
  const MAX_OPEN_W = 240;
  const textWidthEstimate = 36 + query.length * 7 + 16;
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

  const filterCount =
    activeDn.length +
    activeType.length +
    activeScene.length +
    activeSubtypes.length +
    (onlyVolgend ? 1 : 0);
  const filterActive = filterCount > 0;

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
      'Verwijderen',
      `"${s.name}" verwijderen uit je opgeslagen filters?`,
      [
        { text: 'Annuleren', style: 'cancel' },
        {
          text: 'Verwijder',
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
            },
          ]}
        >
          <Pressable onPress={onIconPress} hitSlop={6} style={styles.searchIcon}>
            <Ionicons
              name={open ? 'close' : 'search'}
              size={14}
              color={roles.fgMuted}
            />
          </Pressable>
          <TextInput
            ref={inputRef}
            value={query}
            onChangeText={onQuery}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={open ? 'ZOEK' : ''}
            placeholderTextColor={roles.fgPlaceholder}
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="search"
            style={[styles.searchInput, { color: roles.fg }]}
          />
        </View>
        <Pressable
          onPress={() => setFilterOpen(true)}
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
            {filterActive ? `Filter · ${filterCount}` : 'Filter'}
          </Text>
        </Pressable>
        {saved.map((s) => {
          const active = isSavedVenueSearchActive(s, current);
          return (
            <Pressable
              key={s.id}
              onPress={() => applySaved(s)}
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
    return TYPE_CHIPS.flatMap(({ value }) => {
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

  const filterCount =
    activeDn.length +
    activeType.length +
    activeScene.length +
    activeSubtypes.length +
    (onlyVolgend ? 1 : 0);

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
        <Text style={[styles.sheetTitle, { color: roles.fg }]}>Filter</Text>
        <Text style={[styles.sheetLead, { color: roles.fgMuted }]}>
          Combineer dag/nacht, type, sub-type, scene en volg-status. Sla 'm
          op om de combinatie als chip te bewaren.
        </Text>
      </View>

      <ScrollView
        style={styles.sheetScroll}
        contentContainerStyle={styles.sheetScrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[styles.sheetSectionHead, { color: roles.fgMuted }]}>
          Dag of Nacht
        </Text>
        <View style={styles.sheetWrap}>
          {DAYNIGHT_CHIPS.map((c) => (
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
          Type
        </Text>
        <View style={styles.sheetWrap}>
          {TYPE_CHIPS.map((c) => (
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
          Sub-types
        </Text>
        {subtypesLoading && (
          <View style={styles.sheetLoading}>
            <SpinningCross size={24} thickness={4} color={roles.fgPlaceholder} />
          </View>
        )}
        {subtypesError && (
          <Text style={[styles.sheetEmpty, { color: '#c9453a' }]}>
            Kon sub-types niet laden.
          </Text>
        )}
        {!subtypesLoading && !subtypesError && groupedSubtypes.length === 0 && (
          <Text style={[styles.sheetEmpty, { color: roles.fgMuted }]}>
            {activeType.length > 0
              ? 'Geen sub-types voor dit type.'
              : 'Nog geen sub-types ingevuld.'}
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
                  {TYPE_CHIPS.find((c) => c.value === section.type)?.label ??
                    section.type}
                </Text>
              )}
              <View style={styles.sheetWrap}>
                {section.items.map((b) => {
                  const checked = activeSubtypes.includes(b.subtype);
                  return (
                    <Pressable
                      key={`${section.type}-${b.subtype}`}
                      onPress={() => toggleSubtype(b.subtype)}
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

        <Text
          style={[
            styles.sheetSectionHead,
            { color: roles.fgMuted, marginTop: 22 },
          ]}
        >
          Scene
        </Text>
        <View style={styles.sheetWrap}>
          {SCENE_CHIPS.map((c) => (
            <FilterChip
              key={c.value}
              label={c.label}
              active={activeScene.includes(c.value)}
              onPress={() => toggleScene(c.value)}
            />
          ))}
        </View>

        <Text
          style={[
            styles.sheetSectionHead,
            { color: roles.fgMuted, marginTop: 22 },
          ]}
        >
          Volg-status
        </Text>
        <View style={styles.sheetWrap}>
          <FilterChip
            label="Alleen wat ik volg"
            active={onlyVolgend}
            onPress={() => onVolgend(!onlyVolgend)}
          />
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
              placeholder="Naam (bv. Galeries Oost)"
              placeholderTextColor={roles.fgPlaceholder}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={onSave}
              style={[styles.saveInput, { color: roles.fg }]}
              maxLength={28}
            />
          </View>
          <Pressable
            accessibilityLabel="Opslaan"
            onPress={onSave}
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
            accessibilityLabel="Annuleer"
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
              Bekijk
            </Text>
          </Pressable>
          <Pressable
            accessibilityLabel="Bewaar filter"
            onPress={() => setSaveOpen(true)}
            disabled={filterCount === 0}
            style={[
              styles.sheetIconBtn,
              {
                borderColor: roles.bgChip,
                opacity: filterCount === 0 ? 0.4 : 1,
              },
            ]}
          >
            <Ionicons name="bookmark-outline" size={18} color={roles.fgMuted} />
          </Pressable>
          <Pressable
            accessibilityLabel="Wis filters en sluit"
            onPress={() => {
              onClearAll();
              onClose();
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
      onPress={onPress}
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

  head: {
    paddingHorizontal: 22,
    paddingTop: 4,
    paddingBottom: 12,
  },
  headKicker: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  headTitle: {
    fontFamily: fontFamily.display,
    fontSize: 30,
    letterSpacing: -0.9,
    lineHeight: 30,
    marginTop: 6,
  },

  hint: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.5,
    paddingHorizontal: 22,
    paddingVertical: 14,
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
    gap: 6,
    height: 32,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    overflow: 'hidden',
  },
  searchIcon: {
    width: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchInput: {
    flex: 1,
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.8,
    padding: 0,
    margin: 0,
    height: 20,
  },
  catChip: {
    height: 32,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  catChipText: {
    fontFamily: fontFamily.medium,
    fontSize: 12,
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

  // Series-sectie — horizontale rij kaarten boven de chip-row.
  seriesSection: {
    paddingTop: 4,
    paddingBottom: 4,
  },
  seriesHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingHorizontal: 22,
    paddingTop: 6,
    paddingBottom: 8,
  },
  seriesHeadLabel: {
    fontFamily: fontFamily.bold,
    fontSize: 12,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  seriesHeadCount: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  seriesScroller: {
    gap: 10,
    paddingHorizontal: 22,
    paddingBottom: 8,
  },
  seriesCard: {
    width: 220,
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  seriesCardImg: {
    width: '100%',
    height: 100,
  },
  seriesCardBody: {
    padding: 12,
    gap: 4,
  },
  seriesCardName: {
    fontFamily: fontFamily.bold,
    fontSize: 14,
    letterSpacing: -0.21,
  },
  seriesCardMeta: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 0.8,
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
    top: 16,
    right: 16,
    width: 36,
    height: 36,
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
    gap: 6,
    height: 34,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
  },
  subtypeFilterChipText: {
    fontFamily: fontFamily.medium,
    fontSize: 13,
    letterSpacing: -0.13,
    textTransform: 'lowercase',
  },
  subtypeFilterChipCount: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 0.8,
  },
  filterChip: {
    minHeight: 38,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterChipText: {
    fontFamily: fontFamily.medium,
    fontSize: 13,
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
