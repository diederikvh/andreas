import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useScrollToTop } from '@react-navigation/native';
import { router, useLocalSearchParams } from 'expo-router';
// useLocalSearchParams blijft alleen voor deeplinks (?cat=Muziek vanuit
// Vandaag's "Meer →"-knop) — wordt gemerged in de persisted store.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
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

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { FilterHint } from '@/components/FilterHint';
import { Cross } from '@/components/Cross';
import { EventListRow } from '@/components/EventListRow';
import { RefreshBanner } from '@/components/RefreshBanner';
import { SpinningCross } from '@/components/SpinningCross';
import type { AgendaRow as AgendaRowData, ApiEvent, VenueType } from '@/lib/api';
import {
  CATEGORY_TICK,
  VENUE_TYPE_TICK,
  getVenueTypeChips,
  translateVenueType,
  dowMixed,
  rowTimeLabel,
  monthShort,
  translateCategory,
  type TimeBlock,
  useFocusedNow,
  useTimeBlocks,
} from '@/lib/eventDisplay';
import { softTap, tinyTap } from '@/lib/haptics';
import { useLocale, useT } from '@/lib/i18n';
import type { Locale } from '@/lib/i18n';
import { useSession } from '@/lib/authClient';
import {
  useAgendaDay,
  useAgendaDayPrefetch,
  useAgendaDays,
  useFriends,
} from '@/lib/queries';
import { useResetFiltersOnTabBlur } from '@/lib/useResetFiltersOnTabBlur';
import { useTabDoubleTap } from '@/lib/useTabDoubleTap';
import { useAgendaFilters } from '@/store/agendaFilters';
import { useMode, useModeStore, useRoles } from '@/store/mode';
import {
  isSavedSearchActive,
  type SavedSearch,
  useAddSavedSearch,
  useRemoveSavedSearch,
  useSavedSearches,
} from '@/store/savedSearches';
import { fontFamily, palette } from '@/theme/tokens';

const MONTH_LABEL_HEIGHT = 14;
const DAYSTRIP_HEIGHT = 76;
const DAYSTRIP_INNER_HEIGHT = DAYSTRIP_HEIGHT - MONTH_LABEL_HEIGHT;
const CHIPROW_HEIGHT = 60;
/** Hoever in de toekomst de day-strip kijkt vanaf vandaag. 90 dagen
    dekt het gros van wat venues geannonceerd hebben staan — verder
    kunnen we later infinite-paginaten als het nodig is. */
const AGENDA_WINDOW_DAYS = 90;

const CATEGORIES: ApiEvent['category'][] = [
  'Muziek',
  'Theater',
  'Kunst',
  'Lezing',
  'Literatuur',
  'Film',
];

// Day-strip-item: 1 op 1 wat de UI nodig heeft om een chip te tekenen.
// Server geeft alleen {date, count} terug — dow/num/month derive'n we
// hier, locale-aware.
type DaySummary = {
  id: string;
  date: string;
  dow: string;
  num: string;
  month: string;
  count: number;
};

// Categorie-tinten per mode — zelfde mapping als op Vandaag, zodat een
// "Muziek"-sub-kop in de Agenda matcht met de tag-pill op de event-row
// én met het cat-kopje op Vandaag.
const TONE: Record<
  'nacht' | 'dag',
  Record<'acid' | 'flare' | 'plum' | 'azure' | 'saffron' | 'cobalt', string>
> = {
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
};

// FlatList-items binnen de geselecteerde dag: cat-header die collapse-
// state beheert, gevolgd door 0+ rij-items (verborgen als ingeklapt).
type AgendaItem =
  | {
      type: 'header';
      id: string;
      category: ApiEvent['category'];
      count: number;
      collapsed: boolean;
    }
  | { type: 'row'; id: string; row: AgendaRowData };

function deriveDay(date: string, count: number, locale: Locale): DaySummary {
  // Noon-tijd vermijdt rare TZ-edges rondom middernacht (DST etc.).
  const d = new Date(`${date}T12:00:00`);
  return {
    id: date,
    date,
    dow: dowMixed(d.getDay(), locale),
    num: String(d.getDate()).padStart(2, '0'),
    month: monthShort(d.getMonth(), locale),
    count,
  };
}

