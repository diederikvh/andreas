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
  useWindowDimensions,
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
import { FILTER_CHIP_HEIGHT } from '@/components/FilterChip';
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
import { useTabDoubleTap } from '@/lib/useTabDoubleTap';
import {
  defaultRange,
  isoDay,
  useAgendaFilters,
  type DateRange,
} from '@/store/agendaFilters';
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
  | { type: 'day'; id: string; date: string; count: number }
  | { type: 'row'; id: string; row: AgendaRowData };

/** Welke logische dag hoort bij dit tijdstip? Vóór 06:00 telt als de
    avond ervoor — een clubnacht die om 02:00 nog draait staat onder
    zaterdag, niet onder zondag. Spiegelt het 06:00-window op de
    server. */
function logicalDayOf(iso: string): string {
  const d = new Date(iso);
  if (d.getHours() < 6) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

  // Filter-state blijft staan voor de duur van de app-session — geen
  // reset op tab-blur. Accent-styling op chip-row maakt zichtbaar wat
  // actief is; cold launch reset vanzelf omdat de Zustand store niet
  // gepersist is naar AsyncStorage.
  const onRowTap = useCallback((path: string) => {
    router.push(path as never);
  }, []);

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
  const range = useAgendaFilters((s) => s.range);
  const setRange = useAgendaFilters((s) => s.setRange);
  const [rangeOpen, setRangeOpen] = useState(false);

  // Als je de app een dag laat openstaan schuift 'vandaag' door onder
  // een bereik dat nog op gisteren begint. Bij focus corrigeren we dat,
  // maar alleen als je 't bereik niet zelf hebt opgerekt naar het
  // verleden — dan is 't een bewuste keuze.
  useEffect(() => {
    const today = logicalTodayDate(new Date(focusedNow));
    if (range.from < today && range.to >= today) {
      setRange({ from: today, to: range.to });
    }
  }, [focusedNow, range.from, range.to, setRange]);

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

  // Eén reeks in plaats van dag-voor-dag. De day-strip liet je telkens
  // één dag zien; om te weten wat er deze week speelde moest je zeven
  // keer tikken en kon je nooit doorscrollen. Nu haalt 'ie het hele
  // bereik op en groeperen we clientside per logische dag.
  //
  // `from` = huidige tijd (niet middernacht) zodat een middagshow die
  // al voorbij is uit vandaag valt. Voor de dagen erna passeert 'ie
  // onschadelijk via GREATEST in SQL.
  const {
    data: rows = [],
    isLoading: rowsLoading,
    error: rowsError,
  } = useAgendaDay({
    date: range.from,
    toDate: range.to,
    from: new Date(focusedNow).toISOString(),
    filters: apiFilters,
  });

  // -8 om de chip-rij 8px omhoog te trekken, dichter tegen de
  // "Andreas" wordmark aan. De day-strip die hier ook in zat is weg.
  const stickyOffset = insets.top + HEADER_HEIGHT + CHIPROW_HEIGHT - 8;

  // Pull-to-refresh: invalideert beide agenda-caches zodat én de day-
  // strip én de huidige dag opnieuw fetchen.
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    const start = Date.now();
    try {
      await qc.invalidateQueries({ queryKey: ['agenda-day'] });
    } finally {
      const elapsed = Date.now() - start;
      if (elapsed < 700) {
        await new Promise((r) => setTimeout(r, 700 - elapsed));
      }
      setRefreshing(false);
    }
  }, [qc]);

  // Alles terug naar af: categorieën, types, tijdblokken, zoekterm,
  // toggles én de periode. Een "wis filters" die de datums laat staan
  // levert een nog steeds lege lijst op — dan lijkt de knop stuk.
  const clearAll = useCallback(() => {
    useAgendaFilters.getState().reset();
  }, []);

  const hasActiveFilter =
    activeCats.length > 0 ||
    activeTypes.length > 0 ||
    activeBlocks.length > 0 ||
    query.length > 0 ||
    onlyFriends ||
    onlyFavorites;

  // Items voor de FlatList: dag-kop + rijen op tijd. De grondslag is nu
  // de dág, niet de categorie — met een reeks van zeven dagen zou je
  // anders twee lagen koppen boven elkaar krijgen (dag > categorie) en
  // dan scrolt niks meer lekker. Categorie zit al als tag op de rij en
  // als filter in de chip-rij.
  const items: AgendaItem[] = useMemo(() => {
    const out: AgendaItem[] = [];
    let currentDay: string | null = null;
    for (const row of rows) {
      const day = logicalDayOf(row.startsAt);
      if (day !== currentDay) {
        currentDay = day;
        out.push({
          type: 'day',
          id: `day::${day}`,
          date: day,
          count: rows.filter((r) => logicalDayOf(r.startsAt) === day).length,
        });
      }
      out.push({ type: 'row', id: row.id, row });
    }
    return out;
  }, [rows]);

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <RefreshBanner visible={refreshing} topOffset={stickyOffset + 8} />
      <FlatList
        ref={listRef}
        data={items}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) =>
          item.type === 'day' ? (
            <DayHeader date={item.date} count={item.count} />
          ) : (
            <AgendaRowItem row={item.row} onTap={onRowTap} />
          )
        }
        ListHeaderComponent={
          <Animated.View entering={FadeIn.duration(220)}>
            {rowsLoading && (
              <View style={styles.loadingWrap}>
                <SpinningCross size={28} color={roles.fgPlaceholder} />
              </View>
            )}
            {rowsError && (
              <ListState
                text={t('Kon agenda niet laden.', 'Couldn’t load agenda.')}
                tone="error"
              />
            )}
            {!rowsLoading && !rowsError && rows.length === 0 && (
              <EmptyState
                hasFilter={hasActiveFilter}
                onClear={clearAll}
                topInset={stickyOffset}
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
      <AppHeader title={t('Agenda', 'Agenda')}>
        <ChipRow
          range={range}
          onOpenRange={() => setRangeOpen(true)}
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
      </AppHeader>
      <FilterHint />
      <DateRangeSheet
        visible={rangeOpen}
        range={range}
        onClose={() => setRangeOpen(false)}
        onApply={(next) => {
          setRange(next);
          setRangeOpen(false);
        }}
      />
    </View>
  );
}

/** Dag-kop in de lijst. Vervangt de losse day-strip: je scrolt nu
    gewoon door de dagen heen in plaats van er per stuk op te tikken. */
function DayHeader({ date, count }: { date: string; count: number }) {
  const roles = useRoles();
  const locale = useLocale();
  const t = useT();
  const d = new Date(`${date}T12:00:00`);
  const today = logicalTodayDate(new Date());
  const isToday = date === today;
  const label = isToday
    ? t('Vandaag', 'Today')
    : `${dowMixed(d.getDay(), locale)} ${d.getDate()} ${monthShort(d.getMonth(), locale).toLowerCase()}`;
  return (
    <View style={[styles.dayHeader, { backgroundColor: roles.bg }]}>
      <Text style={[styles.dayHeaderText, { color: roles.fg }]}>{label}</Text>
      <Text style={[styles.dayHeaderCount, { color: roles.fgMuted }]}>
        {count}
      </Text>
    </View>
  );
}

function formatRange(range: DateRange, locale: Locale, t: ReturnType<typeof useT>): string {
  const a = new Date(`${range.from}T12:00:00`);
  const b = new Date(`${range.to}T12:00:00`);
  const day = (d: Date) =>
    `${d.getDate()} ${monthShort(d.getMonth(), locale).toLowerCase()}`;
  if (range.from === range.to) {
    return range.from === logicalTodayDate(new Date())
      ? t('Vandaag', 'Today')
      : day(a);
  }
  return `${day(a)} – ${day(b)}`;
}

/**
 * Van–tot kiezen. Zelfde drawer-vorm als de filter-sheet: pageSheet,
 * kop met titel en uitleg, scroll-body, vaste voet met de bevestig-knop.
 * Twee laden die anders aanvoelen terwijl ze hetzelfde doen (de lijst
 * verkleinen) is precies het soort inconsistentie dat een app rommelig
 * maakt.
 *
 * Bewust geen native date-picker: die zit niet in de deps en zou een
 * nieuwe native module betekenen — dan kan een wijziging aan een
 * datumveld niet meer over-the-air.
 *
 * Bediening: eerste tik zet de startdatum, tweede de einddatum. Tik je
 * een dag vóór de start, dan begint 'ie opnieuw vanaf daar — anders zit
 * je vast zodra je je vergist.
 */
function DateRangeSheet({
  visible,
  range,
  onClose,
  onApply,
}: {
  visible: boolean;
  range: DateRange;
  onClose: () => void;
  onApply: (next: DateRange) => void;
}) {
  const roles = useRoles();
  const mode = useMode();
  const isNacht = mode === 'nacht';
  const locale = useLocale();
  const t = useT();
  const sheetInsets = useSafeAreaInsets();
  const footerPaddingBottom =
    Platform.OS === 'android' ? sheetInsets.bottom + 16 : 16;
  const [draft, setDraft] = useState<DateRange>(range);
  const [anchor, setAnchor] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setDraft(range);
      setAnchor(null);
    }
  }, [visible, range]);

  const today = logicalTodayDate(new Date());
  const presets: Array<{ label: string; range: DateRange }> = [
    { label: t('Vandaag', 'Today'), range: { from: today, to: today } },
    {
      label: t('Komend weekend', 'This weekend'),
      range: weekendRange(new Date()),
    },
    { label: t('7 dagen', '7 days'), range: defaultRange() },
    { label: t('30 dagen', '30 days'), range: spanFrom(today, 29) },
  ];

  // Drie maanden vooruit is genoeg om een weekend of een festival te
  // prikken zonder een oneindige scroll te bouwen.
  const months = [monthOf(today, 0), monthOf(today, 1), monthOf(today, 2)];

  const pick = (day: string) => {
    softTap();
    if (anchor === null || day < anchor) {
      setAnchor(day);
      setDraft({ from: day, to: day });
      return;
    }
    setDraft({ from: anchor, to: day });
    setAnchor(null);
  };

  const dayCount =
    Math.round(
      (Date.parse(`${draft.to}T12:00:00`) -
        Date.parse(`${draft.from}T12:00:00`)) /
        86400000
    ) + 1;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
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
        <View style={styles.sheetHead}>
          <Text style={[styles.sheetTitle, { color: roles.fg }]}>
            {t('Periode', 'Range')}
          </Text>
          <Text style={[styles.sheetLead, { color: roles.fgMuted }]}>
            {t(
              'Kies een vaste periode, of tik een begin- en einddatum aan.',
              'Pick a preset range, or tap a start and end date.'
            )}
          </Text>
        </View>

        <ScrollView
          style={styles.sheetScroll}
          contentContainerStyle={styles.sheetScrollContent}
          showsVerticalScrollIndicator={false}
        >
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            // Breekt uit de 22px body-padding zodat de chips van rand
            // tot rand kunnen scrollen in plaats van af te kappen.
            style={styles.presetScroll}
            contentContainerStyle={styles.presetRow}
          >
            {presets.map((p) => {
              const on = p.range.from === draft.from && p.range.to === draft.to;
              return (
                <Pressable
                  key={p.label}
                  onPress={() => {
                    softTap();
                    setDraft(p.range);
                    setAnchor(null);
                  }}
                  style={[
                    styles.catChip,
                    {
                      borderColor: on
                        ? roles.accent
                        : isNacht
                          ? '#2a2a2d'
                          : palette.paper,
                      backgroundColor: on
                        ? `${isNacht ? palette.acid : palette.red}1f`
                        : isNacht
                          ? palette.noir2
                          : palette.paper2,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.catChipText,
                      { color: on ? roles.accent : roles.fgMuted },
                    ]}
                  >
                    {p.label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>

          <View style={[styles.presetDivider, { backgroundColor: roles.bgChip }]} />

          {months.map((m) => (
            <MonthGrid
              key={m.key}
              month={m}
              draft={draft}
              minDay={today}
              onPick={pick}
            />
          ))}
        </ScrollView>

        <View
          style={[
            styles.sheetFooter,
            { borderTopColor: roles.bgChip, paddingBottom: footerPaddingBottom },
          ]}
        >
          <Pressable
            onPress={() => onApply(draft)}
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
              {formatRange(draft, locale, t)}
              {dayCount > 1 ? ` · ${dayCount} ${t('dagen', 'days')}` : ''}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

type MonthInfo = { key: string; year: number; month: number; label: string };

function monthOf(from: string, offset: number): MonthInfo {
  const d = new Date(`${from}T12:00:00`);
  d.setDate(1);
  d.setMonth(d.getMonth() + offset);
  return {
    key: `${d.getFullYear()}-${d.getMonth()}`,
    year: d.getFullYear(),
    month: d.getMonth(),
    label: `${d.toLocaleDateString('nl-NL', { month: 'long' })} ${d.getFullYear()}`,
  };
}

function spanFrom(from: string, plusDays: number): DateRange {
  const d = new Date(`${from}T12:00:00`);
  d.setDate(d.getDate() + plusDays);
  return { from, to: isoDay(d) };
}

/**
 * Het weekend waar je in zit, of het eerstvolgende. Vrijdag en zaterdag
 * lopen door tot en met zondag; op zondag is 't weekend nog maar één
 * dag. Doordeweeks pak je de komende vrijdag t/m zondag.
 */
function weekendRange(now: Date): DateRange {
  const d = new Date(now);
  if (d.getHours() < 6) d.setDate(d.getDate() - 1);
  const dow = d.getDay(); // 0 = zondag
  if (dow === 0) return { from: isoDay(d), to: isoDay(d) };
  if (dow === 5 || dow === 6) {
    const sun = new Date(d);
    sun.setDate(sun.getDate() + (7 - dow));
    return { from: isoDay(d), to: isoDay(sun) };
  }
  const fri = new Date(d);
  fri.setDate(fri.getDate() + (5 - dow));
  const sun = new Date(fri);
  sun.setDate(sun.getDate() + 2);
  return { from: isoDay(fri), to: isoDay(sun) };
}

function MonthGrid({
  month,
  draft,
  minDay,
  onPick,
}: {
  month: MonthInfo;
  draft: DateRange;
  minDay: string;
  onPick: (day: string) => void;
}) {
  const roles = useRoles();
  const first = new Date(month.year, month.month, 1);
  const daysInMonth = new Date(month.year, month.month + 1, 0).getDate();
  // Maandag-eerst raster: JS geeft zondag=0, dus omrekenen.
  const lead = (first.getDay() + 6) % 7;
  const cells: Array<string | null> = [
    ...Array<null>(lead).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) =>
      isoDay(new Date(month.year, month.month, i + 1))
    ),
  ];
  return (
    <View style={styles.month}>
      <Text style={[styles.monthLabel, { color: roles.fg }]}>{month.label}</Text>
      <View style={styles.monthGrid}>
        {cells.map((day, i) => {
          if (!day) return <View key={`pad-${i}`} style={styles.cell} />;
          const disabled = day < minDay;
          const inRange = day >= draft.from && day <= draft.to;
          const isEdge = day === draft.from || day === draft.to;
          // De gekleurde vorm zit ín de cel, niet óp de cel. Anders
          // vullen aangrenzende dagen de volle celbreedte en plakken de
          // bollen aan elkaar tot één band.
          return (
            <Pressable
              key={day}
              disabled={disabled}
              onPress={() => onPick(day)}
              style={styles.cell}
            >
              <View
                style={[
                  styles.cellDot,
                  inRange && {
                    backgroundColor: isEdge
                      ? roles.accent
                      : `${roles.accent}26`,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.cellText,
                    {
                      color: disabled
                        ? roles.fgPlaceholder
                        : isEdge
                          ? roles.bg
                          : roles.fg,
                    },
                  ]}
                >
                  {Number(day.slice(-2))}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function ChipRow({
  range,
  onOpenRange,
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
  range: DateRange;
  onOpenRange: () => void;
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
  const [filterOpen, setFilterOpen] = useState(false);
  const saved = useSavedSearches();
  const removeSaved = useRemoveSavedSearch();
  // Text-search staat sinds de globale SearchOverlay op /avond niet
  // meer in de chip-rij hier — zoeken op woord doe je daar. De
  // filter-state houdt nog wel een `q`-veld voor backwards compat met
  // oude saved-searches.

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
        {/* Datum en filter zijn allebei "verklein de lijst" — dus dezelfde
            rij en dezelfde chip-vorm. De datum staat vooraan omdat 'ie
            altijd een waarde heeft; het filter is optioneel. */}
        <Pressable
          onPress={() => {
            softTap();
            onOpenRange();
          }}
          style={[
            styles.catChip,
            {
              borderColor: roles.accent,
              backgroundColor: `${isNacht ? palette.acid : palette.red}1f`,
              flexDirection: 'row',
              gap: 6,
            },
          ]}
        >
          <Ionicons name="calendar-outline" size={16} color={roles.accent} />
          <Text style={[styles.catChipText, { color: roles.accent }]}>
            {formatRange(range, locale, t)}
          </Text>
        </Pressable>
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
                ? roles.accent
                : isNacht
                  ? '#2a2a2d'
                  : palette.paper,
              backgroundColor: filterActive
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
            name="options-outline"
            size={16}
            color={filterActive ? roles.accent : roles.fgMuted}
          />
          <Text
            style={[
              styles.catChipText,
              { color: filterActive ? roles.accent : roles.fgMuted },
            ]}
          >
            {filterLabel}
          </Text>
        </Pressable>
        {showFavoritesChip && (
          <Pressable
            accessibilityLabel={
              onlyFavorites
                ? t('Toon alle events', 'Show all events')
                : t(
                    'Alleen events bij venues die ik volg',
                    'Only events at venues I follow'
                  )
            }
            onPress={onToggleFavorites}
            style={[
              styles.catChip,
              {
                borderColor: onlyFavorites
                  ? roles.accent
                  : isNacht
                    ? '#2a2a2d'
                    : palette.paper,
                backgroundColor: onlyFavorites
                  ? `${isNacht ? palette.acid : palette.red}1f`
                  : isNacht
                    ? palette.noir2
                    : palette.paper2,
                flexDirection: 'row',
                gap: 6,
              },
            ]}
          >
            <Ionicons
              name={onlyFavorites ? 'bookmark' : 'bookmark-outline'}
              size={15}
              color={onlyFavorites ? roles.accent : roles.fgMuted}
            />
            <Text
              style={[
                styles.catChipText,
                { color: onlyFavorites ? roles.accent : roles.fgMuted },
              ]}
            >
              {t('Mijn venues', 'My venues')}
            </Text>
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
              styles.sheetSaveBtn,
              {
                borderColor: roles.bgChip,
                opacity: filterCount === 0 ? 0.4 : 1,
              },
            ]}
          >
            <Text style={[styles.sheetSaveText, { color: roles.accent }]}>
              {t('Opslaan', 'Save')}
            </Text>
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

/**
 * Lege lijst. Stond eerder als regeltje tekst linksboven, waar 't
 * wegviel tegen een leeg scherm en je niet zag wat je eraan kon doen.
 * Nu gecentreerd met een icoon en een uitweg.
 */
function EmptyState({
  hasFilter,
  onClear,
  topInset,
}: {
  hasFilter: boolean;
  onClear: () => void;
  topInset: number;
}) {
  const roles = useRoles();
  const t = useT();
  const { height } = useWindowDimensions();
  return (
    <View
      style={[
        styles.emptyState,
        // Vult de ruimte onder de sticky header zodat 'ie optisch
        // midden in het lege scherm staat, niet vlak onder de chips.
        { minHeight: height - topInset - 220 },
      ]}
    >
      <Ionicons name="calendar-outline" size={44} color={roles.fgPlaceholder} />
      <Text style={[styles.emptyStateTitle, { color: roles.fg }]}>
        {t('Niks in deze periode', 'Nothing in this range')}
      </Text>
      <Text style={[styles.emptyStateBody, { color: roles.fgMuted }]}>
        {hasFilter
          ? t(
              'Je filter is misschien te smal. Wis \'m, of rek de datums op.',
              'Your filter may be too narrow. Clear it, or widen the dates.'
            )
          : t(
              'Rek de datums op om verder vooruit te kijken.',
              'Widen the dates to look further ahead.'
            )}
      </Text>
      {hasFilter && (
        <Pressable
          onPress={() => {
            softTap();
            onClear();
          }}
          style={[styles.emptyStateBtn, { backgroundColor: roles.accent }]}
        >
          <Text style={[styles.emptyStateBtnText, { color: roles.onAccent }]}>
            {t('Wis filters', 'Clear filters')}
          </Text>
        </Pressable>
      )}
    </View>
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

  // Dag-kop in de lijst
  dayHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: 22,
    paddingTop: 18,
    paddingBottom: 8,
  },
  dayHeaderText: {
    fontFamily: fontFamily.displayBold,
    fontSize: 20,
    letterSpacing: -0.4,
  },
  dayHeaderCount: { fontFamily: fontFamily.mono, fontSize: 12 },

  // Datum-kiezer
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingTop: 16,
    maxHeight: '86%',
  },
  rangeHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 22,
    paddingBottom: 12,
  },
  rangeTitle: {
    fontFamily: fontFamily.displayBold,
    fontSize: 20,
    letterSpacing: -0.4,
  },
  presetScroll: { marginHorizontal: -22 },
  presetRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 22,
  },
  presetDivider: {
    height: StyleSheet.hairlineWidth,
    marginTop: 18,
    marginBottom: 20,
    marginHorizontal: -22,
  },
  preset: {
    height: 34,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  presetText: { fontFamily: fontFamily.medium, fontSize: 13 },
  calScroll: { paddingHorizontal: 16 },
  month: { paddingBottom: 22 },
  monthGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    // Zonder dit strekken de rijen mee met de container en krijg je een
    // gat onder een maand die op een halve rij eindigt.
    alignItems: 'flex-start',
    alignContent: 'flex-start',
  },
  // Cel = tikvlak (volle 1/7 breedte), bol = de gekleurde vorm erin.
  // Vaste 38×38 zodat 't een rondje is en geen pil, met lucht ertussen.
  cell: {
    width: `${100 / 7}%`,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellDot: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellText: { fontFamily: fontFamily.medium, fontSize: 14 },
  applyBtn: {
    marginHorizontal: 22,
    marginTop: 8,
    height: 50,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  applyText: { fontFamily: fontFamily.displayBold, fontSize: 15 },

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
    height: FILTER_CHIP_HEIGHT,
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
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
    gap: 10,
  },
  emptyStateTitle: {
    fontFamily: fontFamily.displayBold,
    fontSize: 20,
    letterSpacing: -0.4,
    textAlign: 'center',
    marginTop: 4,
  },
  emptyStateBody: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  emptyStateBtn: {
    marginTop: 8,
    height: 44,
    paddingHorizontal: 22,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyStateBtnText: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.06,
  },
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
  // Save-knop in de filter-sheet — pill met tekst-label "Opslaan"
  // i.p.v. een icoon. Iconografie is gereserveerd voor andere acties
  // (bookmark = venue volgen, hartje = event saven).
  sheetSaveBtn: {
    height: 48,
    paddingHorizontal: 18,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetSaveText: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.14,
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
