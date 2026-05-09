import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useScrollToTop } from '@react-navigation/native';
import { router, useLocalSearchParams } from 'expo-router';
// useLocalSearchParams blijft alleen voor deeplinks (?cat=Muziek vanuit
// Vandaag's "Meer →"-knop) — wordt gemerged in de persisted store.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
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
  type ViewToken,
} from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { Cross } from '@/components/Cross';
import { EventListRow } from '@/components/EventListRow';
import { RefreshBanner } from '@/components/RefreshBanner';
import { RunningStrip } from '@/components/RunningStrip';
import { SpinningCross } from '@/components/SpinningCross';
import type { ApiEvent, VenueType } from '@/lib/api';
import {
  eventImageUrl,
  CATEGORY_TICK,
  VENUE_TYPE_TICK,
  getVenueTypeChips,
  translateVenueType,
  dowMixed,
  effectiveEndsAtMs,
  expandToOccurrenceRows,
  rowTimeLabel,
  getTimeBlock,
  groupOccurrenceRowsByDay,
  monthShort,
  translateCategory,
  type OccurrenceGroup,
  type OccurrenceRow,
  type TimeBlock,
  useFocusedNow,
  useNowMinute,
  useTimeBlocks,
} from '@/lib/eventDisplay';
import { useLocale, useT } from '@/lib/i18n';
import { useSession } from '@/lib/authClient';
import {
  useEventGenres,
  useEvents,
  useFriends,
  useSeriesList,
} from '@/lib/queries';
import { useTabDoubleTap } from '@/lib/useTabDoubleTap';
import { useAgendaFilters } from '@/store/agendaFilters';
import { useMode, useRoles } from '@/store/mode';
import {
  isSavedSearchActive,
  type SavedSearch,
  useAddSavedSearch,
  useRemoveSavedSearch,
  useSavedSearches,
} from '@/store/savedSearches';
import { fontFamily, palette } from '@/theme/tokens';

const DAYSTRIP_HEIGHT = 76;
const CHIPROW_HEIGHT = 60;

const CATEGORIES: ApiEvent['category'][] = [
  'Muziek',
  'Theater',
  'Kunst',
  'Literatuur',
  'Film',
];