function logicalTodayDate(now: Date): string {
  // Logische dag-shift: vóór 06:00 → kalenderdag - 1.
  const d = new Date(now);
  if (d.getHours() < 6) d.setDate(d.getDate() - 1);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function addDaysToDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export default function Agenda() {
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const t = useT();
  const locale = useLocale();
  const listRef = useRef<FlatList<AgendaItem>>(null);
  useScrollToTop(listRef);

  // Filter-state uit persistente Zustand-store — blijft actief over
  // tab-wissels en app-restart.
  const query = useAgendaFilters((s) => s.query);
  const onlyFriends = useAgendaFilters((s) => s.onlyFriends);
  const onlyFavorites = useAgendaFilters((s) => s.onlyFavorites);
  const activeBlocks = useAgendaFilters((s) => s.activeBlocks);
  const activeCats = useAgendaFilters((s) => s.activeCats);
  const activeTypes = useAgendaFilters((s) => s.activeTypes);
  const setQuery = useAgendaFilters((s) => s.setQuery);
  const setOnlyFriends = useAgendaFilters((s) => s.setOnlyFriends);
  const setOnlyFavorites = useAgendaFilters((s) => s.setOnlyFavorites);
  const setActiveBlocks = useAgendaFilters((s) => s.setActiveBlocks);
  const setActiveCats = useAgendaFilters((s) => s.setActiveCats);
  const setActiveTypes = useAgendaFilters((s) => s.setActiveTypes);
  const resetFilters = useAgendaFilters((s) => s.reset);

  // Stack-persistent filter-state: reset bij tab-wissel, behoud bij
  // tap-naar-detail-en-terug.
  const markPush = useResetFiltersOnTabBlur(resetFilters);
  const onRowTap = useCallback(
    (path: string) => {
      markPush();
      router.push(path as never);
    },
    [markPush]
  );

  // Deeplink-merge: Vandaag's "Meer →"-knop pusht naar /agenda?cat=X,
  // genre-chips op een vriend-profiel pushen naar /agenda?q=techno.
  const params = useLocalSearchParams<{ cat?: string; q?: string }>();
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
  useEffect(() => {
    const q = (params.q ?? '').trim();
    if (q.length === 0) return;
    setQuery(q);
    router.setParams({ q: undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.q]);

  const { data: session } = useSession();
  const { data: friends } = useFriends({
    enabled: Boolean(session?.user?.id),
  });
  const showFriendsChip = (friends?.length ?? 0) > 0;
  // Geen volledige events-cache meer om "heb ik überhaupt favorieten?"
  // af te leiden. We tonen de chip dus voor iedereen die ingelogd is —
  // klik zonder follows → server retourneert geen rijen, en de
  // "geen events"-state legt 't uit. Eenvoudiger dan apart endpoint.
  const showFavoritesChip = Boolean(session?.user?.id);

  // Window: logische dag-start + 90 dagen vooruit. `focusedNow` ververst
  // alleen bij tab-focus zodat de query-key niet middenin het scrollen
  // verandert. Bij volgende focus zit je vanzelf op de nieuwe dag.
  const focusedNow = useFocusedNow();
  const fromDate = useMemo(
    () => logicalTodayDate(new Date(focusedNow)),
    [focusedNow]
  );
  const toDate = useMemo(
    () => addDaysToDate(fromDate, AGENDA_WINDOW_DAYS),
    [fromDate]
  );

  // Server-side filters voor beide agenda-endpoints. Time-blocks
  // óók server-side zodat de day-strip-tellingen er rekening mee houden
  // (anders zou een Bookshop+Nacht-filter een dag tonen die wél
  // Bookshop-events heeft maar niet 's nachts → klikbaar in lege ruimte).
  const apiFilters = useMemo(
    () => ({
      categories: activeCats,
      venueTypes: activeTypes,
      blocks: activeBlocks,
      q: query || undefined,
      onlyFollowed: onlyFavorites,
      onlyFriends,
    }),
    [activeCats, activeTypes, activeBlocks, query, onlyFavorites, onlyFriends]
  );

  // Day-strip: lichte aggregate-query per logische dag. Geen row-data.
  // `from` = huidige tijd (niet middernacht), zodat een late-night-club
  // die om 02:00 stopt niet als "gisteren had 12 events" verschijnt op
  // een 10:00-bezoek. Late-night events die nog lopen blijven wél
  // zichtbaar — de logical-day-cutoff doet de rest.
  const {
    data: agendaDays,
    isLoading: daysLoading,
    error: daysError,
  } = useAgendaDays({
    from: new Date(focusedNow).toISOString(),
    to: `${toDate}T00:00:00.000Z`,
    filters: apiFilters,
  });

  const days: DaySummary[] = useMemo(() => {
    if (!agendaDays) return [];
    return agendaDays.map((d) => deriveDay(d.date, d.count, locale));
  }, [agendaDays, locale]);

  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  // Auto-select wanneer eerste data binnenkomt of huidige selectie door
  // een filter-wijziging uit de lijst verdwijnt.
  useEffect(() => {
    if (days.length === 0) {
      if (selectedDate !== null) setSelectedDate(null);
      return;
    }
    if (!selectedDate || !days.find((d) => d.id === selectedDate)) {
      setSelectedDate(days[0].id);
    }
  }, [days, selectedDate]);

  // Lean rows voor de geselecteerde dag. `from` is alleen relevant
  // voor de huidige logische dag (filtert verlopen events); voor
  // toekomstige dagen passeert 't onschadelijk via GREATEST in SQL.
  const {
    data: rows = [],
    isLoading: rowsLoading,
    error: rowsError,
  } = useAgendaDay({
    date: selectedDate,
    from: new Date(focusedNow).toISOString(),
    filters: apiFilters,
  });

  // Prefetch ±1 dag zodat tap op volgende/vorige chip instant rendert.
  const prefetchDay = useAgendaDayPrefetch();
  useEffect(() => {
    if (!selectedDate) return;
    const idx = days.findIndex((d) => d.id === selectedDate);
    if (idx < 0) return;
    const fromIso = new Date(focusedNow).toISOString();
    const next = days[idx + 1]?.id;
    const prev = days[idx - 1]?.id;
    if (next)
      prefetchDay({ date: next, from: fromIso, filters: apiFilters });
    if (prev)
      prefetchDay({ date: prev, from: fromIso, filters: apiFilters });
  }, [selectedDate, days, apiFilters, prefetchDay, focusedNow]);

  // -8 om de day-strip + chip-row 8px omhoog te trekken, dichter
  // tegen de "Andreas" wordmark aan.
  const stickyOffset =
    insets.top + HEADER_HEIGHT + DAYSTRIP_HEIGHT + CHIPROW_HEIGHT - 8;

  const selectDay = useCallback((id: string) => {
    setSelectedDate(id);
  }, []);

  // Pull-to-refresh: invalideert beide agenda-caches zodat én de day-
  // strip én de huidige dag opnieuw fetchen.
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    const start = Date.now();
    try {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['agenda-days'] }),
        qc.invalidateQueries({ queryKey: ['agenda-day'] }),
      ]);
    } finally {
      const elapsed = Date.now() - start;
      if (elapsed < 700) {
        await new Promise((r) => setTimeout(r, 700 - elapsed));
      }
      setRefreshing(false);
    }
  }, [qc]);

  const selectedDay = days.find((d) => d.id === selectedDate) ?? null;
  const hasActiveFilter =
    activeCats.length > 0 ||
    activeTypes.length > 0 ||
    activeBlocks.length > 0 ||
    query.length > 0 ||
    onlyFriends ||
    onlyFavorites;

  // Per-categorie collapse-state. Reset bij dag-wissel zodat alles
  // open is wanneer je naar een nieuwe dag tikt (anders zou je
  // verwachten alles te zien maar krijg je een ingeklapte view).
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(
    () => new Set()
  );
  useEffect(() => {
    setCollapsedCats(new Set());
  }, [selectedDate]);

  const toggleCollapse = useCallback((cat: ApiEvent['category']) => {
    setCollapsedCats((cur) => {
      const next = new Set(cur);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }, []);

  // Items voor de FlatList: cat-headers + rows, gegroepeerd in vaste
  // CATEGORIES-volgorde (matcht Vandaag's rail-volgorde). Een ingeklapte
  // categorie laat alleen de header staan zodat je de groep visueel
  // kan overslaan.
  const items: AgendaItem[] = useMemo(() => {
    const byCat = new Map<ApiEvent['category'], AgendaRowData[]>();
    for (const row of rows) {
      const arr = byCat.get(row.category) ?? [];
      arr.push(row);
      byCat.set(row.category, arr);
    }
    const out: AgendaItem[] = [];
    for (const cat of CATEGORIES) {
      const arr = byCat.get(cat);
      if (!arr || arr.length === 0) continue;
      const collapsed = collapsedCats.has(cat);
      out.push({
        type: 'header',
        id: `header::${cat}`,
        category: cat,
        count: arr.length,
        collapsed,
      });
      if (!collapsed) {
        for (const row of arr) {
          out.push({ type: 'row', id: row.id, row });
        }
      }
    }
    return out;
  }, [rows, collapsedCats]);

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <RefreshBanner visible={refreshing} topOffset={stickyOffset + 8} />
      <FlatList
        ref={listRef}
        data={items}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) =>
          item.type === 'header' ? (
            <CategoryHeader
              category={item.category}
              count={item.count}
              collapsed={item.collapsed}
              onPress={() => toggleCollapse(item.category)}
            />
          ) : (
            <AgendaRowItem row={item.row} onTap={onRowTap} />
          )
        }
        ListHeaderComponent={
          <Animated.View entering={FadeIn.duration(220)}>
            {(daysLoading || rowsLoading) && (
              <View style={styles.loadingWrap}>
                <SpinningCross size={28} color={roles.fgPlaceholder} />
              </View>
            )}
            {(daysError || rowsError) && (
              <ListState
                text={t('Kon agenda niet laden.', 'Couldn’t load agenda.')}
                tone="error"
              />
            )}
            {!daysLoading &&
              !daysError &&
              days.length === 0 && (
                <ListState
                  text={
                    hasActiveFilter
                      ? t(
                          'Geen events voor deze filter.',
                          'No events for this filter.'
                        )
                      : t('Nog geen events.', 'No events yet.')
                  }
                />
              )}
            {!rowsLoading &&
              !rowsError &&
              days.length > 0 &&
              rows.length === 0 && (
                <ListState
                  text={t(
                    'Geen events op deze dag voor deze filter.',
                    'No events on this day for this filter.'
                  )}
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
        windowSize={11}
        removeClippedSubviews
        initialNumToRender={12}
      />
      <AppHeader title={t('Agenda', 'Agenda')} showContentMode>
        <ChipRow
          activeCats={activeCats}
          query={query}
          activeBlocks={activeBlocks}
          activeTypes={activeTypes}
          onlyFriends={onlyFriends}
          showFriendsChip={showFriendsChip}
          onlyFavorites={onlyFavorites}
          showFavoritesChip={showFavoritesChip}
          onCats={setActiveCats}
          onQuery={setQuery}
          onBlocks={setActiveBlocks}
          onTypes={setActiveTypes}
          onToggleFriends={() => setOnlyFriends(!onlyFriends)}
          onToggleFavorites={() => setOnlyFavorites(!onlyFavorites)}
        />
        <View style={{ height: DAYSTRIP_HEIGHT }}>
          {days.length > 0 && selectedDate && (
            <DayStrip
              days={days}
              selectedId={selectedDate}
              onSelect={selectDay}
            />
          )}
        </View>
      </AppHeader>
      <FilterHint />
    </View>
  );
}

function ChipRow({
  activeCats,
  query,
  activeBlocks,
  activeTypes,
  onlyFriends,
  showFriendsChip,
  onlyFavorites,
  showFavoritesChip,
  onCats,
  onQuery,
  onBlocks,
  onTypes,
  onToggleFriends,
  onToggleFavorites,
}: {
  activeCats: ApiEvent['category'][];
  query: string;
  activeBlocks: TimeBlock[];
  activeTypes: VenueType[];
  onlyFriends: boolean;
  showFriendsChip: boolean;
  onlyFavorites: boolean;
  showFavoritesChip: boolean;
  onCats: (next: ApiEvent['category'][]) => void;
  onQuery: (q: string) => void;
  onBlocks: (next: TimeBlock[]) => void;
  onTypes: (next: VenueType[]) => void;
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
    activeCats.length + activeBlocks.length + activeTypes.length;
  // Als de huidige filter-staat exact matcht met een opgeslagen
  // zoekopdracht-chip, dan licht díe chip al op — de filter-knop blijft
  // dan in z'n neutrale staat zodat 'r niet twee actieve knoppen naast
  // elkaar staan.
  const savedActive = saved.some((s) =>
    isSavedSearchActive(s, {
      cats: activeCats,
      tb: activeBlocks,
      vt: activeTypes,
      gn: [],
      q: query,
    })
  );
  const filterActive = filterCount > 0 && !savedActive;
  // Eerste belangrijke filter als label: categorie > venue-type.
  // Render: "Cinema + 2" voor primair + extra; geen primair?
  // terug naar "Filter · N" zoals voorheen.
  const filterLabel = filterActive
    ? (() => {
        let primary: string | null = null;
        if (activeCats.length > 0) {
          primary = translateCategory(activeCats[0], locale);
        } else if (activeTypes.length > 0) {
          primary = translateVenueType(activeTypes[0], locale);
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
      gn: [],
      q: query,
    });
    if (active) {
      onCats([]);
      onBlocks([]);
      onTypes([]);
      onQuery('');
      return;
    }
    // Defensieve fallbacks voor oude persisted shape (pre-migrate
    // schemaversie 1) waar `cats`/`vt` nog niet bestonden.
    onCats(s.cats ?? []);
    onBlocks(s.tb ?? []);
    onTypes(s.vt ?? []);
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
    gn: [],
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
          onPress={() => {
            softTap();
            // Eerste keer dat de filter geopend wordt: dismiss de
            // hint-coachmark zodat-ie niet meer terugkomt.
            useModeStore.getState().dismissFilterHint();
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
          query={query}
          onCats={onCats}
          onBlocks={onBlocks}
          onTypes={onTypes}
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
  query,
  onCats,
  onBlocks,
  onTypes,
  onClose,
}: {
  activeCats: ApiEvent['category'][];
  activeBlocks: TimeBlock[];
  activeTypes: VenueType[];
  query: string;
  onCats: (next: ApiEvent['category'][]) => void;
  onBlocks: (next: TimeBlock[]) => void;
  onTypes: (next: VenueType[]) => void;
  onClose: () => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const t = useT();
  const locale = useLocale();
  const timeBlocks = useTimeBlocks();
  // Android-modal valt full-screen, dus inset-bottom (3-knops menu /
  // gesture-handle) moet de Bekijk/Opslaan/Sluit-rij naar boven duwen
  // zodat de buttons niet onder de systeem-nav vallen. iOS-pageSheet
  // hangt los van de schermrand en heeft genoeg eigen ademruimte —
  // daar blijft de oude 16px-padding behouden, zonder home-indicator-
  // verschuiving.
  const sheetInsets = useSafeAreaInsets();
  const footerPaddingBottom =
    Platform.OS === 'android' ? sheetInsets.bottom + 16 : 16;
  // Filter-chips: alle cats en alle venue-types — geen mode-coupling
  // meer.
  const modeCats = CATEGORIES;
  const typeChips = useMemo(
    () => getVenueTypeChips(locale),
    [locale]
  );
  const addSaved = useAddSavedSearch();
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');

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
  const filterCount =
    activeCats.length + activeTypes.length + activeBlocks.length;

  const onClearAll = () => {
    onCats([]);
    onTypes([]);
    onBlocks([]);
  };

  const onSave = () => {
    const name = saveName.trim();
    if (name.length === 0) return;
    addSaved({
      name,
      cats: activeCats,
      tb: activeBlocks,
      vt: activeTypes,
      gn: [],
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
          {modeCats.map((cat) => (
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

      </ScrollView>

      {saveOpen ? (
        <View
          style={[
            styles.sheetFooter,
            { borderTopColor: roles.bgChip, paddingBottom: footerPaddingBottom },
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
            { borderTopColor: roles.bgChip, paddingBottom: footerPaddingBottom },
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
  days: DaySummary[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const roles = useRoles();
  const scrollRef = useRef<ScrollView>(null);
  const chipLayouts = useRef<Record<string, { x: number; width: number }>>({});
  const viewport = useRef(0);
  // Toon de maand van wat er nu in het midden van de strip te zien
  // is. Updated via onScroll (horizontaal door de strip) en via
  // selectedId (tap of vertical-scroll selectie).
  const initialMonth =
    days.find((d) => d.id === selectedId)?.month ?? days[0]?.month ?? '';
  const [visibleMonth, setVisibleMonth] = useState(initialMonth);

  // Whenever the selection changes (click OR vertical scroll), bring
  // the active chip into view — centred when possible.
  useEffect(() => {
    const layout = chipLayouts.current[selectedId];
    const vp = viewport.current;
    if (!layout || vp === 0 || !scrollRef.current) return;
    const targetX = Math.max(0, layout.x - (vp - layout.width) / 2);
    scrollRef.current.scrollTo({ x: targetX, animated: true });
  }, [selectedId]);

  // Sync visibleMonth wanneer een nieuwe day geselecteerd wordt (tap
  // of vertical-scroll van de lijst) — anders blijft 't oude maand
  // staan totdat de gebruiker zelf horizontaal scrollt.
  useEffect(() => {
    const day = days.find((d) => d.id === selectedId);
    if (day && day.month !== visibleMonth) setVisibleMonth(day.month);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const onHorizontalScroll = (
    e: NativeSyntheticEvent<NativeScrollEvent>
  ) => {
    const scrollX = e.nativeEvent.contentOffset.x;
    const vp = viewport.current;
    if (vp === 0) return;
    const center = scrollX + vp / 2;
    for (const [id, layout] of Object.entries(chipLayouts.current)) {
      if (layout.x <= center && center <= layout.x + layout.width) {
        const day = days.find((d) => d.id === id);
        if (day && day.month !== visibleMonth) {
          setVisibleMonth(day.month);
        }
        return;
      }
    }
  };

  return (
    <View>
      <Text style={[styles.monthLabel, { color: roles.fg }]}>
        {visibleMonth}
      </Text>
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.dayStrip}
        onLayout={(e) => {
          viewport.current = e.nativeEvent.layout.width;
        }}
        onScroll={onHorizontalScroll}
        scrollEventThrottle={64}
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
    </View>
  );
}

function DayChip({
  day,
  active,
  onPress,
  onLayout,
}: {
  day: DaySummary;
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
      style={[
        styles.dayChip,
        // Inactieve chips krijgen een half-transparante bg-tint zodat ze
        // niet in de gradient-blur van de AppHeader verdwijnen — vooral
        // belangrijk nu de strip onder de filter-chips zit. Active chip
        // overschrijft met accent.
        { backgroundColor: `${roles.bg}99` },
        active && { backgroundColor: roles.accent },
      ]}
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

function CategoryHeader({
  category,
  count,
  collapsed,
  onPress,
}: {
  category: ApiEvent['category'];
  count: number;
  collapsed: boolean;
  onPress: () => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const locale = useLocale();
  const tone = TONE[mode][CATEGORY_TICK[category]];
  return (
    <Pressable
      onPress={() => {
        tinyTap();
        onPress();
      }}
      style={styles.catHeader}
    >
      <View style={styles.catHeaderLeft}>
        <Text style={[styles.catHeaderLabel, { color: tone }]}>
          {translateCategory(category, locale)}
        </Text>
        <Ionicons
          name={collapsed ? 'chevron-forward' : 'chevron-down'}
          size={14}
          color={tone}
        />
      </View>
      <Text style={[styles.catHeaderCount, { color: roles.fgPlaceholder }]}>
        {count}
      </Text>
    </Pressable>
  );
}

function DateAnchor({
  dow,
  num,
  month,
  count,
}: {
  dow: string;
  num: string;
  month: string;
  count: number;
}) {
  const roles = useRoles();
  const t = useT();
  return (
    <View style={styles.dateAnchor}>
      <View style={styles.dateAnchorLeft}>
        <Text style={[styles.dateAnchorDow, { color: roles.fg }]}>
          {dow} {num}
        </Text>
        <Text style={[styles.dateAnchorMonth, { color: roles.fgMuted }]}>
          {month}
        </Text>
      </View>
      <Text style={[styles.dateAnchorCount, { color: roles.fgPlaceholder }]}>
        {count}{' '}
        {count === 1 ? t('plan', 'plan') : t('plannen', 'plans')}
      </Text>
    </View>
  );
}

function AgendaRowItem({
  row,
  onTap,
}: {
  row: AgendaRowData;
  onTap: (path: string) => void;
}) {
  const locale = useLocale();
  const friends = row.friendsSaved.map((f) => ({
    name: f.name,
    avatar: f.avatarUrl,
  }));
  const path = `/event/${row.eventId}?source=agenda&o=${row.occurrenceId}`;
  const venueTone = row.venueType
    ? VENUE_TYPE_TICK[row.venueType]
    : undefined;
  return (
    <EventListRow
      time={rowTimeLabel(row.startsAt, row.endsAt, locale)}
      // Display-prioriteit: TMDb poster (films) → event-imageUrl →
      // venue-image als laatste fallback (anders shift de rij naar
      // links bij events zonder image).
      thumb={row.posterUrl ?? row.imageUrl ?? row.venueImageUrl ?? ''}
      thumbSize={96}
      title={row.title}
      venue={row.venueName}
      venueTone={venueTone}
      // Geen category-chip: rijen zitten al onder een category-header
      // (Music / Theatre / etc) — de chip zou alleen ruis zijn. De
      // category-color zit nog wel in de tick-stripe rechts.
      seriesLabel={row.seriesName ?? undefined}
      genreLabel={row.genre ?? undefined}
      friends={friends.length > 0 ? friends : undefined}
      tick={CATEGORY_TICK[row.category]}
      onPress={() => onTap(path)}
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
    paddingVertical: 2,
    alignItems: 'center',
    height: DAYSTRIP_INNER_HEIGHT,
  },
  monthLabel: {
    height: MONTH_LABEL_HEIGHT,
    // Lijnt links uit met de "Andreas" wordmark in AppHeader
    // (paddingHorizontal: 18) — niet met de 22px-gutter van de chips.
    paddingHorizontal: 18,
    // Archivo_900Black voor maximum gewicht — anchor moet duidelijk
    // leesbaar zijn in een snel-scrollende strip.
    fontFamily: fontFamily.display,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    lineHeight: MONTH_LABEL_HEIGHT,
  },
  dayChip: {
    minWidth: 54,
    height: 54,
    paddingHorizontal: 4,
    paddingVertical: 6,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  dayChipDow: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  dayChipNum: {
    fontFamily: fontFamily.display,
    fontSize: 22,
    letterSpacing: -0.44,
    lineHeight: 22,
  },

  // Categorie sub-kop binnen een dag — kleinere display dan de
  // dateAnchor (22px) zodat de dag-divider dominant blijft. Tone-color
  // matcht met de Vandaag-kopjes en de tag-pills op de rows.
  catHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 22,
    paddingTop: 12,
    paddingBottom: 6,
    gap: 10,
  },
  catHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  catHeaderLabel: {
    fontFamily: fontFamily.display,
    fontSize: 18,
    letterSpacing: -0.36,
  },
  catHeaderCount: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
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
