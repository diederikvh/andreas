import { useScrollToTop } from '@react-navigation/native';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { EventListRow } from '@/components/EventListRow';
import type { AgendaDay, AgendaItem } from '@/mocks/agenda';
import { AGENDA } from '@/mocks/agenda';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily } from '@/theme/tokens';

const DAYSTRIP_HEIGHT = 76;

export default function Agenda() {
  const mode = useMode();
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const days = AGENDA[mode];
  const scrollRef = useRef<ScrollView>(null);
  useScrollToTop(scrollRef);
  const [positions, setPositions] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<string>(days[0].id);

  const stickyOffset = insets.top + HEADER_HEIGHT + DAYSTRIP_HEIGHT;

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
    const scrollY = e.nativeEvent.contentOffset.y;
    // Section X is "current" once its top has scrolled past the
    // day-strip's bottom edge. 30px tolerance so the chip flips a beat
    // before the anchor reaches the strip.
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
        {days.map((day) => (
          <View key={day.id} onLayout={captureSectionY(day.id)}>
            <DateAnchor day={day} />
            {day.items.map((item) => (
              <AgendaRow key={item.id} item={item} />
            ))}
          </View>
        ))}
      </ScrollView>
      <AppHeader>
        <DayStrip
          days={days}
          selectedId={selected}
          onSelect={selectDay}
        />
      </AppHeader>
    </View>
  );
}

function DayStrip({
  days,
  selectedId,
  onSelect,
}: {
  days: AgendaDay[];
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
  day: AgendaDay;
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

function DateAnchor({ day }: { day: AgendaDay }) {
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

function AgendaRow({ item }: { item: AgendaItem }) {
  return (
    <EventListRow
      time={item.time}
      duration={item.duration}
      thumb={item.thumb}
      title={item.title}
      venue={item.venue}
      tags={[{ label: item.badge, tone: item.badgeTone }]}
      status={item.status}
      friends={item.friends}
      tick={item.tick}
      onPress={() => router.push(`/event/${item.id}`)}
    />
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

});
