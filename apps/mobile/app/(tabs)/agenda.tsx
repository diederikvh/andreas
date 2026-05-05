import { Ionicons } from '@expo/vector-icons';
import { useScrollToTop } from '@react-navigation/native';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  type LayoutChangeEvent,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { Cross } from '@/components/Cross';
import { EventListRow } from '@/components/EventListRow';
import { SpinningCross } from '@/components/SpinningCross';
import type { ApiEvent } from '@/lib/api';
import {
  CATEGORY_TICK,
  expandToOccurrenceRows,
  formatTime,
  getTimeBlock,
  groupOccurrenceRowsByDay,
  type OccurrenceGroup,
  type OccurrenceRow,
  TIME_BLOCKS,
  type TimeBlock,
} from '@/lib/eventDisplay';
import { useEventGenres, useEvents } from '@/lib/queries';
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
const CHIPROW_HEIGHT = 48;

const CATEGORIES: ApiEvent['category'][] = [
  'Muziek',
  'Theater',
  'Literatuur',
  'Film',
];

export default function Agenda() {
  const roles = useRoles();
  const mode = useMode();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  useScrollToTop(scrollRef);

  const params = useLocalSearchParams<{
    cat?: string;
    q?: string;
    tb?: string;
    gn?: string;
  }>();
  const activeCat =
    params.cat && (CATEGORIES as string[]).includes(params.cat)
      ? (params.cat as ApiEvent['category'])
      : null;
  const query = params.q ?? '';
  const TB_IDS = TIME_BLOCKS.map((b) => b.id) as string[];
  const activeBlocks = useMemo<TimeBlock[]>(
    () =>
      (params.tb ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter((t): t is TimeBlock => TB_IDS.includes(t)),
    [params.tb]
  );
  const activeGenres = useMemo<string[]>(
    () =>
      (params.gn ?? '')
        .split(',')
        .map((g) => g.trim())
        .filter((g) => g.length > 0),
    [params.gn]
  );

  // Vanaf vandaag 00:00 — geen verleden events op de Agenda. Geheugen
  // door de hele render zodat de query-key stabiel blijft binnen één
  // sessie (cross-midnight refresh komt vanzelf bij re-mount).
  const todayStartIso = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }, []);

  const { data: events, isLoading, error } = useEvents({ from: todayStartIso });

  // Cliëntside filter op event-eigenschappen (category/genre/search) —
  // tijd-blok wordt apart per occurrence toegepast zodat een film met
  // matinee (14:00) én avondvoorstelling (22:00) bij beide blokken
  // verschijnt op de juiste tijden.
  const filteredEvents = useMemo(() => {
    if (!events) return [];
    const needle = query.trim().toLowerCase();
    return events.filter((e) => {
      if (activeCat && e.category !== activeCat) return false;
      if (activeGenres.length > 0) {
        const evGenres = e.genres ?? [];
        if (!evGenres.some((g) => activeGenres.includes(g))) return false;
      }
      if (needle.length > 0) {
        const inTitle = e.title.toLowerCase().includes(needle);
        const inVenue = e.venue.name.toLowerCase().includes(needle);
        const inDesc = (e.description ?? '').toLowerCase().includes(needle);
        if (!inTitle && !inVenue && !inDesc) return false;
      }
      return true;
    });
  }, [events, activeCat, activeGenres, query]);

  // Expand naar één rij per occurrence en groepeer per dag. Een
  // 3-daagse festival komt zo op alle 3 dagen voor; een wekelijks feest
  // op elke maandag binnen de gevraagde range.
  const days = useMemo(() => {
    const rows = expandToOccurrenceRows(filteredEvents).filter((row) => {
      if (activeBlocks.length === 0) return true;
      const block = getTimeBlock(new Date(row.occurrence.startsAt).getHours());
      return activeBlocks.includes(block);
    });
    return groupOccurrenceRowsByDay(rows);
  }, [filteredEvents, activeBlocks]);

  const [positions, setPositions] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<string | null>(null);

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

  const selectDay = (id: string) => {
    setSelected(id);
    const y = positions[id];
    if (y !== undefined && scrollRef.current) {
      scrollRef.current.scrollTo({
        y: Math.max(0, y - stickyOffset + 1),
        animated: true,
      });
    }
  };

  const captureSectionY = (id: string) => (e: LayoutChangeEvent) => {
    const y = e.nativeEvent.layout.y;
    setPositions((prev) => (prev[id] === y ? prev : { ...prev, [id]: y }));
  };

  // Sync the active chip with the section currently below the day-strip.
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (days.length === 0) return;
    const scrollY = e.nativeEvent.contentOffset.y;
    const threshold = scrollY + stickyOffset + 30;
    let active = days[0].id;
    for (const day of days) {
      const y = positions[day.id];
      if (y === undefined) continue;
      if (y <= threshold) active = day.id;
    }
    if (active !== selected) setSelected(active);
  };

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <ScrollView
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentContainerStyle={{
          paddingTop: stickyOffset,
          paddingBottom: insets.bottom + 96,
        }}
      >
        {isLoading && (
          <View style={styles.loadingWrap}>
            <SpinningCross size={28} thickness={5} color={roles.fgPlaceholder} />
          </View>
        )}
        {error && (
          <ListState text="Kon agenda niet laden." tone="error" />
        )}
        {!isLoading && !error && (
          <Animated.View entering={FadeIn.duration(220)}>
            {days.length === 0 && (
              <ListState
                text={
                  activeCat ||
                  activeBlocks.length > 0 ||
                  activeGenres.length > 0 ||
                  query
                    ? 'Geen events voor deze filter.'
                    : 'Nog geen events.'
                }
              />
            )}
            {days.map((day) => (
              <View key={day.id} onLayout={captureSectionY(day.id)}>
                <DateAnchor day={day} />
                {day.rows.map((row) => (
                  <AgendaRow key={row.id} row={row} />
                ))}
              </View>
            ))}
          </Animated.View>
        )}
      </ScrollView>
      <AppHeader solid>
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
          activeCat={activeCat}
          query={query}
          activeBlocks={activeBlocks}
          activeGenres={activeGenres}
          onCat={(cat) => router.setParams({ cat: cat ?? undefined })}
          onQuery={(q) => router.setParams({ q: q.length > 0 ? q : undefined })}
          onBlocks={(next) =>
            router.setParams({
              tb: next.length > 0 ? next.join(',') : undefined,
            })
          }
          onGenres={(next) =>
            router.setParams({
              gn: next.length > 0 ? next.join(',') : undefined,
            })
          }
        />
      </AppHeader>
    </View>
  );
}

