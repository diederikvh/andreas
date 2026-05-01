import { Ionicons } from '@expo/vector-icons';
import { useScrollToTop } from '@react-navigation/native';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { EventListRow } from '@/components/EventListRow';
import type { ApiEvent } from '@/lib/api';
import {
  CATEGORY_TICK,
  type EventGroup,
  formatTime,
  groupEventsByDay,
} from '@/lib/eventDisplay';
import { useEvents } from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
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
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  useScrollToTop(scrollRef);

  const params = useLocalSearchParams<{ cat?: string; q?: string }>();
  const activeCat =
    params.cat && (CATEGORIES as string[]).includes(params.cat)
      ? (params.cat as ApiEvent['category'])
      : null;
  const query = params.q ?? '';

  const { data: events, isLoading, error } = useEvents();

  // Cliëntside filter — events-lijst is klein, geen API-call nodig.
  const filteredEvents = useMemo(() => {
    if (!events) return [];
    const needle = query.trim().toLowerCase();
    return events.filter((e) => {
      if (activeCat && e.category !== activeCat) return false;
      if (needle.length > 0) {
        const inTitle = e.title.toLowerCase().includes(needle);
        const inVenue = e.venue.name.toLowerCase().includes(needle);
        const inDesc = (e.description ?? '').toLowerCase().includes(needle);
        if (!inTitle && !inVenue && !inDesc) return false;
      }
      return true;
    });
  }, [events, activeCat, query]);

  const days = useMemo(
    () => groupEventsByDay(filteredEvents),
    [filteredEvents]
  );

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
        {isLoading && <ListState text="Laden…" />}
        {error && (
          <ListState text="Kon agenda niet laden." tone="error" />
        )}
        {!isLoading && !error && days.length === 0 && (
          <ListState
            text={
              activeCat || query
                ? 'Geen events voor deze filter.'
                : 'Nog geen events.'
            }
          />
        )}
        {days.map((day) => (
          <View key={day.id} onLayout={captureSectionY(day.id)}>
            <DateAnchor day={day} />
            {day.events.map((event) => (
              <AgendaRow key={event.id} event={event} />
            ))}
          </View>
        ))}
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
          onCat={(cat) => router.setParams({ cat: cat ?? undefined })}
          onQuery={(q) => router.setParams({ q: q.length > 0 ? q : undefined })}
        />
      </AppHeader>
    </View>
  );
}

function ChipRow({
  activeCat,
  query,
  onCat,
  onQuery,
}: {
  activeCat: ApiEvent['category'] | null;
  query: string;
  onCat: (cat: ApiEvent['category'] | null) => void;
  onQuery: (q: string) => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<TextInput>(null);
  // Het zoekveld is "open" zodra het focus heeft of als er tekst staat.
  // Idle = alleen de magnifier; open = ruim genoeg om te typen, en
  // groeit mee met de inhoud zodat lange queries niet afgekapt worden.
  const open = focused || query.length > 0;
  const COLLAPSED_W = 36;
  const MIN_OPEN_W = 110;
  const MAX_OPEN_W = 240;
  const textWidthEstimate = 36 + query.length * 7 + 16; // mono ~7px/char
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

  return (
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
      <CatChip label="Alles" active={activeCat === null} onPress={() => onCat(null)} />
      {CATEGORIES.map((cat) => (
        <CatChip
          key={cat}
          label={cat}
          active={activeCat === cat}
          onPress={() => onCat(cat)}
        />
      ))}
    </ScrollView>
  );
}

function CatChip({
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
        styles.catChip,
        {
          borderColor: active
            ? roles.fg
            : isNacht
              ? '#2a2a2d'
              : palette.paper,
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
          styles.catChipText,
          { color: active ? roles.bg : roles.fgMuted },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function DayStrip({
  days,
  selectedId,
  onSelect,
}: {
  days: EventGroup[];
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
  day: EventGroup;
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

function DateAnchor({ day }: { day: EventGroup }) {
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

function AgendaRow({ event }: { event: ApiEvent }) {
  const friends = event.friendsSaved?.map((f) => ({
    name: f.name,
    avatar: f.avatarUrl,
  }));
  return (
    <EventListRow
      time={formatTime(event.startsAt)}
      duration={event.category.toLowerCase()}
      thumb={event.imageUrl ?? ''}
      title={event.title}
      venue={event.venue.name}
      tags={[{ label: event.category, tone: CATEGORY_TICK[event.category] }]}
      friends={friends && friends.length > 0 ? friends : undefined}
      tick={CATEGORY_TICK[event.category]}
      onPress={() => router.push(`/event/${event.id}`)}
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
  listStateText: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.8,
  },
});