export default function Agenda() {
  const roles = useRoles();
  const mode = useMode();
  const insets = useSafeAreaInsets();
  const t = useT();
  const locale = useLocale();
  const timeBlocks = useTimeBlocks();
  const sectionListRef = useRef<SectionList<OccurrenceRow, OccurrenceGroup>>(null);
  // useScrollToTop accepteert ook een ref met scrollToLocation — past
  // 'm zonder fuss op SectionList.
  useScrollToTop(sectionListRef);

  // Filter-state komt nu uit de persistente Zustand-store ipv URL-params
  // — zo blijft je keuze actief bij tab-wissels en app-restart.
  const query = useAgendaFilters((s) => s.query);
  const onlyFriends = useAgendaFilters((s) => s.onlyFriends);
  const onlyFavorites = useAgendaFilters((s) => s.onlyFavorites);
  const activeBlocks = useAgendaFilters((s) => s.activeBlocks);
  const activeCats = useAgendaFilters((s) => s.activeCats);
  const activeTypes = useAgendaFilters((s) => s.activeTypes);
  const activeGenres = useAgendaFilters((s) => s.activeGenres);
  const setQuery = useAgendaFilters((s) => s.setQuery);
  const setOnlyFriends = useAgendaFilters((s) => s.setOnlyFriends);
  const setOnlyFavorites = useAgendaFilters((s) => s.setOnlyFavorites);
  const setActiveBlocks = useAgendaFilters((s) => s.setActiveBlocks);
  const setActiveCats = useAgendaFilters((s) => s.setActiveCats);
  const setActiveTypes = useAgendaFilters((s) => s.setActiveTypes);
  const setActiveGenres = useAgendaFilters((s) => s.setActiveGenres);

  // Deeplink-merge: Vandaag's "Meer →"-knop pusht naar /agenda?cat=X.
  // Bij eerste arrival mergen we die in de store (en wissen de URL-param
  // zodat-ie niet bij elke heractivatie opnieuw triggert).
  const params = useLocalSearchParams<{ cat?: string }>();
  useEffect(() => {
    const incoming = (params.cat ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter((c): c is ApiEvent['category'] =>
        (CATEGORIES as string[]).includes(c)
      );
    if (incoming.length === 0) return;
    setActiveCats(incoming);
    router.setParams({ cat: undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.cat]);
  const { data: session } = useSession();
  const { data: friends } = useFriends({
    enabled: Boolean(session?.user?.id),
  });
  const showFriendsChip = (friends?.length ?? 0) > 0;

  // Vanaf vandaag 00:00 — geen verleden events op de Agenda. Refreshed
  // bij tab-focus en app-resume (niet continuous), dus tijdens
  // scrollen blijft de query-key stabiel ook als middernacht passeert.
  // Bij volgende focus zit je automatisch op de nieuwe dag.
  const focusedNow = useFocusedNow();
  const todayStartIso = useMemo(() => {
    const d = new Date(focusedNow);
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }, [focusedNow]);

  // Agenda toont alles vanaf vandaag tot ver in de toekomst — vraag een
  // ruime limit zodat we niet gecapped worden op de server-default. ~2k
  // toekomstige events past in ~500KB JSON, prima fetchbaar.
  const { data: events, isLoading, error } = useEvents({
    from: todayStartIso,
    limit: 5000,
  });
  // Series + exhibitions delen één "Loopt nu"-strook bovenaan op de
  // Agenda — zelfde patroon als Vandaag voor visuele rust.
  const { data: seriesList } = useSeriesList();

  // Cliëntside filter op event-eigenschappen (category/genre/search) —
  // tijd-blok wordt apart per occurrence toegepast zodat een film met
  // matinee (14:00) én avondvoorstelling (22:00) bij beide blokken
  // verschijnt op de juiste tijden.
  const filteredEvents = useMemo(() => {
    if (!events) return [];
    const needle = query.trim().toLowerCase();
    return events.filter((e) => {
      if (activeCats.length > 0 && !activeCats.includes(e.category)) return false;
      if (activeTypes.length > 0) {
        if (!e.venue.type || !activeTypes.includes(e.venue.type)) return false;
      }
      if (activeGenres.length > 0) {
        const evGenres = e.genres ?? [];
        if (!evGenres.some((g) => activeGenres.includes(g))) return false;
      }
      if (onlyFriends && (e.friendsSaved?.length ?? 0) === 0) return false;
      if (onlyFavorites && !e.venueFollowed) return false;
      if (needle.length > 0) {
        const inTitle = e.title.toLowerCase().includes(needle);
        const inVenue = e.venue.name.toLowerCase().includes(needle);
        const inDesc = (e.description ?? '').toLowerCase().includes(needle);
        if (!inTitle && !inVenue && !inDesc) return false;
      }
      return true;
    });
  }, [
    events,
    activeCats,
    activeTypes,
    activeGenres,
    query,
    onlyFriends,
    onlyFavorites,
  ]);

  const showFavoritesChip = useMemo(
    () => Boolean(events?.some((e) => e.venueFollowed)),
    [events]
  );

  // Tikt elke 60s zodat occurrences waarvan de eindtijd voorbij is
  // automatisch wegvallen tussen server-refetches door.
  const now = useNowMinute();

  // Expand naar één rij per occurrence en groepeer per dag. Een
  // 3-daagse festival komt zo op alle 3 dagen voor; een wekelijks feest
  // op elke maandag binnen de gevraagde range. `kind: 'exhibition'`
  // events filteren we eruit — die staan los in de "Doorlopend te
  // zien"-strook bovenaan; in de dag-buckets zouden ze alleen op de
  // start-dag verschijnen, wat onintuïtief is voor iets dat 90 dagen
  // loopt.
  const days = useMemo(() => {
    const rows = expandToOccurrenceRows(filteredEvents).filter((row) => {
      if (row.event.kind === 'exhibition') return false;
      if (effectiveEndsAtMs(row.occurrence) < now) return false;
      if (activeBlocks.length === 0) return true;
      const block = getTimeBlock(new Date(row.occurrence.startsAt).getHours());
      return activeBlocks.includes(block);
    });
    return groupOccurrenceRowsByDay(rows);
  }, [filteredEvents, activeBlocks, now]);

  const [selected, setSelected] = useState<string | null>(null);

  // Pull-to-refresh: invalideert events-cache zodat de query opnieuw
  // fetched. Minimum 700ms zichtbaar zodat de banner/spinner niet
  // weg-flitst op snelle netwerken.
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    // eslint-disable-next-line no-console
    console.log('[agenda] pull-to-refresh triggered');
    setRefreshing(true);
    const start = Date.now();
    try {
      await qc.invalidateQueries({ queryKey: ['events'] });
    } finally {
      const elapsed = Date.now() - start;
      if (elapsed < 700) {
        await new Promise((r) => setTimeout(r, 700 - elapsed));
      }
      setRefreshing(false);
    }
  }, [qc]);

  // Reset selectie wanneer de eerste echte day-group binnenkomt of
  // wanneer een filter de huidige selectie weghaalt.
  useEffect(() => {
    if (days.length === 0) {
      if (selected !== null) setSelected(null);
      return;
    }
    if (!selected || !days.find((d) => d.id === selected)) {
      setSelected(days[0].id);
    }
  }, [days, selected]);

  const stickyOffset =
    insets.top + HEADER_HEIGHT + DAYSTRIP_HEIGHT + CHIPROW_HEIGHT;

  // Sections voor de SectionList — `data` is wat 'r in de items komt,
  // de OccurrenceGroup-velden (id/dow/num/month) blijven beschikbaar
  // voor renderSectionHeader.
  const sections = useMemo(
    () => days.map((d) => ({ ...d, data: d.rows })),
    [days]
  );

  // Onthoudt waar we naartoe willen, voor de retry vanuit
  // onScrollToIndexFailed wanneer de target-sectie nog niet
  // gemount is in de virtualized lijst.
  const pendingSectionRef = useRef<number | null>(null);

  const selectDay = (id: string) => {
    setSelected(id);
    const sectionIndex = sections.findIndex((s) => s.id === id);
    if (sectionIndex < 0) return;
    pendingSectionRef.current = sectionIndex;
    sectionListRef.current?.scrollToLocation({
      sectionIndex,
      itemIndex: 0,
      // viewOffset ≈ stickyOffset zorgt dat de DateAnchor net onder
      // de gefixeerde DayStrip valt ipv erachter te verdwijnen.
      viewOffset: stickyOffset,
      animated: true,
    });
  };

  // Wanneer de target-sectie buiten de render-window valt kan
  // scrollToLocation niet exact berekenen waar te landen — op iOS
  // Fabric crasht 't dan zelfs in de native ShadowNode-tree
  // (EXC_BAD_ACCESS in ModalHostViewShadowNode dealloc). Standaard
  // RN-fallback: grof scrollen naar de averageItemLength × index,
  // wachten tot rendering bijgekomen is, dan opnieuw scrollToLocation.
  const onScrollToIndexFailed = useCallback(
    (info: {
      index: number;
      highestMeasuredFrameIndex: number;
      averageItemLength: number;
    }) => {
      sectionListRef.current?.getScrollResponder()?.scrollTo({
        y: Math.max(0, info.averageItemLength * info.index - stickyOffset),
        animated: true,
      });
      setTimeout(() => {
        const target = pendingSectionRef.current;
        if (target !== null) {
          sectionListRef.current?.scrollToLocation({
            sectionIndex: target,
            itemIndex: 0,
            viewOffset: stickyOffset,
            animated: true,
          });
        }
      }, 200);
    },
    [stickyOffset]
  );

  // Sync de active chip met de huidige zichtbare sectie. In een
  // virtualized SectionList zijn niet-zichtbare items niet gemount,
  // dus onScroll + Y-positie meten werkt niet meer — gebruik
  // onViewableItemsChanged. Stable ref zodat SectionList niet warned
  // op identity-changes. Functional setSelected vermijdt closure-stale.
  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      if (viewableItems.length === 0) return;
      const first = viewableItems[0];
      const sectionId = (first.section as OccurrenceGroup | undefined)?.id;
      if (sectionId) {
        setSelected((cur) => (cur === sectionId ? cur : sectionId));
      }
    }
  ).current;
  const viewabilityConfig = useRef({
    itemVisiblePercentThreshold: 0,
  }).current;

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <RefreshBanner visible={refreshing} topOffset={stickyOffset + 8} />
      {/* SectionList virtualiseert de event-rijen — alleen wat in de
          viewport (+ overscan) zit wordt gemount. Schaalt naar 2k+ rows
          zonder dat de UI gaat trekken. ScrollView-cousin behoudt het
          scroll-gedrag (refreshControl, scroll-to-top, etc.). */}
      <SectionList
        ref={sectionListRef}
        sections={isLoading || error ? [] : sections}
        keyExtractor={(row) => row.id}
        renderItem={({ item }) => <AgendaRow row={item} />}
        renderSectionHeader={({ section }) => (
          <DateAnchor
            day={section as SectionListData<OccurrenceRow, OccurrenceGroup>}
          />
        )}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={
          <Animated.View entering={FadeIn.duration(220)}>
            {isLoading && (
              <View style={styles.loadingWrap}>
                <SpinningCross size={28} color={roles.fgPlaceholder} />
              </View>
            )}
            {error && (
              <ListState
                text={t('Kon agenda niet laden.', 'Couldn’t load agenda.')}
                tone="error"
              />
            )}
            {!isLoading && !error && (
              <RunningStrip
                series={seriesList ?? []}
                exhibitionEvents={filteredEvents}
              />
            )}
            {!isLoading && !error && days.length === 0 && (
              <ListState
                text={
                  activeCats.length > 0 ||
                  activeTypes.length > 0 ||
                  activeBlocks.length > 0 ||
                  activeGenres.length > 0 ||
                  query
                    ? t(
                        'Geen events voor deze filter.',
                        'No events for this filter.'
                      )
                    : t('Nog geen events.', 'No events yet.')
                }
              />
            )}
          </Animated.View>
        }
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: stickyOffset,
          paddingBottom: insets.bottom + 96,
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
            progressViewOffset={stickyOffset}
          />
        }
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        onScrollToIndexFailed={onScrollToIndexFailed}
        // Render-window: standaard 21 (10 rows above + 10 below + 1
        // visible). Voor variable-height rows met images is dat aan
        // de hoge kant — verlagen tot 11 (5/5/1) houdt scroll
        // butter-smooth en bespaart geheugen.
        windowSize={11}
        removeClippedSubviews
        initialNumToRender={12}
      />
      <AppHeader title={t('Agenda', 'Agenda')}>
        <View style={{ height: DAYSTRIP_HEIGHT }}>
          {days.length > 0 && selected && (
            <DayStrip
              days={days}
              selectedId={selected}
              onSelect={selectDay}
            />
          )}
        </View>
        <ChipRow
          activeCats={activeCats}
          query={query}
          activeBlocks={activeBlocks}
          activeTypes={activeTypes}
          activeGenres={activeGenres}
          onlyFriends={onlyFriends}
          showFriendsChip={showFriendsChip}
          onlyFavorites={onlyFavorites}
          showFavoritesChip={showFavoritesChip}
          onCats={setActiveCats}
          onQuery={setQuery}
          onBlocks={setActiveBlocks}
          onTypes={setActiveTypes}
          onGenres={setActiveGenres}
          onToggleFriends={() => setOnlyFriends(!onlyFriends)}
          onToggleFavorites={() => setOnlyFavorites(!onlyFavorites)}
        />
      </AppHeader>
    </View>
  );
}