function ChipRow({
  activeCat,
  query,
  activeBlocks,
  activeGenres,
  onCat,
  onQuery,
  onBlocks,
  onGenres,
}: {
  activeCat: ApiEvent['category'] | null;
  query: string;
  activeBlocks: TimeBlock[];
  activeGenres: string[];
  onCat: (cat: ApiEvent['category'] | null) => void;
  onQuery: (q: string) => void;
  onBlocks: (next: TimeBlock[]) => void;
  onGenres: (next: string[]) => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const [focused, setFocused] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const saved = useSavedSearches();
  const removeSaved = useRemoveSavedSearch();

  // Het zoekveld is "open" zodra het focus heeft of als er tekst staat.
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
    (activeCat ? 1 : 0) + activeBlocks.length + activeGenres.length;
  const filterActive = filterCount > 0;

  const applySaved = (s: SavedSearch) => {
    const active = isSavedSearchActive(s, {
      cat: activeCat,
      tb: activeBlocks,
      gn: activeGenres,
      q: query,
    });
    if (active) {
      onCat(null);
      onBlocks([]);
      onGenres([]);
      onQuery('');
      return;
    }
    onCat(s.cat);
    onBlocks(s.tb);
    onGenres(s.gn);
    onQuery(s.q);
  };

  const onLongPressSaved = (s: SavedSearch) => {
    Alert.alert(
      'Verwijderen',
      `"${s.name}" verwijderen uit je opgeslagen zoekopdrachten?`,
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

  const current = { cat: activeCat, tb: activeBlocks, gn: activeGenres, q: query };

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
          activeCat={activeCat}
          activeBlocks={activeBlocks}
          activeGenres={activeGenres}
          query={query}
          onCat={onCat}
          onBlocks={onBlocks}
          onGenres={onGenres}
          onClose={() => setFilterOpen(false)}
        />
      </Modal>
    </>
  );
}

function FilterSheet({
  activeCat,
  activeBlocks,
  activeGenres,
  query,
  onCat,
  onBlocks,
  onGenres,
  onClose,
}: {
  activeCat: ApiEvent['category'] | null;
  activeBlocks: TimeBlock[];
  activeGenres: string[];
  query: string;
  onCat: (cat: ApiEvent['category'] | null) => void;
  onBlocks: (next: TimeBlock[]) => void;
  onGenres: (next: string[]) => void;
  onClose: () => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const { data: genreData, isLoading, error } = useEventGenres();
  const addSaved = useAddSavedSearch();
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');

  const groupedGenres = useMemo(() => {
    if (!genreData) return [];
    const filtered = activeCat
      ? genreData.filter((b) => b.category === activeCat)
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
  }, [genreData, activeCat]);

  const toggleBlock = (b: TimeBlock) => {
    if (activeBlocks.includes(b)) onBlocks(activeBlocks.filter((x) => x !== b));
    else onBlocks([...activeBlocks, b]);
  };
  const toggleGenre = (g: string) => {
    if (activeGenres.includes(g)) onGenres(activeGenres.filter((x) => x !== g));
    else onGenres([...activeGenres, g]);
  };
  const filterCount =
    (activeCat ? 1 : 0) + activeBlocks.length + activeGenres.length;

  const onClearAll = () => {
    onCat(null);
    onBlocks([]);
    onGenres([]);
  };

  const onSave = () => {
    const name = saveName.trim();
    if (name.length === 0) return;
    addSaved({
      name,
      cat: activeCat,
      tb: activeBlocks,
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
        <Text style={[styles.sheetTitle, { color: roles.fg }]}>Filter</Text>
        <Text style={[styles.sheetLead, { color: roles.fgMuted }]}>
          Combineer categorie, tijd en genre. Sla 'm op om de combinatie als
          chip te bewaren.
        </Text>
      </View>

      <ScrollView
        style={styles.sheetScroll}
        contentContainerStyle={styles.sheetScrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[styles.sheetSectionHead, { color: roles.fgMuted }]}>
          Categorie
        </Text>
        <View style={styles.genreWrap}>
          {CATEGORIES.map((cat) => (
            <FilterChip
              key={cat}
              label={cat}
              active={activeCat === cat}
              onPress={() => onCat(activeCat === cat ? null : cat)}
            />
          ))}
        </View>

        <Text
          style={[
            styles.sheetSectionHead,
            { color: roles.fgMuted, marginTop: 22 },
          ]}
        >
          Tijd
        </Text>
        <View style={styles.genreWrap}>
          {TIME_BLOCKS.map((b) => (
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
          Genre
        </Text>
        {isLoading && (
          <View style={styles.sheetLoading}>
            <SpinningCross size={24} thickness={4} color={roles.fgPlaceholder} />
          </View>
        )}
        {error && (
          <Text style={[styles.sheetEmpty, { color: '#c9453a' }]}>
            Kon genres niet laden.
          </Text>
        )}
        {!isLoading && !error && groupedGenres.length === 0 && (
          <Text style={[styles.sheetEmpty, { color: roles.fgMuted }]}>
            {activeCat
              ? `Geen genres gevonden voor ${activeCat}.`
              : 'Nog geen genres ingevuld.'}
          </Text>
        )}
        <View style={styles.sheetSubSectionGroup}>
        {groupedGenres.map((section) => (
          <View key={section.category}>
            {!activeCat && (
              <Text
                style={[styles.sheetSubSectionHead, { color: roles.fgPlaceholder }]}
              >
                {section.category}
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
          <Pressable
            onPress={() => {
              setSaveOpen(false);
              setSaveName('');
            }}
            style={[
              styles.sheetClearBtn,
              { borderColor: roles.bgChip },
            ]}
          >
            <Text style={[styles.sheetClearText, { color: roles.fgMuted }]}>
              Annuleer
            </Text>
          </Pressable>
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
              placeholder="Naam (bv. Late techno)"
              placeholderTextColor={roles.fgPlaceholder}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={onSave}
              style={[styles.saveInput, { color: roles.fg }]}
              maxLength={28}
            />
          </View>
          <Pressable
            onPress={onSave}
            disabled={saveName.trim().length === 0}
            style={[
              styles.sheetDoneBtn,
              {
                backgroundColor: isNacht ? palette.acid : palette.red,
                opacity: saveName.trim().length === 0 ? 0.4 : 1,
                flex: 0.9,
              },
            ]}
          >
            <Text
              style={[
                styles.sheetDoneText,
                { color: isNacht ? palette.noir : palette.paper3 },
              ]}
            >
              Opslaan
            </Text>
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
            onPress={() => setSaveOpen(true)}
            disabled={filterCount === 0}
            style={[
              styles.sheetClearBtn,
              {
                borderColor: roles.bgChip,
                opacity: filterCount === 0 ? 0.4 : 1,
                flexDirection: 'row',
                gap: 6,
              },
            ]}
          >
            <Ionicons
              name="bookmark-outline"
              size={14}
              color={roles.fgMuted}
            />
            <Text style={[styles.sheetClearText, { color: roles.fgMuted }]}>
              Bewaar
            </Text>
          </Pressable>
          <Pressable
            onPress={onClearAll}
            disabled={filterCount === 0}
            style={[
              styles.sheetClearBtn,
              {
                borderColor: roles.bgChip,
                opacity: filterCount === 0 ? 0.4 : 1,
              },
            ]}
          >
            <Text style={[styles.sheetClearText, { color: roles.fgMuted }]}>
              Wis filters
            </Text>
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
        {day.count} {day.count === 1 ? 'plan' : 'plannen'}
      </Text>
    </View>
  );
}

function AgendaRow({ row }: { row: OccurrenceRow }) {
  const { event, occurrence } = row;
  const friends = event.friendsSaved?.map((f) => ({
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
  return (
    <EventListRow
      time={formatTime(occurrence.startsAt)}
      duration={event.category.toLowerCase()}
      thumb={event.imageUrl ?? ''}
      title={event.title}
      venue={event.venue.name}
      tags={[{ label: event.category, tone: CATEGORY_TICK[event.category] }]}
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
    gap: 6,
    height: 32,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    overflow: 'hidden',
  },
  searchIcon: { width: 16, height: 16, alignItems: 'center', justifyContent: 'center' },
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
    minHeight: 38,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
  },
  filterChipText: {
    fontFamily: fontFamily.medium,
    fontSize: 13,
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
    gap: 6,
    height: 34,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
  },
  genreChipText: {
    fontFamily: fontFamily.medium,
    fontSize: 13,
    letterSpacing: -0.13,
    textTransform: 'lowercase',
  },
  genreChipCount: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
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