function ChipRow({
  activeCats,
  query,
  activeBlocks,
  activeTypes,
  activeGenres,
  onlyFriends,
  showFriendsChip,
  onlyFavorites,
  showFavoritesChip,
  onCats,
  onQuery,
  onBlocks,
  onTypes,
  onGenres,
  onToggleFriends,
  onToggleFavorites,
}: {
  activeCats: ApiEvent['category'][];
  query: string;
  activeBlocks: TimeBlock[];
  activeTypes: VenueType[];
  activeGenres: string[];
  onlyFriends: boolean;
  showFriendsChip: boolean;
  onlyFavorites: boolean;
  showFavoritesChip: boolean;
  onCats: (next: ApiEvent['category'][]) => void;
  onQuery: (q: string) => void;
  onBlocks: (next: TimeBlock[]) => void;
  onTypes: (next: VenueType[]) => void;
  onGenres: (next: string[]) => void;
  onToggleFriends: () => void;
  onToggleFavorites: () => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const t = useT();
  const locale = useLocale();
  const [focused, setFocused] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const saved = useSavedSearches();
  const removeSaved = useRemoveSavedSearch();
  // Dubbele tap op de Agenda-tab = zoekveld leegmaken + focussen.
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

  // Het zoekveld is "open" zodra het focus heeft of als er tekst staat.
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

  const filterCount =
    activeCats.length +
    activeBlocks.length +
    activeTypes.length +
    activeGenres.length;
  const filterActive = filterCount > 0;
  // Eerste belangrijke filter als label: categorie > venue-type >
  // genre. Render: "Cinema + 2" voor primair + extra; geen primair?
  // terug naar "Filter · N" zoals voorheen.
  const filterLabel = filterActive
    ? (() => {
        let primary: string | null = null;
        if (activeCats.length > 0) {
          primary = translateCategory(activeCats[0], locale);
        } else if (activeTypes.length > 0) {
          primary = translateVenueType(activeTypes[0], locale);
        } else if (activeGenres.length > 0) {
          primary = activeGenres[0];
        }
        if (primary === null) return `${t('Filter', 'Filter')} · ${filterCount}`;
        const others = filterCount - 1;
        return others > 0 ? `${primary} + ${others}` : primary;
      })()
    : t('Filter', 'Filter');

  const applySaved = (s: SavedSearch) => {
    const active = isSavedSearchActive(s, {
      cats: activeCats,
      tb: activeBlocks,
      vt: activeTypes,
      gn: activeGenres,
      q: query,
    });
    if (active) {
      onCats([]);
      onBlocks([]);
      onTypes([]);
      onGenres([]);
      onQuery('');
      return;
    }
    // Defensieve fallbacks voor oude persisted shape (pre-migrate
    // schemaversie 1) waar `cats`/`vt` nog niet bestonden.
    onCats(s.cats ?? []);
    onBlocks(s.tb ?? []);
    onTypes(s.vt ?? []);
    onGenres(s.gn ?? []);
    onQuery(s.q ?? '');
  };

  const onLongPressSaved = (s: SavedSearch) => {
    Alert.alert(
      t('Verwijderen', 'Remove'),
      t(
        `"${s.name}" verwijderen uit je opgeslagen zoekopdrachten?`,
        `Remove "${s.name}" from your saved searches?`
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

  const current = {
    cats: activeCats,
    tb: activeBlocks,
    vt: activeTypes,
    gn: activeGenres,
    q: query,
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
            size={16}
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
        {showFriendsChip && (
          <Pressable
            accessibilityLabel={
              onlyFriends
                ? t('Toon alle events', 'Show all events')
                : t('Alleen events met vrienden', 'Only events with friends')
            }
            onPress={onToggleFriends}
            style={[
              styles.friendsToggle,
              {
                borderColor: onlyFriends
                  ? roles.fg
                  : isNacht
                    ? '#2a2a2d'
                    : palette.paper,
                backgroundColor: onlyFriends
                  ? roles.fg
                  : isNacht
                    ? palette.noir2
                    : palette.paper2,
              },
            ]}
          >
            <Ionicons
              name="people"
              size={14}
              color={onlyFriends ? roles.bg : roles.fgMuted}
            />
          </Pressable>
        )}
        {showFavoritesChip && (
          <Pressable
            accessibilityLabel={
              onlyFavorites
                ? t('Toon alle events', 'Show all events')
                : t(
                    'Alleen events bij favoriete venues',
                    'Only events at favourite venues'
                  )
            }
            onPress={onToggleFavorites}
            style={[
              styles.friendsToggle,
              {
                borderColor: onlyFavorites
                  ? roles.fg
                  : isNacht
                    ? '#2a2a2d'
                    : palette.paper,
                backgroundColor: onlyFavorites
                  ? roles.fg
                  : isNacht
                    ? palette.noir2
                    : palette.paper2,
              },
            ]}
          >
            <Ionicons
              name={onlyFavorites ? 'heart' : 'heart-outline'}
              size={14}
              color={onlyFavorites ? roles.bg : roles.fgMuted}
            />
          </Pressable>
        )}
        {saved.map((s) => {
          const active = isSavedSearchActive(s, current);
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
                  {
                    color: active ? roles.accent : roles.fgMuted,
                  },
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
          activeCats={activeCats}
          activeBlocks={activeBlocks}
          activeTypes={activeTypes}
          activeGenres={activeGenres}
          query={query}
          onCats={onCats}
          onBlocks={onBlocks}
          onTypes={onTypes}
          onGenres={onGenres}
          onClose={() => setFilterOpen(false)}
        />
      </Modal>
    </>
  );
}

function FilterSheet({
  activeCats,
  activeBlocks,
  activeTypes,
  activeGenres,
  query,
  onCats,
  onBlocks,
  onTypes,
  onGenres,
  onClose,
}: {
  activeCats: ApiEvent['category'][];
  activeBlocks: TimeBlock[];
  activeTypes: VenueType[];
  activeGenres: string[];
  query: string;
  onCats: (next: ApiEvent['category'][]) => void;
  onBlocks: (next: TimeBlock[]) => void;
  onTypes: (next: VenueType[]) => void;
  onGenres: (next: string[]) => void;
  onClose: () => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const t = useT();
  const locale = useLocale();
  const timeBlocks = useTimeBlocks();
  const typeChips = useMemo(() => getVenueTypeChips(locale), [locale]);
  const { data: genreData, isLoading, error } = useEventGenres();
  const addSaved = useAddSavedSearch();
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');

  const groupedGenres = useMemo(() => {
    if (!genreData) return [];
    // Filter genre-buckets op de geselecteerde categorieën — als er
    // niets gekozen is, alle genres tonen.
    const filtered =
      activeCats.length > 0
        ? genreData.filter((b) => activeCats.includes(b.category))
        : genreData;
    const map = new Map<ApiEvent['category'], typeof filtered>();
    for (const b of filtered) {
      const arr = map.get(b.category) ?? [];
      arr.push(b);
      map.set(b.category, arr);
    }
    return CATEGORIES.flatMap((category) => {
      const items = map.get(category);
      return items ? [{ category, items }] : [];
    });
  }, [genreData, activeCats]);

  const toggleCat = (c: ApiEvent['category']) => {
    if (activeCats.includes(c)) onCats(activeCats.filter((x) => x !== c));
    else onCats([...activeCats, c]);
  };
  const toggleType = (vt: VenueType) => {
    if (activeTypes.includes(vt)) onTypes(activeTypes.filter((x) => x !== vt));
    else onTypes([...activeTypes, vt]);
  };
  const toggleBlock = (b: TimeBlock) => {
    if (activeBlocks.includes(b)) onBlocks(activeBlocks.filter((x) => x !== b));
    else onBlocks([...activeBlocks, b]);
  };
  const toggleGenre = (g: string) => {
    if (activeGenres.includes(g)) onGenres(activeGenres.filter((x) => x !== g));
    else onGenres([...activeGenres, g]);
  };
  const filterCount =
    activeCats.length +
    activeTypes.length +
    activeBlocks.length +
    activeGenres.length;

  const onClearAll = () => {
    onCats([]);
    onTypes([]);
    onBlocks([]);
    onGenres([]);
  };

  const onSave = () => {
    const name = saveName.trim();
    if (name.length === 0) return;
    addSaved({
      name,
      cats: activeCats,
      tb: activeBlocks,
      vt: activeTypes,
      gn: activeGenres,
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
            "Combineer categorie, tijd en genre. Sla 'm op om de combinatie als chip te bewaren.",
            'Combine category, time and genre. Save it to keep the combination as a chip.'
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
          {t('Categorie', 'Category')}
        </Text>
        <View style={styles.genreWrap}>
          {CATEGORIES.map((cat) => (
            <FilterChip
              key={cat}
              label={translateCategory(cat, locale)}
              active={activeCats.includes(cat)}
              onPress={() => toggleCat(cat)}
            />
          ))}
        </View>

        <Text
          style={[
            styles.sheetSectionHead,
            { color: roles.fgMuted, marginTop: 22 },
          ]}
        >
          {t('Venue-type', 'Venue type')}
        </Text>
        <View style={styles.genreWrap}>
          {typeChips.map((c) => (
            <FilterChip
              key={c.value}
              label={c.label}
              active={activeTypes.includes(c.value)}
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
          {t('Tijd', 'Time')}
        </Text>
        <View style={styles.genreWrap}>
          {timeBlocks.map((b) => (
            <FilterChip
              key={b.id}
              label={b.label}
              sub={b.range}
              active={activeBlocks.includes(b.id)}
              onPress={() => toggleBlock(b.id)}
            />
          ))}
        </View>

        <Text
          style={[
            styles.sheetSectionHead,
            { color: roles.fgMuted, marginTop: 22 },
          ]}
        >
          {t('Genre', 'Genre')}
        </Text>
        {isLoading && (
          <View style={styles.sheetLoading}>
            <SpinningCross size={24} color={roles.fgPlaceholder} />
          </View>
        )}
        {error && (
          <Text style={[styles.sheetEmpty, { color: '#c9453a' }]}>
            {t('Kon genres niet laden.', 'Couldn’t load genres.')}
          </Text>
        )}
        {!isLoading && !error && groupedGenres.length === 0 && (
          <Text style={[styles.sheetEmpty, { color: roles.fgMuted }]}>
            {activeCats.length === 1
              ? t(
                  `Geen genres gevonden voor ${activeCats[0]}.`,
                  `No genres found for ${translateCategory(activeCats[0], 'en')}.`
                )
              : activeCats.length > 1
                ? t(
                    'Geen genres gevonden voor deze categorieën.',
                    'No genres found for these categories.'
                  )
                : t('Nog geen genres ingevuld.', 'No genres yet.')}
          </Text>
        )}
        <View style={styles.sheetSubSectionGroup}>
        {groupedGenres.map((section) => (
          <View key={section.category}>
            {/* Sub-heading per categorie verschijnt alleen als er meer
                dan één categorie zichtbaar is — anders zijn alle genres
                impliciet van die ene gekozen categorie. */}
            {(activeCats.length === 0 || activeCats.length > 1) && (
              <Text
                style={[styles.sheetSubSectionHead, { color: roles.fgPlaceholder }]}
              >
                {translateCategory(section.category, locale)}
              </Text>
            )}
            <View style={styles.genreWrap}>
              {section.items.map((b) => {
                const checked = activeGenres.includes(b.genre);
                return (
                  <Pressable
                    key={`${section.category}-${b.genre}`}
                    onPress={() => toggleGenre(b.genre)}
                    style={[
                      styles.genreChip,
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
                        styles.genreChipText,
                        { color: checked ? roles.bg : roles.fg },
                      ]}
                    >
                      {b.genre}
                    </Text>
                    <Text
                      style={[
                        styles.genreChipCount,
                        {
                          color: checked
                            ? roles.bg
                            : roles.fgPlaceholder,
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
              placeholder={t('Naam (bv. Late techno)', 'Name (e.g. Late techno)')}
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
            accessibilityLabel={t('Annuleer', 'Cancel')}
            onPress={() => {
              setSaveOpen(false);
              setSaveName('');
            }}
            style={[
              styles.sheetIconBtn,
              { borderColor: roles.bgChip },
            ]}
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
            <Ionicons
              name="bookmark-outline"
              size={18}
              color={roles.accent}
            />
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
  sub,
  active,
  onPress,
}: {
  label: string;
  sub?: string;
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
      {sub && (
        <Text
          style={[
            styles.filterChipSub,
            {
              color: active ? roles.bg : roles.fgPlaceholder,
              opacity: active ? 0.7 : 1,
            },
          ]}
        >
          {sub}
        </Text>
      )}
    </Pressable>
  );
}

function DayStrip({
  days,
  selectedId,
  onSelect,
}: {
  days: OccurrenceGroup[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const chipLayouts = useRef<Record<string, { x: number; width: number }>>({});
  const viewport = useRef(0);

  // Whenever the selection changes (click OR vertical scroll), bring
  // the active chip into view — centred when possible.
  useEffect(() => {
    const layout = chipLayouts.current[selectedId];
    const vp = viewport.current;
    if (!layout || vp === 0 || !scrollRef.current) return;
    const targetX = Math.max(0, layout.x - (vp - layout.width) / 2);
    scrollRef.current.scrollTo({ x: targetX, animated: true });
  }, [selectedId]);

  return (
    <ScrollView
      ref={scrollRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.dayStrip}
      onLayout={(e) => {
        viewport.current = e.nativeEvent.layout.width;
      }}
    >
      {days.map((day) => (
        <DayChip
          key={day.id}
          day={day}
          active={day.id === selectedId}
          onPress={() => onSelect(day.id)}
          onLayout={(x, width) => {
            chipLayouts.current[day.id] = { x, width };
          }}
        />
      ))}
    </ScrollView>
  );
}

function DayChip({
  day,
  active,
  onPress,
  onLayout,
}: {
  day: OccurrenceGroup;
  active: boolean;
  onPress: () => void;
  onLayout: (x: number, width: number) => void;
}) {
  const roles = useRoles();
  return (
    <Pressable
      onPress={onPress}
      onLayout={(e) =>
        onLayout(e.nativeEvent.layout.x, e.nativeEvent.layout.width)
      }
      style={[styles.dayChip, active && { backgroundColor: roles.accent }]}
    >
      <Text
        style={[
          styles.dayChipDow,
          { color: active ? roles.onAccent : roles.fgMuted },
        ]}
      >
        {day.dow}
      </Text>
      <Text
        style={[
          styles.dayChipNum,
          { color: active ? roles.onAccent : roles.fg },
        ]}
      >
        {day.num}
      </Text>
    </Pressable>
  );
}

function DateAnchor({ day }: { day: OccurrenceGroup }) {
  const roles = useRoles();
  const t = useT();
  return (
    <View style={styles.dateAnchor}>
      <View style={styles.dateAnchorLeft}>
        <Text style={[styles.dateAnchorDow, { color: roles.fg }]}>
          {day.dow} {day.num}
        </Text>
        <Text style={[styles.dateAnchorMonth, { color: roles.fgMuted }]}>
          {day.month}
        </Text>
      </View>
      <Text style={[styles.dateAnchorCount, { color: roles.fgPlaceholder }]}>
        {day.count}{' '}
        {day.count === 1
          ? t('plan', 'plan')
          : t('plannen', 'plans')}
      </Text>
    </View>
  );
}

function AgendaRow({ row }: { row: OccurrenceRow }) {
  const { event, occurrence } = row;
  const locale = useLocale();
  const toggleType = useAgendaFilters((s) => s.toggleType);
  // Friend-pill is occurrence-specific: alleen vrienden die díe avond
  // gesaved hebben, niet alle die de film "in het algemeen" volgen.
  // Server zet ze op occurrence.friendsSaved; fallback op event-level
  // voor pre-refactor responses (cachebusts vrijwel direct).
  const rawFriends = occurrence.friendsSaved ?? event.friendsSaved ?? [];
  const friends = rawFriends.map((f) => ({
    name: f.name,
    avatar: f.avatarUrl,
  }));
  // Synthetische occurrence-id (`evt::next`) komt vanuit fallback-pad
  // wanneer er geen occurrencesInRange zijn — dan geen ?o= in de URL
  // omdat die geen echte server-side ID is.
  const isSynthetic = occurrence.id.endsWith('::next');
  const path = isSynthetic
    ? `/event/${event.id}`
    : `/event/${event.id}?o=${occurrence.id}`;
  // Venue krijgt een tone-pill (eerste in tag-row) op basis van
  // venue.type — categorie-tag komt erna. Voor venues zonder type
  // valt de pill weg en blijft venue in de subline staan. Pill is
  // tappable: toggelt het venue-type-filter.
  const venueType = event.venue.type;
  const venueTone = venueType ? VENUE_TYPE_TICK[venueType] : undefined;
  const onVenuePress = venueType ? () => toggleType(venueType) : undefined;
  return (
    <EventListRow
      time={rowTimeLabel(occurrence.startsAt, occurrence.endsAt, locale)}
      thumb={eventImageUrl(event) ?? ''}
      title={event.title}
      venue={event.venue.name}
      venueTone={venueTone}
      onVenuePress={onVenuePress}
      tags={[
        {
          label: translateCategory(event.category, locale),
          tone: CATEGORY_TICK[event.category],
        },
      ]}
      seriesLabel={event.series?.[0]?.name}
      genreLabel={event.genres?.[0]}
      friends={friends && friends.length > 0 ? friends : undefined}
      tick={CATEGORY_TICK[event.category]}
      onPress={() => router.push(path as never)}
    />
  );
}

function ListState({
  text,
  tone = 'muted',
}: {
  text: string;
  tone?: 'muted' | 'error';
}) {
  const roles = useRoles();
  return (
    <View style={styles.listState}>
      <Text
        style={[
          styles.listStateText,
          { color: tone === 'error' ? '#c9453a' : roles.fgMuted },
        ]}
      >
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  dayStrip: {
    gap: 6,
    paddingHorizontal: 22,
    paddingVertical: 5,
    alignItems: 'center',
    height: DAYSTRIP_HEIGHT,
  },
  dayChip: {
    minWidth: 56,
    height: 66,
    paddingHorizontal: 4,
    paddingVertical: 10,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  dayChipDow: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  dayChipNum: {
    fontFamily: fontFamily.display,
    fontSize: 24,
    letterSpacing: -0.48,
    lineHeight: 24,
  },

  // Date anchor — same style as Gered's so the two screens read alike
  dateAnchor: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: 22,
    paddingTop: 14,
    paddingBottom: 6,
    gap: 10,
  },
  dateAnchorLeft: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  dateAnchorDow: {
    fontFamily: fontFamily.display,
    fontSize: 22,
    letterSpacing: -0.44,
  },
  dateAnchorMonth: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  dateAnchorCount: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },

  // Chip row — sticky between day-strip en de scroll content
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
  searchIcon: { width: 18, height: 18, alignItems: 'center', justifyContent: 'center' },
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
  catChipText: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.06,
  },
  friendsToggle: {
    width: 44,
    height: 44,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },

  listState: { paddingHorizontal: 22, paddingVertical: 14 },
  loadingWrap: {
    paddingVertical: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listStateText: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.8,
  },

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
  sheetLoading: {
    paddingVertical: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetEmpty: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.8,
    paddingVertical: 18,
    textAlign: 'center',
  },
  sheetSection: { marginTop: 14 },
  sheetSectionHead: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  sheetSubSectionGroup: { gap: 12 },
  sheetSubSectionHead: {
    fontFamily: fontFamily.mono,
    fontSize: 9,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  filterChip: {
    minHeight: 44,
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  filterChipText: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.13,
  },
  filterChipSub: {
    fontFamily: fontFamily.mono,
    fontSize: 9,
    letterSpacing: 0.8,
    marginTop: 1,
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
  genreWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  genreChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 44,
    paddingHorizontal: 18,
    borderRadius: 999,
    borderWidth: 1,
  },
  genreChipText: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.13,
    textTransform: 'lowercase',
  },
  genreChipCount: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.8,
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
  // Vierkant icoontje-knop voor bewaar/wis — in plaats van de wide
  // text-knoppen. De Bekijk-knop daarnaast houdt z'n flex en pakt
  // de overgebleven ruimte.
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
});
